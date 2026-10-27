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
const USER_NAME = /window\.royalroad\.username\s*=\s*"((?:[^"\\]|\\.)*)"/;
const HIDDEN_CSS = /([.#][A-Za-z][\w-]*)\s*\{[^}]*display\s*:\s*none/gi;

/** Bookmark `type` values posted to `/fictions/setbookmark/{id}`, keyed by manifest list id. */
const BOOKMARK_TYPES = { follow: 'follow', favorite: 'favorite', readlater: 'ril' };

/** Signed-in list pages, keyed by manifest list id. */
const LIST_PATHS = { follow: '/my/follows', favorite: '/my/favorites', readlater: '/my/readlater' };

/** Follows pages read per update check (sequential, gentle on the site). */
const MAX_FOLLOW_PAGES = 10;
/** `checkUpdates` and `readPositions` run back to back; one Follows scan serves both. */
const FOLLOWS_TTL_MS = 2 * 60 * 1000;

let followsCache = null;
/** In-progress Follows merge while `list('follow')` pages; committed to [followsCache] when done. */
let followsAccum = null;

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
  const path = LIST_PATHS[listId];
  return path ? ORIGIN + path + '?page=' + Math.max(1, page) : null;
}

function listLabel(listId) {
  return { follow: 'Follows', favorite: 'Favorites', readlater: 'Read Later' }[listId] || listId;
}

/** Count case-insensitive needle occurrences (rough CSS class / marker probe). */
function countNeedle(haystack, needle) {
  const s = String(haystack || '');
  const n = String(needle || '');
  if (!n) return 0;
  let c = 0;
  let i = 0;
  const lower = s.toLowerCase();
  const want = n.toLowerCase();
  while (true) {
    const at = lower.indexOf(want, i);
    if (at < 0) return c;
    c++;
    i = at + want.length;
  }
}

function pageTitle(html) {
  const m = /<title[^>]*>([^<]{1,120})/i.exec(String(html || ''));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/**
 * Class / structure clues when fiction-list-item is missing (RR redesign).
 * Kept short for the Plugins debug channel.
 */
function markupProbe(html) {
  const text = String(html || '');
  const classes = {};
  const re = /class\s*=\s*"([^"]{1,200})"/gi;
  let m;
  while ((m = re.exec(text))) {
    m[1].split(/\s+/).forEach(function (c) {
      if (!c) return;
      const low = c.toLowerCase();
      if (
        /fiction|follow|favor|bookmark|read.?later|list|card|row|portlet|title|author|chapter|cover|user-cp/.test(
          low,
        )
      ) {
        classes[c] = (classes[c] || 0) + 1;
      }
    });
  }
  const ranked = Object.keys(classes)
    .sort(function (a, b) {
      return classes[b] - classes[a];
    })
    .slice(0, 40)
    .map(function (c) {
      return c + '×' + classes[c];
    });
  const fictionLinks = countNeedle(text, '/fiction/');
  return (
    'fictionLinks≈' +
    fictionLinks +
    (ranked.length ? ' classes=[' + ranked.join(', ') + ']' : ' classes=[]')
  );
}

/** Truncated parent snippets around the first N /fiction/N/ links. */
function fictionLinkSamples(html, limit) {
  const text = String(html || '');
  const out = [];
  const re = /href\s*=\s*"(\/fiction\/\d+\/[^"]*)"/gi;
  let m;
  while ((m = re.exec(text)) && out.length < (limit || 3)) {
    const at = m.index;
    const start = Math.max(0, at - 180);
    const end = Math.min(text.length, at + m[0].length + 220);
    out.push(text.slice(start, end).replace(/\s+/g, ' '));
  }
  return out;
}

/**
 * Human fingerprint of a list/HTML response for Plugins debug (via flow.log → host channel).
 */
function describeHtml(html, pageUrl) {
  const text = String(html || '');
  const flags = [];
  if (looksLikeAnubis(text)) flags.push('bot-check');
  if (looksLikeLoginPage(text)) flags.push('login-page');
  if (isLoggedInHtml(text)) flags.push('logged-in');
  if (looksLikeEmptyListPage(text)) flags.push('empty-list-copy');
  const name = accountName(text);
  const uid = (USER_ID.exec(text) || [])[1];
  if (name) flags.push('user=' + name);
  else if (uid) flags.push('userId=' + uid);
  const modernCards = countNeedle(text, 'follow-update-card');
  if (modernCards > 0) flags.push('follow-update-card≈' + modernCards);
  const expandedCards = countNeedle(text, 'fiction-card-expanded');
  if (expandedCards > 0) flags.push('fiction-card-expanded≈' + expandedCards);
  const items = countNeedle(text, 'fiction-list-item');
  if (items > 0) flags.push('fiction-list-item≈' + items);
  else if (
    modernCards === 0 &&
    expandedCards === 0 &&
    text.toLowerCase().indexOf('fiction-list') >= 0
  ) {
    flags.push('fiction-list-shell');
  }
  if (text.toLowerCase().indexOf('portlet') >= 0) flags.push('portlet');
  const title = pageTitle(text);
  return (
    'packet: ' +
    (flags.length ? flags.join(',') : 'unrecognized') +
    (title ? ' title="' + title + '"' : '') +
    ' bytes=' +
    text.length +
    (pageUrl ? ' url=' + pageUrl : '')
  );
}

/**
 * Shared body of `list` / `listFromHtml`: parse fiction-list HTML and refuse bot-check / shell
 * pages so Overwrite never wipes a local library from empty garbage.
 */
async function listFromHtmlBody(listId, html, pageUrl, page) {
  const label = listLabel(listId);
  flow.log('Parsing ' + label + ' page ' + page + '… ' + describeHtml(html, pageUrl));
  const parsed = parseFictionList(html, pageUrl);
  const sample = parsed.items
    .slice(0, 3)
    .map(function (w) {
      return w.title || w.id;
    })
    .join('; ');
  flow.log(
    label +
      ' page ' +
      page +
      ' → ' +
      parsed.items.length +
      ' stories parsed' +
      (sample ? ' (e.g. ' + sample + ')' : ''),
  );
  if (!parsed.items.length) {
    if (looksLikeAnubis(html)) {
      flow.log(label + ' page looks like a bot-check — refusing empty result');
      throw flow.error(
        'NETWORK',
        'Royal Road blocked the request (bot check). Open the list page from Account → Site, wait for it to load, then tap Done.',
      );
    }
    if (!isLoggedInHtml(html)) {
      flow.log(label + ' page is not a signed-in session (login wall or guest shell)');
      try {
        await flow.secrets.set('loggedIn', 'false');
      } catch (e) {
        // Encrypted storage unavailable; the error below still reaches the app.
      }
      throw flow.error('AUTH_REQUIRED', 'Your Royal Road session expired. Sign in again.');
    }
    if (!looksLikeEmptyListPage(html)) {
      flow.log(
        label +
          ' signed-in but 0 fiction rows parsed — markup miss or wrong page body. ' +
          describeHtml(html, pageUrl),
      );
      flow.log(label + ' markup probe: ' + markupProbe(html));
      try {
        await flow.storage.set(
          'debug:list:' + listId,
          JSON.stringify({
            at: Date.now(),
            url: pageUrl || '',
            len: String(html || '').length,
            head: String(html || '').slice(0, 1500),
            probe: markupProbe(html),
            samples: fictionLinkSamples(html, 5),
          }),
        );
      } catch (e) {
        // ignore
      }
      throw flow.error(
        'PARSE',
        'Could not read your Royal Road ' +
          listId +
          ' list from ' +
          (pageUrl || '') +
          '. Open the list page from Account → Site and tap Done.',
      );
    }
    flow.log(label + ' page looks intentionally empty (site empty-list copy)');
  }
  const hasMore = parsed.items.length > 0 && hasNextPage(parsed.doc, page);
  if (listId === 'follow') warmFollowsFromList(parsed.doc, page, hasMore);
  return { items: parsed.items, hasMore: hasMore };
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
  const fetchOpts = { method: opts.method || 'GET', headers: headers, form: opts.form };
  if (opts.cookies === false) fetchOpts.cookies = false;
  const res = await flow.fetch(url, fetchOpts);
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
  if (looksLikeAnubis(res.text)) {
    throw flow.error(
      'NETWORK',
      'Royal Road blocked the request (bot check). Open site from Account, wait for the page to load, then tap Done and Sync now.',
    );
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

function looksLikeAnubis(html) {
  if (html.indexOf('id="anubis_challenge"') >= 0 || html.indexOf("id='anubis_challenge'") >= 0) return true;
  const lower = String(html || '').toLowerCase();
  if (lower.indexOf("making sure you're not a bot") >= 0 || lower.indexOf('making sure youre not a bot') >= 0) {
    return true;
  }
  return lower.indexOf('proof of work') >= 0 && (lower.indexOf('anubis') >= 0 || lower.indexOf('techaro') >= 0);
}

/**
 * True when an empty Follows/Favorites/Read Later page looks intentional.
 * Do NOT treat "logged in + fiction-list CSS" alone as empty — a bot-check shell or a markup
 * change would also match and wipe the library on Overwrite.
 */
function looksLikeEmptyListPage(html) {
  return /not following any|don'?t have any|no fictions|haven'?t (favorited|bookmarked|added)|nothing (here|to show)|your list is empty/i.test(
    String(html || ''),
  );
}

async function isSignedIn() {
  return (await flow.secrets.get('loggedIn')) === 'true';
}

// --- Parsing ----------------------------------------------------------------------------------

function textOf(node) {
  return node ? node.text().trim() : '';
}

/**
 * Story rows on list pages.
 * - Follows (Oct 2026): `follow-update-card`
 * - Favorites / Read Later (Oct 2026): `fiction-card-expanded`
 * - Browse / search / older HTML: `fiction-list-item`
 */
function listRowNodes(doc) {
  const follows = doc.select('div.follow-update-card');
  if (follows.length) return follows;
  const cards = doc.select('div.fiction-card-expanded');
  if (cards.length) return cards;
  const alt = doc.select('div[class*="-update-card"], div[class*="fiction-card"]');
  if (alt.length) return alt;
  return doc.select('div.fiction-list-item');
}

/**
 * Fiction title link on a row (not a chapter URL).
 * Follows: `h2 > a`. Favorites/Read Later: `a > h2` (sometimes `data-vt-trigger="fiction-card"`).
 */
function rowTitleLink(item) {
  const triggered = item.selectFirst('a[data-vt-trigger="fiction-card"]');
  if (triggered && fictionId(triggered.attr('href') || triggered.attr('abs:href'))) return triggered;
  const h2Child = item.selectFirst('h2 a[href*="/fiction/"]');
  if (h2Child && !/\/chapter\//i.test(h2Child.attr('href') || '')) return h2Child;
  const legacy = item.selectFirst('h2.fiction-title a');
  if (legacy) return legacy;
  const h2 = item.selectFirst('h2');
  if (h2) {
    const parent = h2.parent();
    const href = parent ? parent.attr('href') || '' : '';
    if (/\/fiction\//i.test(href) && !/\/chapter\//i.test(href) && fictionId(href)) return parent;
  }
  const links = item.select('a[href*="/fiction/"]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].attr('href') || '';
    if (/\/chapter\//i.test(href)) continue;
    if (!fictionId(href)) continue;
    if (textOf(links[i]) || links[i].selectFirst('h2')) return links[i];
  }
  return null;
}

function parseFictionList(html, pageUrl) {
  const doc = flow.html.parse(html, pageUrl);
  const out = [];
  const seen = {};
  listRowNodes(doc).forEach(function (item) {
    const a = rowTitleLink(item);
    if (!a) return;
    const url = a.attr('abs:href');
    const id = fictionId(url);
    const title = (a.attr('title') || a.text()).trim();
    if (!id || !title || seen[id]) return;
    seen[id] = true;
    const authorNode =
      item.selectFirst('a[href*="/profile/"]') ||
      item.selectFirst('span.author a, h4 a, span.author');
    const author = textOf(authorNode).replace(/^by\s*/i, '');
    let latest = '';
    item.select('div.stats span').some(function (s) {
      const t = s.text().trim();
      if (/chapter/i.test(t)) {
        latest = t;
        return true;
      }
      return false;
    });
    if (!latest) {
      const chapterLink = item.selectFirst('a[href*="/chapter/"]');
      if (chapterLink) {
        const span = chapterLink.selectFirst('span');
        latest = (span ? span.text() : chapterLink.text()).trim();
      }
    }
    const img = item.selectFirst(
      'img.object-cover, img[data-type="cover"], figure img, img.img-responsive',
    );
    let cover = '';
    if (img) {
      cover =
        img.attr('abs:data-src') ||
        img.attr('data-src') ||
        img.attr('abs:src') ||
        img.attr('src') ||
        '';
    }
    if (/nocover/i.test(cover) || /^data:/i.test(cover)) cover = '';
    out.push({
      id: id,
      title: title,
      url: fictionUrlFrom(url) || fictionUrl(id),
      author: author,
      cover: cover,
      subtitle: latest,
    });
  });
  return { doc: doc, items: out };
}

/**
 * Follows page rows → { [fictionId]: { latestId, latestUrl, chapters, readUrl } }. The newest
 * chapter link in a row (Last Update) has the highest chapter id; the count is a fallback.
 * `readUrl` is the "Last read" (or "Last Update & Last Read") chapter, '' when never read.
 */
function parseFollowRows(doc) {
  const out = {};
  listRowNodes(doc).forEach(function (item) {
    const a = rowTitleLink(item);
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
    let readUrl = '';
    let readTitle = '';
    // Legacy: `.list-item`. Redesign: `li` with a "Last read:" label.
    item.select('.list-item, li').forEach(function (li) {
      if (readUrl || !/last\s+read/i.test(li.text())) return;
      const link = li.selectFirst('a[href*="/chapter/"]');
      if (link && chapterId(link.attr('abs:href')) != null) {
        readUrl = link.attr('abs:href');
        const span = link.selectFirst('span');
        readTitle = (span ? span.text() : link.text()).trim();
      }
    });
    const m = /([\d,]+)\s+Chapters?\b/i.exec(item.text());
    const chapters = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    if (latestId == null && chapters == null && !readUrl) return;
    out[id] = {
      latestId: latestId,
      latestUrl: latestUrl,
      chapters: chapters,
      readUrl: readUrl,
      readTitle: readTitle,
    };
  });
  return out;
}

/**
 * Merge Follows-page parse into [followsAccum] during `list('follow')` so a later `readPositions`
 * / `checkUpdates` can reuse the same pages instead of walking Follows again.
 */
function warmFollowsFromList(doc, page, hasMore) {
  if (page === 1 || !followsAccum) followsAccum = { rows: {} };
  const found = parseFollowRows(doc);
  Object.keys(found).forEach(function (id) {
    if (!followsAccum.rows[id]) followsAccum.rows[id] = found[id];
  });
  if (!hasMore) {
    followsCache = { at: Date.now(), rows: followsAccum.rows };
    followsAccum = null;
  }
}

/** Every Follows row (cached briefly), or null when signed out or a page failed. */
async function followRows() {
  if (followsCache && Date.now() - followsCache.at < FOLLOWS_TTL_MS) return followsCache.rows;
  if (!(await isSignedIn())) return null;
  const rows = {};
  try {
    for (let page = 1; page <= MAX_FOLLOW_PAGES; page++) {
      const res = await getPage(listUrl('follow', page), { referer: page > 1 ? listUrl('follow', page - 1) : ORIGIN });
      const doc = flow.html.parse(res.text, res.url);
      const found = parseFollowRows(doc);
      Object.keys(found).forEach(function (id) {
        if (!rows[id]) rows[id] = found[id];
      });
      if (!hasNextPage(doc, page)) break;
    }
  } catch (e) {
    return null;
  }
  followsCache = { at: Date.now(), rows: rows };
  followsAccum = null;
  return rows;
}

/** Fiction page "Continue Reading" chapter URL; '' for unread stories ("Start Reading"). */
function continueUrl(html, pageUrl) {
  const doc = flow.html.parse(html, pageUrl);
  const links = doc.select('.fic-buttons a[href*="/chapter/"]');
  for (let i = 0; i < links.length; i++) {
    if (!/continue/i.test(links[i].text())) continue;
    const url = links[i].attr('abs:href');
    if (chapterId(url) != null) return url;
  }
  return '';
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

  const cardStats = [];
  if (ratingValue) cardStats.push({ icon: 'star', value: ratingValue, label: 'Rating' });
  if (followers != null) cardStats.push({ icon: 'followers', value: compact(followers), label: 'Followers' });
  if (favorites != null) cardStats.push({ icon: 'heart', value: compact(favorites), label: 'Favorites' });
  if (views != null) cardStats.push({ icon: 'eye', value: compact(views), label: 'Views' });
  const card = {
    stats: cardStats,
    badges: status ? [status] : [],
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

/**
 * Author notes outside the chapter body, split by page position: `before` the body or `after` it.
 * `innerClass` is the class of [inner], the first such element on the page.
 */
function authorNotes(doc, inner, innerClass) {
  const portlets = doc.select('div.author-note-portlet').some(function (n) {
    return !inner.contains(n);
  });
  const noteCss = portlets ? 'div.author-note-portlet' : 'div.author-note';
  const notes = { before: [], after: [] };
  let seenInner = false;
  doc.select('div.' + innerClass + ', ' + noteCss).forEach(function (n) {
    if (n.hasClass(innerClass)) {
      seenInner = true;
      return;
    }
    if (inner.contains(n)) return;
    if (!portlets) {
      for (let p = n.parent(); p; p = p.parent()) {
        if (p.hasClass('author-note-portlet')) return;
      }
    }
    (seenInner ? notes.after : notes.before).push(n);
  });
  return notes;
}

/** One author note as a heading ("A note from ...") plus its body, watermarks removed. */
function noteHtml(note, pageHtml) {
  stripWatermarks(note, pageHtml);
  const caption = textOf(note.selectFirst('.caption-subject'));
  const body = note.hasClass('author-note') ? note : note.selectFirst('div.author-note') || note;
  return (caption ? '<h3>' + caption + '</h3>' : '') + body.html();
}

/** Cleaned chapter body HTML (plus author notes when enabled), or null if the wrapper is missing. */
function chapterHtml(pageHtml, pageUrl, includeNotes) {
  const doc = flow.html.parse(pageHtml, pageUrl);
  const innerClass = doc.selectFirst('div.chapter-inner') ? 'chapter-inner' : 'chapter-content';
  const inner = doc.selectFirst('div.' + innerClass);
  if (!inner) return null;
  stripWatermarks(inner, pageHtml);
  stripNav(inner);
  let html = inner.html();
  if (includeNotes) {
    const notes = authorNotes(doc, inner, innerClass);
    const before = notes.before.map(function (note) {
      return noteHtml(note, pageHtml) + '<hr/>';
    });
    const after = notes.after.map(function (note) {
      return '<hr/>' + noteHtml(note, pageHtml);
    });
    html = before.join('') + html + after.join('');
  }
  const title = textOf(doc.selectFirst('h1.font-white, div.fic-header h1, h1'));
  return { title: title, html: html, text: inner.text().trim() };
}

/** Signed-in user's name from the inline `window.royalroad.username`, or '' when absent. */
function accountName(html) {
  const m = USER_NAME.exec(html);
  if (!m) return '';
  try {
    return String(JSON.parse('"' + m[1] + '"')).trim();
  } catch (e) {
    return m[1].trim();
  }
}

/**
 * `setbookmark` toggle form for [type] on a fiction page, or null when absent (signed out).
 * `mark` is what submitting would set: true means the story is not on that list yet.
 */
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
    const markEl = form.selectFirst('input[name="mark"]');
    const mark = !markEl || String(markEl.attr('value')).toLowerCase() !== 'false';
    return { action: action, token: token, type: type, mark: mark };
  }
  return null;
}

/** Chapter page "Set Progress" form, shown when this chapter is before the saved progress. */
function rewindForm(html, pageUrl) {
  const doc = flow.html.parse(html, pageUrl);
  const form = doc.selectFirst('form.rewind-form[action*="/setprogress/"]');
  if (!form) return null;
  const action = form.attr('abs:action') || flow.url.resolve(pageUrl, form.attr('action'));
  const tokenEl = form.selectFirst('input[name="__RequestVerificationToken"]');
  const token = tokenEl ? tokenEl.attr('value') : '';
  return action && token ? { action: action, token: token } : null;
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
    const who = (await flow.secrets.get('account')) || 'signed-in user';
    const label = listLabel(listId);
    flow.log('Requesting ' + who + "'s " + label + ' (page ' + page + ') from Royal Road…');
    flow.log('GET ' + url);
    const res = await getPage(url, { referer: page > 1 ? listUrl(listId, page - 1) : ORIGIN });
    flow.log(
      'Royal Road returned HTTP ' +
        res.status +
        ' for ' +
        label +
        '. ' +
        describeHtml(res.text, res.url || url),
    );
    return listFromHtmlBody(listId, res.text, res.url || url, page);
  },

  /** Parse a list page already loaded in the host WebView (optional crawl path). */
  async listFromHtml(listId, html, pageUrl) {
    if (!LIST_PATHS[listId]) throw flow.error('UNSUPPORTED', 'Royal Road cannot sync this list');
    const url = String(pageUrl || listUrl(listId, 1) || '');
    const pageMatch = /[?&]page=(\d+)/i.exec(url);
    const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10) || 1) : 1;
    flow.log('listFromHtml ' + listLabel(listId) + ' page ' + page + ' (' + String(html || '').length + 'b)');
    return listFromHtmlBody(listId, html, url, page);
  },

  async loadWork(workId) {
    const res = await getPage(fictionUrl(workId));
    const detail = parseFictionPage(res.text, res.url);
    if (!detail.id) detail.id = String(workId);
    if (!detail.chapters.length) throw flow.error('PARSE', 'Could not find a chapter list for this story');
    // Signed in, the same page's "Continue Reading" button is the site's reading position.
    const readUrl = continueUrl(res.text, res.url);
    if (readUrl) detail.readChapterUrl = readUrl;
    return detail;
  },

  async loadChapter(chapter, work) {
    const referer = fictionUrlFrom(chapter.url) || (work && work.url) || lastPageUrl;
    // Signed-in chapter views move the site's "Last read"; downloads must not.
    const res = await getPage(chapter.url, { referer: referer, cookies: false, authCheck: false });
    const includeNotes = flow.settings.authorNotes === true;
    const parsed = chapterHtml(res.text, res.url, includeNotes);
    if (!parsed) throw flow.error('PARSE', 'Could not find chapter text. Royal Road markup may have changed.');
    if (!parsed.text) throw flow.error('PARSE', 'Chapter page had no readable text');
    return { title: parsed.title || chapter.title || 'Royal Road chapter', html: parsed.html };
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

  /** Checks the web sign-in cookies against the home page; offline keeps the last known state. */
  async session() {
    let res;
    try {
      res = await request(ORIGIN + '/home', { referer: ORIGIN });
    } catch (e) {
      res = null;
    }
    if (!res || res.status < 200 || res.status >= 300) {
      const loggedIn = await isSignedIn();
      return { loggedIn: loggedIn, account: loggedIn ? (await flow.secrets.get('account')) || '' : '' };
    }
    if (!isLoggedInHtml(res.text)) {
      await flow.secrets.clear();
      return { loggedIn: false, account: '' };
    }
    const account = accountName(res.text) || (await flow.secrets.get('account')) || 'Royal Road';
    await flow.secrets.set('account', account);
    await flow.secrets.set('loggedIn', 'true');
    return { loggedIn: true, account: account };
  },

  async setMembership(workId, listId, on) {
    const type = BOOKMARK_TYPES[listId];
    if (!type) return false;
    if (!(await isSignedIn())) return false;
    const url = fictionUrl(workId);
    const page = await getPage(url);
    const form = bookmarkForm(page.text, page.url, type);
    if (!form) return false;
    followsCache = null;
    followsAccum = null;
    if (form.mark !== !!on) return true;
    const res = await request(form.action, {
      method: 'POST',
      referer: page.url,
      form: { type: form.type, mark: on ? 'true' : 'false', __RequestVerificationToken: form.token },
    });
    if (res.status < 200 || res.status >= 400) {
      throw flow.error('NETWORK', 'Could not update Royal Road list (HTTP ' + res.status + ')');
    }
    return true;
  },

  /**
   * A signed-in chapter view moves the site's reading progress forward; an earlier chapter shows
   * a "you've backtracked" form that sets it back. Throws so the host can retry.
   */
  async syncProgress(workId, chapter) {
    if (!chapter || !chapter.url) return;
    if (!(await isSignedIn())) return;
    const page = await getPage(chapter.url, { referer: fictionUrlFrom(chapter.url) || fictionUrl(workId) });
    followsCache = null;
    followsAccum = null;
    const rewind = rewindForm(page.text, page.url);
    if (!rewind) return;
    const res = await request(rewind.action, {
      method: 'POST',
      referer: page.url,
      form: { __RequestVerificationToken: rewind.token },
    });
    if (res.status < 200 || res.status >= 400) {
      throw flow.error('NETWORK', 'Could not set Royal Road reading progress (HTTP ' + res.status + ')');
    }
  },

  /**
   * Last-read chapters from the Follows pages only. Favorites / Read Later pages carry no
   * position; those stories get theirs from `loadWork` (`readChapterUrl`).
   */
  async readPositions(works) {
    works = Array.isArray(works) ? works : [];
    if (!works.length || !(await isSignedIn())) return [];
    const rows = (await followRows()) || {};
    const out = [];
    works.forEach(function (w) {
      if (!w || w.id == null) return;
      const id = String(w.id);
      const row = rows[id];
      if (row && row.readUrl) out.push({ id: id, chapterUrl: row.readUrl, chapterTitle: row.readTitle });
    });
    return out;
  },

  async checkUpdates(works) {
    works = Array.isArray(works) ? works : [];
    const pending = {};
    works.forEach(function (w) {
      if (w && w.id != null) pending[String(w.id)] = w;
    });
    const out = [];

    // Signed in: one Follows scan covers many stories. A failed scan falls back to the feeds below.
    const rows = Object.keys(pending).length ? await followRows() : null;
    if (rows) {
      Object.keys(rows).forEach(function (id) {
        const row = rows[id];
        if (!pending[id] || (row.latestId == null && row.chapters == null)) return;
        out.push(updateInfo(pending[id], row));
        delete pending[id];
      });
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
      const res = await getPage(String(url).trim(), { cookies: false, authCheck: false });
      return fictionId(res.url) || fictionId(parseFictionPage(res.text, res.url).url) || null;
    }
    return null;
  },
};
