/*
 * Audiobookshelf source plugin for Flow Reader (plugin apiVersion 6).
 *
 * EPUB ebooks only. Sign in with username/password; the host stores accessToken (bearer) and
 * refreshToken. Progress patches ebookLocation + ebookProgress + lastUpdate only.
 *
 * Work ids are library item ids. Chapter URLs are spine:{zipPath} from the downloaded EPUB.
 */

const ACCESS = 'accessToken';
const REFRESH = 'refreshToken';
const USERNAME = 'username';
/** flow.storage JSON map of libraryId → boolean; missing key means enabled. */
const ENABLED_LIBS = 'enabledLibraries';
const PAGE = 50;

function err(code, message) {
  return flow.error(code, message);
}

function base() {
  const raw = String((flow.settings && flow.settings.server) || '').trim();
  if (!raw) throw err('ERROR', 'Set the Server address in plugin settings first');
  let url = raw;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  // QuickJS / test host have no URL global; parse with a regex (same shape as other plugins).
  if (/^https?:\/\/[^/@]+@/i.test(url)) {
    throw err('ERROR', 'Put credentials in Sign in, not in the server address');
  }
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!m) throw err('ERROR', 'Invalid server address');
  const path = (m[3] || '').replace(/\/+$/, '');
  return m[1].toLowerCase() + '://' + m[2] + path;
}

function api(path) {
  return base() + path;
}

async function fetchJson(path, opts) {
  const o = Object.assign({}, opts || {});
  if (o.body != null && !o.contentType) {
    const headers = o.headers || {};
    const ct = Object.keys(headers).find(function (k) { return k.toLowerCase() === 'content-type'; });
    o.contentType = ct ? headers[ct] : (typeof o.body === 'string' && o.body.charAt(0) === '{'
      ? 'application/json; charset=utf-8'
      : undefined);
  }
  const r = await flow.fetch(api(path), o);
  let body = null;
  try {
    body = r.text ? JSON.parse(r.text) : null;
  } catch (_) {
    body = null;
  }
  return { status: r.status, url: r.url, body: body, text: r.text || '', path: r.path || '' };
}

async function withAuth(path, opts) {
  const o = Object.assign({}, opts || {});
  let r = await fetchJson(path, o);
  if (r.status === 401) {
    const ok = await refresh();
    if (!ok) throw err('AUTH_REQUIRED', 'Sign in again');
    r = await fetchJson(path, o);
  }
  return r;
}

async function refresh() {
  const token = await flow.secrets.get(REFRESH);
  if (!token) return false;
  const r = await fetchJson('/auth/refresh', {
    method: 'POST',
    auth: false,
    headers: { 'x-refresh-token': token, 'Content-Type': 'application/json' },
    contentType: 'application/json; charset=utf-8',
    body: '{}',
  });
  if (r.status < 200 || r.status >= 300 || !r.body || !r.body.user) return false;
  const user = r.body.user;
  const access = user.accessToken || user.token;
  if (!access) return false;
  await flow.secrets.set(ACCESS, access);
  if (user.refreshToken) await flow.secrets.set(REFRESH, user.refreshToken);
  return true;
}

function hasEpub(item) {
  const media = item && item.media;
  if (!media) return false;
  if (media.ebookFile && media.ebookFile.ebookFormat) {
    return String(media.ebookFile.ebookFormat).toLowerCase() === 'epub';
  }
  const files = (item.libraryFiles || []).concat(media.tracks || []);
  // ebookFile is the normal shape; some payloads nest under mediaMetadata.
  const fmt = media.ebookFormat || (media.metadata && media.metadata.ebookFormat);
  if (fmt) return String(fmt).toLowerCase() === 'epub';
  return !!(media.ebookFile && /\.epub$/i.test(media.ebookFile.metadata && media.ebookFile.metadata.filename || media.ebookFile.ino || ''));
}

function itemTitle(item) {
  const m = (item.media && item.media.metadata) || {};
  return String(m.title || item.media && item.media.metadata && item.media.metadata.title || item.id || 'Untitled').trim();
}

function itemAuthor(item) {
  const m = (item.media && item.media.metadata) || {};
  if (m.authorName) return String(m.authorName).trim();
  if (Array.isArray(m.authors) && m.authors.length) {
    return m.authors.map(function (a) { return a.name || a; }).filter(Boolean).join(', ');
  }
  return '';
}

function coverUrl(item) {
  if (!item || !item.id) return '';
  return api('/api/items/' + encodeURIComponent(item.id) + '/cover');
}

function workOf(item) {
  return {
    id: item.id,
    title: itemTitle(item),
    author: itemAuthor(item),
    cover: coverUrl(item),
    url: api('/item/' + encodeURIComponent(item.id)),
  };
}

function looksEpubName(name) {
  return /\.epub$/i.test(String(name || ''));
}

/**
 * Shelf rows are minified (`GET /api/libraries/:id/items` always used `toOldJSONMinified`
 * until the server honored `minified`). That shape has `media.ebookFormat` and no `ebookFile`.
 * The ABS app reads `ebookFormat` the same way (`epub` | `pdf` | null).
 */
function isEpubItem(item) {
  if (!item || item.isMissing || item.isInvalid) return false;
  const media = item.media || {};
  const file = media.ebookFile || {};
  const format = String(media.ebookFormat || file.ebookFormat || '').toLowerCase();
  if (format === 'epub') return true;
  if (format) return false;
  const name = (file.metadata && file.metadata.filename) || '';
  if (looksEpubName(name)) return true;
  const files = item.libraryFiles || [];
  for (let i = 0; i < files.length; i++) {
    const meta = (files[i] && files[i].metadata) || {};
    if (String(meta.ext || '').replace(/^\./, '').toLowerCase() === 'epub') return true;
    if (looksEpubName(meta.filename || meta.path || '')) return true;
  }
  return false;
}

async function enabledMap() {
  try {
    const raw = await flow.storage.get(ENABLED_LIBS);
    if (!raw) return {};
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function libraryEnabled(id, map) {
  if (!map || typeof map[id] === 'undefined') return true;
  return !!map[id];
}

async function libraries() {
  const r = await withAuth('/api/libraries');
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) throw err('NETWORK', 'Could not load libraries (' + r.status + ')');
  return (r.body && r.body.libraries) || [];
}

async function activeLibraries() {
  const libs = await libraries();
  const map = await enabledMap();
  return libs.filter(function (lib) { return libraryEnabled(lib.id, map); });
}

/** Host Manage toggles: `{ id, title, enabled }[]`. */
async function listLibraries() {
  const libs = await libraries();
  const map = await enabledMap();
  return libs.map(function (lib) {
    return {
      id: String(lib.id),
      title: String(lib.name || lib.id),
      enabled: libraryEnabled(lib.id, map),
    };
  });
}

async function setLibraryEnabled(id, enabled) {
  const key = String(id || '');
  if (!key) return null;
  const map = await enabledMap();
  map[key] = !!enabled;
  await flow.storage.set(ENABLED_LIBS, JSON.stringify(map));
  return null;
}

const VIEWS = [
  { id: 'library', label: 'Library' },
  { id: 'series', label: 'Series' },
  { id: 'collections', label: 'Collections' },
  { id: 'authors', label: 'Authors' },
];

const LIBRARY_SORTS = [
  { id: 'media.metadata.title', label: 'Title' },
  { id: 'media.metadata.authorName', label: 'Author (First Last)' },
  { id: 'media.metadata.authorNameLF', label: 'Author (Last First)' },
  { id: 'media.metadata.publishedYear', label: 'Publish Year' },
  { id: 'addedAt', label: 'Added At' },
  { id: 'size', label: 'Size' },
  { id: 'media.duration', label: 'Duration' },
  { id: 'birthtimeMs', label: 'File Birthtime' },
  { id: 'mtimeMs', label: 'File Modified' },
  { id: 'progress', label: 'Progress: Last Updated' },
  { id: 'progress.createdAt', label: 'Progress: Started' },
  { id: 'progress.finishedAt', label: 'Progress: Finished' },
  { id: 'random', label: 'Randomly' },
];

const SERIES_SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'numBooks', label: 'Number of Books' },
  { id: 'totalDuration', label: 'Duration' },
  { id: 'addedAt', label: 'Added At' },
  { id: 'lastBookAdded', label: 'Last Book Added' },
  { id: 'lastBookUpdated', label: 'Last Book Updated' },
];

const COLLECTION_SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'lastUpdate', label: 'Last Updated' },
];

const AUTHOR_SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'numBooks', label: 'Number of Books' },
];

const DESC_DEFAULT = {
  addedAt: true,
  size: true,
  'media.duration': true,
  birthtimeMs: true,
  mtimeMs: true,
  progress: true,
  'progress.createdAt': true,
  'progress.finishedAt': true,
  random: true,
  numBooks: true,
  totalDuration: true,
  lastBookAdded: true,
  lastBookUpdated: true,
  lastUpdate: true,
};

function parseSort(sort, fallback) {
  let raw = String(sort || '').trim();
  let force = 0;
  if (raw.charAt(0) === '!') { force = 1; raw = raw.slice(1); }
  else if (raw.charAt(0) === '+') { force = -1; raw = raw.slice(1); }
  const id = raw || fallback;
  const desc = force === 1 ? true : force === -1 ? false : !!DESC_DEFAULT[id];
  return { id: id, desc: desc };
}

function b64(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? chars[n & 63] : '=';
  }
  return out;
}

function shelf(view, sortId, items, hasMore, sorts, desc) {
  return {
    items: items,
    hasMore: !!hasMore,
    tab: view,
    tabs: VIEWS,
    sorts: sorts,
    sort: sortId,
    desc: !!desc,
  };
}

async function listLibraryItems(libraryId, page, sortSpec, filter) {
  const spec = parseSort(sortSpec, 'media.metadata.title');
  let q = 'limit=' + PAGE + '&page=' + page + '&minified=1&collapseSeries=0&sort=' +
    encodeURIComponent(spec.id) + '&desc=' + (spec.desc ? '1' : '0');
  if (filter) q += '&filter=' + encodeURIComponent(filter);
  const r = await withAuth(
    '/api/libraries/' + encodeURIComponent(libraryId) + '/items?' + q,
  );
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) throw err('NETWORK', 'Could not list library (' + r.status + ')');
  return r.body || { results: [], total: 0 };
}

async function allEbooks() {
  const libs = await activeLibraries();
  const out = [];
  const seen = {};
  for (let i = 0; i < libs.length; i++) {
    const lib = libs[i];
    let page = 0;
    let total = Infinity;
    while (page * PAGE < total) {
      const body = await listLibraryItems(lib.id, page);
      const results = body.results || body.libraryItems || [];
      total = typeof body.total === 'number' ? body.total : results.length;
      for (let j = 0; j < results.length; j++) {
        const item = results[j];
        if (!isEpubItem(item) || seen[item.id]) continue;
        seen[item.id] = true;
        out.push(item);
      }
      if (!results.length) break;
      page++;
    }
  }
  return out;
}

async function progressMap() {
  const r = await withAuth('/api/me/progress');
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) return {};
  const rows = Array.isArray(r.body) ? r.body : (r.body && r.body.mediaProgress) || [];
  const map = {};
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    if (p && p.libraryItemId) map[p.libraryItemId] = p;
  }
  return map;
}

function epubPath(workId) {
  return 'ebooks/' + String(workId).replace(/[^A-Za-z0-9._-]/g, '_') + '.epub';
}

function spineUrl(href) {
  return 'spine:' + String(href || '').replace(/^\/+/, '');
}

function parseSpineUrl(url) {
  const s = String(url || '');
  if (s.indexOf('spine:') !== 0) return '';
  return s.slice('spine:'.length);
}

async function ensureEpub(workId) {
  const path = epubPath(workId);
  // Re-download when missing; host saveAs overwrites.
  const r = await withAuth('/api/items/' + encodeURIComponent(workId) + '/ebook', {
    method: 'GET',
    saveAs: path,
  });
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) throw err('NETWORK', 'Could not download EPUB (' + r.status + ')');
  return path;
}

function chaptersFromSpine(file) {
  const spine = flow.epub.spine(file) || [];
  return spine.map(function (item, i) {
    return {
      title: (item.title && String(item.title).trim()) || ('Chapter ' + (i + 1)),
      url: spineUrl(item.href),
    };
  });
}

function locusFromProgress(p, file) {
  if (!p || !p.ebookLocation) {
    return { chapterUrl: '', blockIndex: 0, charOffset: 0, anchorText: '', fraction: 0, updatedAt: 0 };
  }
  const locus = flow.epub.cfiRead(file, p.ebookLocation);
  const spineIndex = locus ? locus.spineIndex : 0;
  const href = (flow.epub.spine(file) || [])[spineIndex];
  return {
    chapterUrl: spineUrl(href && href.href),
    blockIndex: locus ? locus.blockIndex || 0 : 0,
    charOffset: locus ? locus.charOffset || 0 : 0,
    anchorText: locus ? locus.anchorText || '' : '',
    fraction: typeof p.ebookProgress === 'number' ? p.ebookProgress : (locus && locus.fraction) || 0,
    updatedAt: p.lastUpdate || 0,
  };
}

// --- Contract ---------------------------------------------------------------------------------

async function login(fields) {
  const username = String((fields && fields.username) || '').trim();
  const password = String((fields && fields.password) || '');
  if (!username || !password) throw err('AUTH_REQUIRED', 'Username and password are required');
  try {
    base();
  } catch (e) {
    throw err('ERROR', (e && e.message) || 'Set the Server address first');
  }
  const r = await fetchJson('/login', {
    method: 'POST',
    auth: false,
    headers: {
      'Content-Type': 'application/json',
      'x-return-tokens': 'true',
    },
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ username: username, password: password }),
  });
  if (r.status < 200 || r.status >= 300 || !r.body || !r.body.user) {
    const detail = (r.body && (r.body.error || r.body.message)) || r.text || '';
    throw err(
      'AUTH_REQUIRED',
      'Sign in failed' + (r.status ? ' (HTTP ' + r.status + ')' : '') +
        (detail ? ': ' + String(detail).slice(0, 120) : ''),
    );
  }
  const user = r.body.user;
  const access = user.accessToken || user.token;
  if (!access) throw err('AUTH_REQUIRED', 'Server did not return an access token');
  await flow.secrets.set(ACCESS, access);
  if (user.refreshToken) await flow.secrets.set(REFRESH, user.refreshToken);
  const name = user.username || username;
  await flow.secrets.set(USERNAME, name);
  // Password is only for this request; never keep it in secrets or storage.
  await flow.secrets.remove('password');
  await flow.secrets.remove('passwd');
  return { loggedIn: true, account: name };
}

async function logout() {
  await flow.secrets.clear();
  return null;
}

async function session() {
  const token = await flow.secrets.get(ACCESS);
  if (!token) return { loggedIn: false };
  try {
    base();
  } catch (_) {
    return { loggedIn: false };
  }
  const r = await fetchJson('/api/me');
  if (r.status === 401) {
    const ok = await refresh();
    if (!ok) return { loggedIn: false };
    const again = await fetchJson('/api/me');
    if (again.status < 200 || again.status >= 300 || !again.body) return { loggedIn: false };
    const u = again.body.username || again.body.user || (await flow.secrets.get(USERNAME)) || '';
    return { loggedIn: true, username: String(u), displayName: String(u) };
  }
  if (r.status < 200 || r.status >= 300 || !r.body) return { loggedIn: false };
  const name = r.body.username || (await flow.secrets.get(USERNAME)) || '';
  return { loggedIn: true, username: String(name), displayName: String(name) };
}

async function search(query, page) {
  const q = String(query || '').trim();
  const pageNo = Math.max(1, Number(page) || 1);
  if (!q) return { items: [], hasMore: false };
  const libs = await activeLibraries();
  const items = [];
  const seen = {};
  for (let i = 0; i < libs.length; i++) {
    const r = await withAuth(
      '/api/libraries/' + encodeURIComponent(libs[i].id) + '/search?q=' + encodeURIComponent(q) + '&limit=' + PAGE,
    );
    if (r.status < 200 || r.status >= 300 || !r.body) continue;
    const book = (r.body.book || []).concat(r.body.books || []);
    for (let j = 0; j < book.length; j++) {
      const entry = book[j];
      const item = entry.libraryItem || entry;
      if (!isEpubItem(item) || seen[item.id]) continue;
      seen[item.id] = true;
      items.push(workOf(item));
    }
  }
  const start = (pageNo - 1) * PAGE;
  const slice = items.slice(start, start + PAGE);
  return { items: slice, hasMore: start + PAGE < items.length };
}

async function list() {
  // Downloaded is local membership. Catalog is the in-tab shelf (`browse`), not a stored list.
  return { items: [], hasMore: false };
}

function resultsOf(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.results || body.libraryItems || body.series || body.collections || body.authors || [];
}

function entityWork(prefix, lib, entity) {
  const books = entity.books || [];
  const count = typeof entity.numBooks === 'number' ? entity.numBooks : books.length;
  const first = books.filter(isEpubItem)[0] || books[0];
  return {
    id: prefix + ':' + lib.id + ':' + entity.id,
    title: String(entity.name || entity.title || entity.id),
    author: count ? (count + (count === 1 ? ' book' : ' books')) : '',
    cover: first && first.id ? coverUrl(first) : '',
    group: '',
  };
}

async function libraryView(libs, pageNo, sort) {
  const spec = parseSort(sort, 'media.metadata.title');
  if (!libs.length) return shelf('library', spec.id, [], false, LIBRARY_SORTS, spec.desc);
  const items = [];
  let hasMore = false;
  for (let i = 0; i < libs.length; i++) {
    const body = await listLibraryItems(libs[i].id, pageNo - 1, sort);
    const results = resultsOf(body);
    const total = typeof body.total === 'number' ? body.total : results.length;
    if (pageNo * PAGE < total) hasMore = true;
    for (let j = 0; j < results.length; j++) {
      if (!isEpubItem(results[j])) continue;
      const work = workOf(results[j]);
      if (libs.length > 1) work.group = String(libs[i].name || libs[i].id);
      items.push(work);
    }
  }
  return shelf('library', spec.id, items, hasMore, LIBRARY_SORTS, spec.desc);
}

function assertOk(r, what) {
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) throw err('NETWORK', 'Could not load ' + what + ' (' + r.status + ')');
}

async function pagedEntities(libs, path, sort, fallback) {
  const spec = parseSort(sort, fallback);
  const all = [];
  for (let i = 0; i < libs.length; i++) {
    let apiPage = 0;
    let total = Infinity;
    while (apiPage * PAGE < total) {
      const r = await withAuth(
        '/api/libraries/' + encodeURIComponent(libs[i].id) + path +
          (path.indexOf('?') >= 0 ? '&' : '?') +
          'minified=1&limit=' + PAGE + '&page=' + apiPage + '&sort=' + encodeURIComponent(spec.id) +
          '&desc=' + (spec.desc ? '1' : '0'),
      );
      assertOk(r, 'series');
      const rows = resultsOf(r.body);
      if (!rows.length) break;
      const reported = r.body && typeof r.body.total === 'number';
      for (let j = 0; j < rows.length; j++) all.push({ lib: libs[i], row: rows[j] });
      apiPage++;
      if (!reported || rows.length < PAGE) break;
      total = r.body.total;
    }
  }
  return { spec: spec, all: all };
}

function pageEntities(packed, pageNo, prefix) {
  const start = (pageNo - 1) * PAGE;
  const slice = packed.all.slice(start, start + PAGE).map(function (entry) {
    const work = entityWork(prefix, entry.lib, entry.row);
    if (packed.all.length && entry.lib) work.group = packed.multi ? String(entry.lib.name || '') : '';
    return work;
  });
  return { items: slice, hasMore: start + PAGE < packed.all.length };
}

async function seriesView(libs, pageNo, sort) {
  const packed = await pagedEntities(libs, '/series', sort, 'name');
  packed.multi = libs.length > 1;
  const page = pageEntities(packed, pageNo, 'series');
  return shelf('series', packed.spec.id, page.items, page.hasMore, SERIES_SORTS, packed.spec.desc);
}

async function collectionsView(libs, pageNo, sort) {
  const spec = parseSort(sort, 'name');
  const all = [];
  for (let i = 0; i < libs.length; i++) {
    const r = await withAuth('/api/libraries/' + encodeURIComponent(libs[i].id) + '/collections?minified=1&limit=0');
    assertOk(r, 'collections');
    const rows = resultsOf(r.body);
    for (let j = 0; j < rows.length; j++) all.push({ lib: libs[i], row: rows[j] });
  }
  all.sort(function (a, b) {
    const av = spec.id === 'lastUpdate' ? (a.row.lastUpdate || 0) : String(a.row.name || '');
    const bv = spec.id === 'lastUpdate' ? (b.row.lastUpdate || 0) : String(b.row.name || '');
    if (av < bv) return spec.desc ? 1 : -1;
    if (av > bv) return spec.desc ? -1 : 1;
    return 0;
  });
  const start = (pageNo - 1) * PAGE;
  const items = all.slice(start, start + PAGE).map(function (entry) {
    return entityWork('collection', entry.lib, entry.row);
  });
  return shelf('collections', spec.id, items, start + PAGE < all.length, COLLECTION_SORTS, spec.desc);
}

async function authorsView(libs, pageNo, sort) {
  const spec = parseSort(sort, 'name');
  const all = [];
  for (let i = 0; i < libs.length; i++) {
    const r = await withAuth('/api/libraries/' + encodeURIComponent(libs[i].id) + '/authors');
    assertOk(r, 'authors');
    const rows = (r.body && r.body.authors) || resultsOf(r.body);
    for (let j = 0; j < rows.length; j++) all.push({ lib: libs[i], row: rows[j] });
  }
  all.sort(function (a, b) {
    const av = spec.id === 'numBooks' ? (a.row.numBooks || 0) : String(a.row.name || '');
    const bv = spec.id === 'numBooks' ? (b.row.numBooks || 0) : String(b.row.name || '');
    if (av < bv) return spec.desc ? 1 : -1;
    if (av > bv) return spec.desc ? -1 : 1;
    return 0;
  });
  const start = (pageNo - 1) * PAGE;
  const items = all.slice(start, start + PAGE).map(function (entry) {
    return entityWork('author', entry.lib, entry.row);
  });
  return shelf('authors', spec.id, items, start + PAGE < all.length, AUTHOR_SORTS, spec.desc);
}

function splitRef(id) {
  const parts = String(id || '').split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== 'series' && parts[0] !== 'collection' && parts[0] !== 'author') return null;
  return { kind: parts[0], lib: parts[1], entity: parts.slice(2).join(':') };
}

async function drill(ref, pageNo, sort) {
  const view = ref.kind === 'author' ? 'authors' : ref.kind === 'collection' ? 'collections' : 'series';
  if (ref.kind === 'collection') {
    const r = await withAuth('/api/libraries/' + encodeURIComponent(ref.lib) + '/collections?minified=1&limit=0');
    assertOk(r, 'collections');
    const rows = resultsOf(r.body);
    const col = rows.filter(function (c) { return String(c.id) === ref.entity; })[0];
    const books = ((col && col.books) || []).filter(isEpubItem).map(workOf);
    books.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    const start = (pageNo - 1) * PAGE;
    return shelf(view, 'media.metadata.title', books.slice(start, start + PAGE), start + PAGE < books.length, LIBRARY_SORTS, false);
  }
  const spec = parseSort(sort, ref.kind === 'series' ? 'sequence' : 'media.metadata.title');
  const filter = (ref.kind === 'author' ? 'authors.' : 'series.') + b64(ref.entity);
  const body = await listLibraryItems(ref.lib, pageNo - 1, (spec.desc ? '!' : '+') + spec.id, filter);
  const results = resultsOf(body);
  const total = typeof body.total === 'number' ? body.total : results.length;
  const sorts = ref.kind === 'series'
    ? [{ id: 'sequence', label: 'Series order' }].concat(LIBRARY_SORTS)
    : LIBRARY_SORTS;
  return shelf(view, spec.id, results.filter(isEpubItem).map(workOf), pageNo * PAGE < total, sorts, spec.desc);
}

async function browse(id, page, sort, tab) {
  const pageNo = Math.max(1, Number(page) || 1);
  const key = String(id || '').trim();
  const ref = splitRef(key);
  if (ref) return drill(ref, pageNo, sort);
  const libs = await activeLibraries();
  const view = ['series', 'collections', 'authors'].indexOf(tab) >= 0 ? tab : 'library';
  let scope = libs;
  if (key && key !== 'catalog') {
    scope = libs.filter(function (lib) { return String(lib.id) === key; });
  }
  if (view === 'series') return seriesView(scope, pageNo, sort);
  if (view === 'collections') return collectionsView(scope, pageNo, sort);
  if (view === 'authors') return authorsView(scope, pageNo, sort);
  return libraryView(scope, pageNo, sort);
}

async function setMembership() {
  // Downloaded membership is local-only.
  return false;
}

async function loadWork(workId) {
  const id = String(workId || '').trim();
  if (!id) throw err('ERROR', 'Missing work id');
  const r = await withAuth('/api/items/' + encodeURIComponent(id));
  if (r.status === 404) throw err('NOT_FOUND', 'Book not found');
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300 || !r.body) throw err('NETWORK', 'Could not load book');
  const item = r.body;
  if (!isEpubItem(item)) throw err('UNSUPPORTED', 'Only EPUB ebooks are supported');
  const file = await ensureEpub(id);
  const chapters = chaptersFromSpine(file);
  if (!chapters.length) throw err('PARSE', 'This EPUB has no chapters');
  const progress = await progressMap();
  const p = progress[id];
  let readChapterUrl = '';
  if (p && p.ebookLocation) {
    const locus = flow.epub.cfiRead(file, p.ebookLocation);
    if (locus && chapters[locus.spineIndex]) readChapterUrl = chapters[locus.spineIndex].url;
  }
  const work = workOf(item);
  return {
    id: work.id,
    title: work.title,
    author: work.author,
    cover: work.cover,
    url: work.url,
    synopsis: ((item.media && item.media.metadata && item.media.metadata.description) || '').trim(),
    tags: [],
    chapters: chapters,
    readChapterUrl: readChapterUrl,
    file: file,
  };
}

async function loadChapter(ref, work) {
  const id = String((work && work.id) || '').trim();
  const url = typeof ref === 'string' ? ref : (ref && ref.url) || '';
  const href = parseSpineUrl(url);
  if (!id || !href) throw err('ERROR', 'Missing chapter');
  const file = await ensureEpub(id);
  const html = flow.epub.html(file, href) || '';
  return {
    title: (ref && ref.title) || '',
    html: html,
  };
}

async function syncProgress(workId, chapter, locus) {
  const id = String(workId || '').trim();
  if (!id) return null;
  const file = epubPath(id);
  const href = parseSpineUrl(chapter && chapter.url);
  const spine = flow.epub.spine(file) || [];
  let spineIndex = spine.findIndex(function (s) { return s.href === href || spineUrl(s.href) === (chapter && chapter.url); });
  if (spineIndex < 0) spineIndex = 0;
  const cfi = flow.epub.cfiWrite({
    file: file,
    spineIndex: spineIndex,
    blockIndex: (locus && locus.blockIndex) || 0,
    charOffset: (locus && locus.charOffset) || 0,
    anchorText: (locus && locus.anchorText) || '',
    fraction: (locus && locus.fraction) || 0,
  });
  const ebookProgress = typeof (locus && locus.fraction) === 'number' ? locus.fraction : 0;
  const lastUpdate = (locus && locus.positionAt) || Date.now();
  const body = {
    ebookLocation: cfi,
    ebookProgress: ebookProgress,
    lastUpdate: lastUpdate,
  };
  const r = await withAuth('/api/me/progress/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw err('AUTH_REQUIRED', 'Sign in again');
  if (r.status < 200 || r.status >= 300) throw err('NETWORK', 'Could not sync progress (' + r.status + ')');
  return null;
}

async function readPositions(ids) {
  const want = Array.isArray(ids) ? ids.map(String) : [];
  const progress = await progressMap();
  const out = [];
  for (let i = 0; i < want.length; i++) {
    const id = want[i];
    const p = progress[id];
    if (!p || !p.ebookLocation) continue;
    let file = epubPath(id);
    // Prefer an already-downloaded file; otherwise skip locus detail and use spine:0 placeholder.
    let locus;
    try {
      locus = locusFromProgress(p, file);
    } catch (_) {
      locus = null;
    }
    if (!locus || !locus.chapterUrl) {
      // Without a local EPUB, still return a row so the host can pending-apply after loadWork.
      out.push({
        id: id,
        chapterUrl: 'spine:',
        chapterTitle: '',
        blockIndex: 0,
        charOffset: 0,
        anchorText: '',
        fraction: typeof p.ebookProgress === 'number' ? p.ebookProgress : 0,
        updatedAt: p.lastUpdate || 0,
      });
      continue;
    }
    out.push({
      id: id,
      chapterUrl: locus.chapterUrl,
      chapterTitle: '',
      blockIndex: locus.blockIndex,
      charOffset: locus.charOffset,
      anchorText: locus.anchorText,
      fraction: locus.fraction,
      updatedAt: locus.updatedAt,
    });
  }
  return out;
}

async function checkUpdates() {
  return [];
}

module.exports = {
  login: login,
  logout: logout,
  session: session,
  search: search,
  list: list,
  browse: browse,
  listLibraries: listLibraries,
  setLibraryEnabled: setLibraryEnabled,
  setMembership: setMembership,
  loadWork: loadWork,
  loadChapter: loadChapter,
  syncProgress: syncProgress,
  readPositions: readPositions,
  checkUpdates: checkUpdates,
};
