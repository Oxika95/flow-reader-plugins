/*
 * Royal Road source plugin for Flow Reader (plugin apiVersion 4).
 *
 * Selectors follow WebToEpub (`chapter-inner`, CSS `display:none` watermarks) and QuickNovel
 * (fiction list, `window.chapters`, author notes).
 */

const ORIGIN = 'https://www.royalroad.com';
const HOSTS = ['royalroad.com', 'www.royalroad.com', 'royalroadl.com', 'www.royalroadl.com'];
const FICTION_ID = /\/fiction\/(\d+)/;
const FICTION_PREFIX = /(https?:\/\/[^/]+\/fiction\/\d+\/[^/?#]+)/;
const USER_ID = /window\.royalroad\.userId\s*=\s*(\d+)/;
const HIDDEN_CSS = /([.#][A-Za-z][\w-]*)\s*\{[^}]*display\s*:\s*none/gi;

/** Bookmark `type` values posted to `/fictions/setbookmark/{id}`, keyed by manifest list id. */
const BOOKMARK_TYPES = { follow: 'follow', favorite: 'favorite', readlater: 'readlater' };

/** Follows pages read per update check (sequential, gentle on the site). */
const MAX_FOLLOW_PAGES = 10;

/** Last in-site page, sent as Referer on the next request. */
let lastPageUrl = ORIGIN;

// --- URLs -------------------------------------------------------------------------------------

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(String(url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function isRoyalRoadUrl(url) {
  return HOSTS.indexOf(hostOf(url)) >= 0;
}

function pathOf(url) {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(String(url || '').trim());
  return m ? m[1] : String(url || '');
}

function fictionId(url) {
  const m = FICTION_ID.exec(pathOf(url));
  return m ? m[1] : null;
}

function fictionUrlFrom(url) {
  const m = FICTION_PREFIX.exec(String(url || '').trim());
  return m ? m[1] : null;
}

function chapterId(url) {
  const m = /\/chapter\/(\d+)/.exec(pathOf(url));
  return m ? parseInt(m[1], 10) : null;
}

function syndicationUrl(workId) {
  return ORIGIN + '/fiction/syndication/' + encodeURIComponent(workId);
}

function fictionUrl(workId) {
  return ORIGIN + '/fiction/' + encodeURIComponent(workId);
}

function searchUrl(query, page) {
  const q = encodeURIComponent(String(query || '').trim());
  return ORIGIN + '/fictions/search?title=' + q + (page > 1 ? '&page=' + page : '');
}

function listUrl(listId, page) {
  if (listId === 'follow') return ORIGIN + '/fictions/follows?page=' + Math.max(1, page);
  return null;
}

// --- HTTP -------------------------------------------------------------------------------------

async function request(url, opts) {
  opts = opts || {};
  const headers = Object.assign(
    {
      Referer: opts.referer || lastPageUrl || ORIGIN,
      'Upgrade-Insecure-Requests': '1',
    },
    opts.headers || {},
  );
  const res = await flow.fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    form: opts.form,
  });
  lastPageUrl = res.url || url;
  return res;
}

/** GET a page; non-2xx is an error. Detects expired sign-in unless [authCheck] is false. */
async function getPage(url, opts) {
  opts = opts || {};
  const res = await request(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw flow.error('NETWORK', 'Royal Road returned HTTP ' + res.status);
  }
  if (opts.authCheck !== false && !/\/account\/login/i.test(url) && looksLikeLoginPage(res.text)) {
    try {
      await flow.secrets.set('loggedIn', 'false');
    } catch (e) {
      // Encrypted storage unavailable; the error below still reaches the app.
    }
    throw flow.error('AUTH_REQUIRED', 'Your Royal Road session expired. Sign in again.');
  }
  return res;
}

// --- Auth markers -----------------------------------------------------------------------------

function isLoggedInHtml(html) {
  const m = USER_ID.exec(html);
  if (m) return m[1] !== '0';
  return /\/account\/logout/i.test(html);
}

function looksLikeLoginPage(html) {
  return html.indexOf('form-login-details') >= 0 && !isLoggedInHtml(html);
}

async function isSignedIn() {
  return (await flow.secrets.get('loggedIn')) === 'true';
}

// --- Parsing ----------------------------------------------------------------------------------

function textOf(node) {
  return node ? node.text().trim() : '';
}

function parseFictionList(html, pageUrl) {
  const doc = flow.html.parse(html, pageUrl);
  const out = [];
  const seen = {};
  doc.select('div.fiction-list-item').forEach(function (item) {
    const a = item.selectFirst('h2.fiction-title a') || item.selectFirst('a[href*="/fiction/"]');
    if (!a) return;
    const url = a.attr('abs:href');
    const id = fictionId(url);
    const title = a.text().trim();
    if (!id || !title || seen[id]) return;
    seen[id] = true;
    const author = textOf(item.selectFirst('span.author a, h4 a, span.author')).replace(/^by\s*/i, '');
    let latest = '';
    item.select('div.stats span').some(function (s) {
      const t = s.text().trim();
      if (/chapter/i.test(t)) {
        latest = t;
        return true;
      }
      return false;
    });
    const img = item.selectFirst('img[data-type="cover"], figure img, img.img-responsive');
    let cover = img ? img.attr('abs:src') : '';
    if (/nocover/i.test(cover)) cover = '';
    out.push({ id: id, title: title, url: fictionUrlFrom(url) || url, author: author, cover: cover, subtitle: latest });
  });
  return { doc: doc, items: out };
}

/**
 * Follows page rows → { [fictionId]: { latestId, latestUrl, chapters } }. The newest chapter
 * link in a row (Last Update) has the highest chapter id; the count is a fallback.
 */
function parseFollowUpdates(doc) {
  const out = {};
  doc.select('div.fiction-list-item').forEach(function (item) {
    const a = item.selectFirst('h2.fiction-title a') || item.selectFirst('a[href*="/fiction/"]');
    const id = a ? fictionId(a.attr('abs:href')) : null;
    if (!id || out[id]) return;
    let latestId = null;
    let latestUrl = '';
    item.select('a[href*="/chapter/"]').forEach(function (link) {
      const url = link.attr('abs:href');
      const cid = chapterId(url);
      if (cid != null && (latestId == null || cid > latestId)) {
        latestId = cid;
        latestUrl = url;
      }
    });
    const m = /([\d,]+)\s+Chapters?\b/i.exec(item.text());
    const chapters = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    if (latestId == null && chapters == null) return;
    out[id] = { latestId: latestId, latestUrl: latestUrl, chapters: chapters };
  });
  return out;
}

/** Newest chapter in a fiction RSS feed (`/fiction/syndication/{id}`), by chapter id. */
function parseSyndication(xml) {
  let best = null;
  const items = String(xml || '').split(/<item>/i).slice(1);
  items.forEach(function (raw) {
    const link = /<link>\s*([^<\s]+)\s*<\/link>/i.exec(raw);
    const guid = /<guid[^>]*>\s*(\d+)\s*<\/guid>/i.exec(raw);
    const url = link ? link[1].trim() : '';
    const cid = guid ? parseInt(guid[1], 10) : chapterId(url);
    if (cid == null || !url) return;
    if (!best || cid > best.latestId) best = { latestId: cid, latestUrl: url };
  });
  return best;
}

/**
 * `UpdateInfo` for one work. A newest chapter id at or below the host's last known chapter
 * echoes `lastChapterUrl`, so URL-form differences (short RSS links, renamed slugs) and deleted
 * chapters never look like updates.
 */
function updateInfo(work, found) {
  const lastId = chapterId(work.lastChapterUrl);
  if (found.latestId != null) {
    const newer = lastId == null || found.latestId > lastId;
    return { id: String(work.id), latestUrl: newer ? found.latestUrl : work.lastChapterUrl };
  }
  return { id: String(work.id), chapters: found.chapters };
}

/** True when the pager links to a page after [page]. */
function hasNextPage(doc, page) {
  const links = doc.select('ul.pagination a');
  for (let i = 0; i < links.length; i++) {
    const n = parseInt(links[i].attr('data-page'), 10);
    if (n > page) return true;
    const m = /[?&]page=(\d+)/.exec(links[i].attr('href'));
    if (m && parseInt(m[1], 10) > page) return true;
  }
  return false;
}

/** Bracket-matched JSON array following [marker] in inline script. */
function jsonArrayAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('[', i);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (escape) escape = false;
    else if (inString && c === '\\') escape = true;
    else if (c === '"') inString = !inString;
    else if (inString) continue;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return html.substring(start, j + 1);
    }
  }
  return null;
}

function windowChapters(html, pageUrl) {
  const raw = jsonArrayAfter(html, 'window.chapters');
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  const out = [];
  arr.forEach(function (c) {
    if (!c || !c.url) return;
    const url = flow.url.resolve(pageUrl, String(c.url));
    const title = String(c.title || '').trim() || url.substring(url.lastIndexOf('/') + 1).replace(/-/g, ' ');
    out.push({ title: title, url: url, id: c.id != null ? String(c.id) : '' });
  });
  return out;
}

function tableChapters(doc, pageUrl) {
  const out = [];
  const seen = {};
  doc.select('table#chapters tr[data-url], table#chapters a[href*="/chapter/"]').forEach(function (el) {
    const dataUrl = el.attr('data-url');
    const url = dataUrl ? flow.url.resolve(pageUrl, dataUrl) : el.attr('abs:href');
    if (!url || seen[url]) return;
    seen[url] = true;
    out.push({ title: el.text().trim() || url.substring(url.lastIndexOf('/') + 1), url: url });
  });
  return out;
}

function parseFictionPage(html, pageUrl) {
  const doc = flow.html.parse(html, pageUrl);
  const canonicalEl = doc.selectFirst('link[rel="canonical"]');
  const canonical = (canonicalEl && canonicalEl.attr('abs:href')) || fictionUrlFrom(pageUrl) || pageUrl;
  const title = textOf(doc.selectFirst('div.fic-header h1, h1.font-white, h1')) || 'Royal Road';
  const author = textOf(doc.selectFirst('div.fic-header h4 a, h4.font-white a, h4.font-white > span > a'));

  let synopsis = '';
  const desc = doc.selectFirst('div.description div.hidden-content, div.description');
  if (desc) {
    synopsis = desc
      .select('p')
      .map(function (p) {
        return p.text().trim();
      })
      .join('\n\n')
      .trim();
    if (!synopsis) synopsis = desc.text().trim();
  }

  let chapters = windowChapters(html, canonical);
  if (!chapters.length) chapters = tableChapters(doc, canonical);

  const tags = doc
    .select('span.tags > a')
    .map(function (a) {
      return a.text().trim();
    })
    .filter(Boolean);

  let status = '';
  doc.select('div.col-md-8 > div.margin-bottom-10 > span.label, span.label').some(function (s) {
    status = s.text().trim();
    return !!status;
  });

  const statItems = doc.select('ul.list-unstyled > li');
  const statMap = statPairs(statItems);
  let views = countOf(statMap['total views']);
  if (views == null && statItems.length > 1) views = countOf(statItems[1].text());
  const followers = countOf(statMap['followers']);
  const favorites = countOf(statMap['favorites']);

  const ratingEl = doc.selectFirst('span.font-red-sunglo');
  const ratingAttr = ratingEl ? ratingEl.attr('data-content') : '';
  const ratingValue = ratingAttr ? ratingAttr.split('/')[0].trim() : '';

  const authorEl = doc.selectFirst('div.fic-header h4 a, h4.font-white a, h4.font-white > span > a');
  const authorUrl = authorEl ? authorEl.attr('abs:href') : '';

  const cardStats = [];
  if (ratingValue) cardStats.push({ icon: 'star', value: ratingValue, label: 'Rating' });
  if (followers != null) cardStats.push({ icon: 'followers', value: compact(followers), label: 'Followers' });
  if (favorites != null) cardStats.push({ icon: 'heart', value: compact(favorites), label: 'Favorites' });
  if (views != null) cardStats.push({ icon: 'eye', value: compact(views), label: 'Views' });
  const card = {
    stats: cardStats,
    badges: status ? [status] : [],
    links: authorUrl && author ? [{ label: author, url: authorUrl }] : [],
  };

  const coverEl = doc.selectFirst('div.fic-header img, .cover-art-container img, img.thumbnail');
  let cover = coverEl ? coverEl.attr('abs:src') : '';
  if (/nocover/i.test(cover)) cover = '';

  return {
    id: fictionId(canonical) || fictionId(pageUrl) || '',
    title: title,
    url: canonical,
    author: author,
    cover: cover,
    synopsis: synopsis,
    tags: tags,
    chapters: chapters,
    card: card,
  };
}

/** Fiction stats list: alternating `<li>Label :</li><li>Value</li>` → { 'label': 'value' }. */
function statPairs(items) {
  const out = {};
  for (let i = 0; i + 1 < items.length; i += 2) {
    const label = items[i].text().replace(/:/g, '').trim().toLowerCase();
    if (label) out[label] = items[i + 1].text().trim();
  }
  return out;
}

function countOf(text) {
  if (!text) return null;
  const digits = String(text).replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

/** 1234 → "1.2k", 1234567 → "1.2M". */
function compact(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function stripWatermarks(root, pageHtml) {
  const seen = {};
  let m;
  HIDDEN_CSS.lastIndex = 0;
  while ((m = HIDDEN_CSS.exec(pageHtml)) !== null) {
    const sel = m[1];
    if (seen[sel]) continue;
    seen[sel] = true;
    try {
      root.select(sel).forEach(function (el) {
        el.remove();
      });
    } catch (e) {
      // Unparseable selector from site CSS; skip.
    }
  }
  root.select('[style]').forEach(function (el) {
    if (/display\s*:\s*none/i.test(el.attr('style'))) el.remove();
  });
}

function stripNav(root) {
  root.select('a.btn, div.nav-buttons, div.chapter-nav').forEach(function (el) {
    el.remove();
  });
}

/** Author notes outside the chapter body (before or after it). */
function authorNotes(doc, inner) {
  const portlets = doc.select('div.author-note-portlet').filter(function (n) {
    return !inner.contains(n);
  });
  if (portlets.length) return portlets;
  return doc.select('div.author-note').filter(function (n) {
    if (inner.contains(n)) return false;
    for (let p = n.parent(); p; p = p.parent()) {
      if (p.hasClass('author-note-portlet')) return false;
    }
    return true;
  });
}

/** Cleaned chapter body HTML (plus author notes when enabled), or null if the wrapper is missing. */
function chapterHtml(pageHtml, pageUrl, includeNotes) {
  const doc = flow.html.parse(pageHtml, pageUrl);
  const inner = doc.selectFirst('div.chapter-inner') || doc.selectFirst('div.chapter-content');
  if (!inner) return null;
  stripWatermarks(inner, pageHtml);
  stripNav(inner);
  let html = inner.html();
  if (includeNotes) {
    authorNotes(doc, inner).forEach(function (note) {
      stripWatermarks(note, pageHtml);
      html += '<hr/>';
      const caption = textOf(note.selectFirst('.caption-subject'));
      if (caption) html += '<h3>' + caption + '</h3>';
      html += note.html();
    });
  }
  const title = textOf(doc.selectFirst('h1.font-white, div.fic-header h1, h1'));
  return { title: title, html: html, text: inner.text().trim() };
}

function loginToken(html) {
  const doc = flow.html.parse(html);
  const el =
    doc.selectFirst('form.form-login-details input[name="__RequestVerificationToken"]') ||
    doc.selectFirst('input[name="__RequestVerificationToken"]');
  return (el && el.attr('value')) || null;
}

/** `setbookmark` form for [type] on a fiction page, or null when absent (already set / signed out). */
function bookmarkForm(html, pageUrl, type) {
  const doc = flow.html.parse(html, pageUrl);
  const forms = doc.select('form[action*="/fictions/setbookmark/"]');
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (!form.selectFirst('input[name="type"][value="' + type + '"]')) continue;
    const action = form.attr('abs:action') || flow.url.resolve(pageUrl, form.attr('action'));
    const tokenEl = form.selectFirst('input[name="__RequestVerificationToken"]');
    const token = tokenEl ? tokenEl.attr('value') : '';
    if (!action || !token) return null;
    return { action: action, token: token, type: type };
  }
  return null;
}

// --- Contract ---------------------------------------------------------------------------------

module.exports = {
  async search(query, page) {
    page = Math.max(1, page || 1);
    const url = searchUrl(query, page);
    const res = await getPage(url, { referer: ORIGIN });
    const parsed = parseFictionList(res.text, res.url);
    return { items: parsed.items, hasMore: parsed.items.length > 0 && hasNextPage(parsed.doc, page) };
  },

  async list(listId, page) {
    page = Math.max(1, page || 1);
    const url = listUrl(listId, page);
    if (!url) throw flow.error('UNSUPPORTED', 'Royal Road cannot sync this list');
    if (!(await isSignedIn())) throw flow.error('AUTH_REQUIRED', 'Sign in to sync your Royal Road lists');
    const res = await getPage(url, { referer: page > 1 ? listUrl(listId, page - 1) : ORIGIN });
    const parsed = parseFictionList(res.text, res.url);
    return { items: parsed.items, hasMore: parsed.items.length > 0 && hasNextPage(parsed.doc, page) };
  },

  async loadWork(workId) {
    const res = await getPage(fictionUrl(workId));
    const detail = parseFictionPage(res.text, res.url);
    if (!detail.id) detail.id = String(workId);
    if (!detail.chapters.length) throw flow.error('PARSE', 'Could not find a chapter list for this story');
    return detail;
  },

  async loadChapter(chapter, work) {
    const referer = fictionUrlFrom(chapter.url) || (work && work.url) || lastPageUrl;
    const res = await getPage(chapter.url, { referer: referer });
    const includeNotes = flow.settings.authorNotes !== false;
    const parsed = chapterHtml(res.text, res.url, includeNotes);
    if (!parsed) throw flow.error('PARSE', 'Could not find chapter text. Royal Road markup may have changed.');
    if (!parsed.text) throw flow.error('PARSE', 'Chapter page had no readable text');
    return { title: parsed.title || chapter.title || 'Royal Road chapter', html: parsed.html };
  },

  async login(fields) {
    const email = String((fields && fields.email) || '').trim();
    const password = String((fields && fields.password) || '');
    if (!email || !password) throw flow.error('AUTH_REQUIRED', 'Enter your email and password');
    const loginUrl = ORIGIN + '/account/login';
    const page = await getPage(loginUrl, { referer: ORIGIN, authCheck: false });
    const token = loginToken(page.text);
    if (!token) throw flow.error('PARSE', 'Could not read the Royal Road login form');
    const res = await request(loginUrl, {
      method: 'POST',
      referer: loginUrl,
      form: {
        Email: email,
        Password: password,
        Remember: 'true',
        ReturnUrl: '/',
        __RequestVerificationToken: token,
      },
    });
    const ok = !/\/account\/login/i.test(res.url) || isLoggedInHtml(res.text);
    if (!ok || looksLikeLoginPage(res.text)) {
      throw flow.error('AUTH_REQUIRED', 'Sign in failed. Check email and password.');
    }
    await flow.secrets.set('email', email);
    await flow.secrets.set('loggedIn', 'true');
    return { loggedIn: true, account: email };
  },

  async logout() {
    try {
      await request(ORIGIN + '/account/logout');
    } catch (e) {
      // Local sign-out still proceeds.
    }
    await flow.cookies.clear();
    await flow.secrets.clear();
  },

  async session() {
    const loggedIn = await isSignedIn();
    return { loggedIn: loggedIn, account: loggedIn ? (await flow.secrets.get('email')) || '' : '' };
  },

  async setMembership(workId, listId, on) {
    const type = BOOKMARK_TYPES[listId];
    if (!type || !on) return false;
    if (!(await isSignedIn())) return false;
    const url = fictionUrl(workId);
    const page = await getPage(url);
    const form = bookmarkForm(page.text, page.url, type);
    if (!form) return false;
    const res = await request(form.action, {
      method: 'POST',
      referer: page.url,
      form: { type: form.type, __RequestVerificationToken: form.token },
    });
    if (res.status < 200 || res.status >= 400) {
      throw flow.error('NETWORK', 'Could not update Royal Road list (HTTP ' + res.status + ')');
    }
    return true;
  },

  async syncProgress(workId, chapter) {
    if (!chapter || !chapter.url) return;
    try {
      await request(chapter.url, { referer: fictionUrlFrom(chapter.url) || fictionUrl(workId) });
    } catch (e) {
      // Best effort: reading continues offline.
    }
  },

  async checkUpdates(works) {
    works = Array.isArray(works) ? works : [];
    const pending = {};
    works.forEach(function (w) {
      if (w && w.id != null) pending[String(w.id)] = w;
    });
    const out = [];

    // Signed in: one Follows page covers many stories.
    if ((await isSignedIn()) && Object.keys(pending).length) {
      try {
        for (let page = 1; page <= MAX_FOLLOW_PAGES && Object.keys(pending).length; page++) {
          const res = await getPage(listUrl('follow', page), { referer: page > 1 ? listUrl('follow', page - 1) : ORIGIN });
          const doc = flow.html.parse(res.text, res.url);
          const found = parseFollowUpdates(doc);
          Object.keys(found).forEach(function (id) {
            if (!pending[id]) return;
            out.push(updateInfo(pending[id], found[id]));
            delete pending[id];
          });
          if (!hasNextPage(doc, page)) break;
        }
      } catch (e) {
        // Expired sign-in or a failed page: the per-story feeds below still work.
      }
    }

    // Not followed on the site, or signed out: the public per-story RSS feed.
    const rest = Object.keys(pending);
    for (let i = 0; i < rest.length; i++) {
      const work = pending[rest[i]];
      try {
        const res = await request(syndicationUrl(work.id), { referer: fictionUrl(work.id) });
        if (res.status < 200 || res.status >= 300) continue;
        const found = parseSyndication(res.text);
        if (found) out.push(updateInfo(work, found));
      } catch (e) {
        // Skipped this run.
      }
    }
    return out;
  },

  async resolveUrl(url) {
    if (!isRoyalRoadUrl(url)) return null;
    const id = fictionId(url);
    if (id) return id;
    // Short chapter links (`/fiction/chapter/123`) only reveal the fiction after a redirect.
    if (/\/chapter\/\d+/.test(pathOf(url))) {
      const res = await getPage(String(url).trim());
      return fictionId(res.url) || fictionId(parseFictionPage(res.text, res.url).url) || null;
    }
    return null;
  },
};
