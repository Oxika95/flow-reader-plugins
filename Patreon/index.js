/*
 * Patreon source plugin for Flow Reader (plugin apiVersion 4).
 *
 * A story is a filtered set of one creator's posts: all posts, a collection, or a tag. Post
 * metadata comes from Patreon's JSON:API (`/api/posts`) and is indexed per creator in
 * flow.storage, so posts read once stay in the ToC after access lapses.
 *
 * Work ids: `{campaignId}`, `{campaignId}.c{collectionId}`, `{campaignId}.t{hash}`
 * (hash = FNV-1a base36 of the lower-cased tag).
 */

const ORIGIN = 'https://www.patreon.com';
const API = ORIGIN + '/api';
const HOSTS = ['patreon.com', 'www.patreon.com'];
const POST_FIELDS = 'title,url,published_at,current_user_can_view,post_type';
const PAGE_SIZE = 200;
/** Time one call may spend paging a creator's posts; the rest continues on the next call. */
const INDEX_BUDGET_MS = 35000;
/** A full re-read of a creator's posts (tier changes) at most this often. */
const RESCAN_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TAG_POSTS = 2;
const MAX_CANDIDATES = 40;
const BROWSE_PAGE = 40;
const CAMPAIGN_MS = 6 * 60 * 60 * 1000;
const BROWSE_TABS = [
  { id: 'about', label: 'About' },
  { id: 'posts', label: 'Posts' },
  { id: 'collections', label: 'Collections' },
  { id: 'membership', label: 'Membership' },
];
const STREAM_PAGES = 2;
const SKIP_TYPES = /^(poll|video|audio|livestream)/;
const KINDS = { c: 'collection', t: 'tag' };
const RESERVED_PATHS = [
  'home', 'login', 'signup', 'search', 'messages', 'settings', 'notifications', 'posts', 'collection',
  'api', 'explore', 'membership', 'memberships', 'create', 'about', 'policy', 'user', 'library',
];

// --- Small helpers ----------------------------------------------------------------------------

function qs(params) {
  return Object.keys(params)
    .map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    })
    .join('&');
}

function hostOf(url) {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(String(url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function pathOf(url) {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(String(url || '').trim());
  return m ? m[1] : '';
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function compact(n) {
  if (n == null || isNaN(n)) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlText(html) {
  return html ? flow.html.parse(String(html)).text() : '';
}

/** Plain text with blank lines between the paragraphs / line breaks of [html]. */
function paragraphs(html) {
  if (!html) return '';
  return String(html)
    .split(/<br\s*\/?>|<\/(?:p|li|h[1-6]|div|blockquote)>/i)
    .map(function (chunk) {
      return htmlText(chunk).trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

function relIds(item, name) {
  const rel = item && item.relationships && item.relationships[name];
  const data = rel && rel.data;
  if (!data) return [];
  return (Array.isArray(data) ? data : [data]).map(function (r) {
    return String(r.id);
  });
}

function nextLink(json) {
  return (json && json.links && json.links.next) || null;
}

function postUrl(id) {
  return ORIGIN + '/posts/' + id;
}

function postIdOf(url) {
  const m = /\/posts\/(?:[^/?#]*-)?(\d+)\/?$/.exec(pathOf(url));
  return m ? m[1] : null;
}

// --- Work ids, ordering (pure) --------------------------------------------------------

function parseWorkId(workId) {
  const m = /^(\d+)(?:\.([ct])([0-9a-z]+))?$/.exec(String(workId || ''));
  if (!m) throw flow.error('PARSE', 'Not a Patreon story id: ' + workId);
  return { cid: m[1], kind: m[2] ? KINDS[m[2]] : 'all', key: m[3] || '' };
}

function workIdOf(cid, kind, key) {
  return kind === 'all' ? String(cid) : cid + '.' + kind.charAt(0) + key;
}

function titleNumbers(title) {
  return (String(title || '').match(/\d+/g) || []).map(Number);
}

function byPublished(a, b) {
  if (a.e.p !== b.e.p) return a.e.p < b.e.p ? -1 : 1;
  return Number(a.id) - Number(b.id);
}

function byTitleNumber(a, b) {
  const x = titleNumbers(a.e.t);
  const y = titleNumbers(b.e.t);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  if (x.length !== y.length) return x.length - y.length;
  return byPublished(a, b);
}

/** Posts of story [w] from [idx], oldest first. */
function selectPosts(idx, w, collectionPostIds) {
  const showLocked = flow.settings.lockedPosts === 'show';
  const out = [];
  Object.keys(idx.posts).forEach(function (id) {
    const e = idx.posts[id];
    if (SKIP_TYPES.test(e.y || '')) return;
    if (!e.e && !showLocked) return;
    let match = true;
    if (w.kind === 'collection') {
      match = (e.c || []).indexOf(w.key) >= 0 || !!(collectionPostIds && collectionPostIds[id]);
    } else if (w.kind === 'tag') {
      match = (e.g || []).some(function (tag) {
        return hash(tag.toLowerCase()) === w.key;
      });
    }
    if (match) out.push({ id: id, e: e });
  });
  out.sort(w.kind !== 'all' && flow.settings.order === 'titleNumber' ? byTitleNumber : byPublished);
  return out;
}

function chapterRef(p) {
  return { title: p.e.t || 'Untitled post', url: postUrl(p.id), id: p.id, locked: !p.e.v };
}

// --- HTTP -------------------------------------------------------------------------------------

async function apiFetch(url) {
  return flow.fetch(url, {
    headers: { Accept: 'application/vnd.api+json', Referer: ORIGIN + '/' },
  });
}

async function apiGet(url, what) {
  const res = await apiFetch(url);
  if (res.status < 200 || res.status >= 300) {
    throw flow.error('NETWORK', 'Patreon ' + what + ' returned HTTP ' + res.status);
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw flow.error('PARSE', 'Patreon ' + what + ' was not JSON (blocked or changed?)');
  }
}

async function isSignedIn() {
  return !!(await flow.secrets.get('account'));
}

// --- Creator, collections, post index ---------------------------------------------------------

/** Creator profile and tiers, cached for [CAMPAIGN_MS] (stale copy if Patreon is unreachable). */
async function campaign(cid) {
  const key = 'camp:' + cid;
  let cached = null;
  try {
    cached = JSON.parse((await flow.storage.get(key)) || 'null');
  } catch (e) {
    cached = null;
  }
  if (cached && cached.v !== 2) cached = null;
  if (cached && cached.camp && Date.now() - cached.at < CAMPAIGN_MS) return cached.camp;
  let json;
  try {
    json = await apiGet(
      API + '/campaigns/' + cid + '?' + qs({
        include: 'rewards',
        'fields[campaign]': 'name,url,avatar_photo_url,image_url,summary,creation_name,patron_count,pay_per_name',
        'fields[reward]': 'title,amount_cents,currency,description,patron_count,published,url',
        'json-api-version': '1.0',
      }),
      'creator',
    );
  } catch (e) {
    if (cached && cached.camp) return cached.camp;
    throw e;
  }
  const a = (json.data && json.data.attributes) || {};
  const tiers = (json.included || [])
    .filter(function (r) {
      return r.type === 'reward' && Number(r.id) > 0 && r.attributes && r.attributes.published !== false;
    })
    .map(function (r) {
      const t = r.attributes;
      return {
        id: String(r.id),
        url: /^https:\/\//.test(t.url || '') ? t.url : '',
        title: t.title || 'Tier',
        cents: t.amount_cents || 0,
        currency: t.currency || 'USD',
        patrons: t.patron_count,
        description: paragraphs(t.description),
      };
    })
    .sort(function (x, y) {
      return x.cents - y.cents;
    });
  const camp = {
    id: String(cid),
    name: a.name || 'Patreon creator',
    url: a.url || ORIGIN,
    cover: a.avatar_photo_url || a.image_url || '',
    summary: htmlText(a.summary),
    about: paragraphs(a.summary),
    creation: a.creation_name || '',
    patrons: a.patron_count,
    payPer: a.pay_per_name || 'month',
    tiers: tiers,
  };
  await flow.storage.set(key, JSON.stringify({ v: 2, at: Date.now(), camp: camp }));
  return camp;
}

async function vanityCampaign(vanity) {
  if (!/^[A-Za-z0-9_.-]{2,64}$/.test(vanity)) return null;
  const res = await apiFetch(API + '/campaigns?' + qs({ 'filter[vanity]': vanity, 'json-api-version': '1.0' }));
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const data = JSON.parse(res.text).data;
    const first = Array.isArray(data) ? data[0] : data;
    return first && first.id ? String(first.id) : null;
  } catch (e) {
    return null;
  }
}

async function collections(cid) {
  const out = [];
  let url = API + '/collection?' + qs({
    'filter[campaign_id]': cid,
    'fields[collection]': 'title,description,num_posts,post_ids,thumbnail',
    'json-api-version': '1.0',
  });
  for (let page = 0; url && page < 5; page++) {
    const json = await apiGet(url, 'collections');
    (json.data || []).forEach(function (c) {
      const a = c.attributes || {};
      out.push({
        id: String(c.id),
        title: a.title || 'Collection',
        description: htmlText(a.description),
        postIds: (a.post_ids || []).map(String),
        thumb: (a.thumbnail && (a.thumbnail.default || a.thumbnail.original)) || '',
      });
    });
    url = nextLink(json);
  }
  await flow.storage.set('col:' + cid, JSON.stringify(out));
  return out;
}

async function cachedCollections(cid) {
  try {
    return JSON.parse((await flow.storage.get('col:' + cid)) || '[]');
  } catch (e) {
    return [];
  }
}

function postsUrl(cid, count) {
  return API + '/posts?' + qs({
    'filter[campaign_id]': cid,
    'filter[contains_exclusive_posts]': 'true',
    'filter[is_draft]': 'false',
    sort: '-published_at',
    'page[count]': count || PAGE_SIZE,
    include: 'user_defined_tags,collections',
    'fields[post]': POST_FIELDS,
    'fields[post_tag]': 'value',
    'fields[collection]': 'title',
    'json-api-version': '1.0',
  });
}

async function loadIndex(cid) {
  try {
    const idx = JSON.parse((await flow.storage.get('idx:' + cid)) || 'null');
    if (idx && idx.posts) return idx;
  } catch (e) {
    // Rebuilt below.
  }
  return { posts: {}, complete: false, cursor: '', fullAt: 0 };
}

async function saveIndex(cid, idx) {
  await flow.storage.set('idx:' + cid, JSON.stringify(idx));
}

/**
 * Merge `/api/posts` items into [idx]. `e` (ever viewable) never resets: the archive rule keeps
 * posts the user could read in the ToC after their tier lapses.
 */
function mergePosts(idx, data, included) {
  const tagNames = {};
  (included || []).forEach(function (it) {
    if (it.type === 'post_tag') tagNames[it.id] = (it.attributes && it.attributes.value) || '';
  });
  let known = 0;
  (data || []).forEach(function (p) {
    if (!p || p.type !== 'post') return;
    const a = p.attributes || {};
    const id = String(p.id);
    const old = idx.posts[id];
    if (old) known++;
    const view = !!a.current_user_can_view;
    idx.posts[id] = {
      t: a.title || (old && old.t) || '',
      p: a.published_at || (old && old.p) || '',
      y: a.post_type || (old && old.y) || '',
      g: relIds(p, 'user_defined_tags')
        .map(function (tid) {
          return tagNames[tid] || tid.replace(/^user_defined;/, '');
        })
        .filter(Boolean),
      c: relIds(p, 'collections'),
      v: view,
      e: view || !!(old && old.e),
    };
  });
  return { count: (data || []).length, known: known };
}

/**
 * Bring the creator's post index up to date. Newest posts first until known ones; a full walk
 * (first time, then weekly) re-reads every post and resumes from `cursor` across calls.
 */
async function refreshIndex(cid, opts) {
  opts = opts || {};
  const idx = await loadIndex(cid);
  const deadline = Date.now() + INDEX_BUDGET_MS;
  const maxPages = opts.maxPages || 1000;
  const full = !opts.quick && (!idx.complete || Date.now() - idx.fullAt > RESCAN_MS);
  const resume = full && !!idx.cursor;
  let pages = 0;
  const spent = function () {
    return pages >= maxPages || Date.now() > deadline;
  };
  const done = function () {
    idx.complete = true;
    idx.fullAt = Date.now();
    idx.cursor = '';
  };

  let url = postsUrl(cid);
  while (url) {
    const json = await apiGet(url, 'posts');
    pages++;
    const r = mergePosts(idx, json.data, json.included);
    const next = nextLink(json);
    if (!next) {
      if (full && !resume) done();
      break;
    }
    if ((!full || resume) && r.known > 0) break;
    if (spent()) {
      if (full && !resume) idx.cursor = next;
      break;
    }
    url = next;
  }

  url = resume && !spent() ? idx.cursor : null;
  while (url) {
    let json;
    try {
      json = await apiGet(url, 'posts');
    } catch (e) {
      idx.cursor = '';
      break;
    }
    pages++;
    mergePosts(idx, json.data, json.included);
    const next = nextLink(json);
    if (!next) {
      done();
      break;
    }
    idx.cursor = next;
    if (spent()) break;
    url = next;
  }

  if (pages) await saveIndex(cid, idx);
  return idx;
}

// --- Stories ----------------------------------------------------------------------------------

function latestDate(posts) {
  const last = posts.reduce(function (m, p) {
    return p.e.p > m ? p.e.p : m;
  }, '');
  return last ? last.slice(0, 10) : '';
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const ids = {};
  a.forEach(function (p) {
    ids[p.id] = true;
  });
  return b.every(function (p) {
    return ids[p.id];
  });
}

function candidate(camp, kind, key, title, label, posts) {
  const latest = latestDate(posts);
  return {
    id: workIdOf(camp.id, kind, key),
    title: title,
    url: kind === 'collection' ? ORIGIN + '/collection/' + key : camp.url,
    author: camp.name,
    cover: camp.cover,
    subtitle: label + ' · ' + posts.length + (posts.length === 1 ? ' post' : ' posts') + (latest ? ' · latest ' + latest : ''),
  };
}

/** Every story group a creator offers, All posts first: collections, then tags. */
async function storyGroups(cid) {
  const camp = await campaign(cid);
  const idx = await refreshIndex(cid);
  let cols = [];
  try {
    cols = await collections(cid);
  } catch (e) {
    // Creators without collections, or the endpoint moved: the other groups still work.
  }
  const byLatest = function (a, b) {
    return latestDate(b.posts) < latestDate(a.posts) ? -1 : 1;
  };
  const seen = [];
  const groups = [];
  const all = selectPosts(idx, { kind: 'all' });
  const out = [{ kind: 'all', key: '', title: camp.name, label: 'All posts', posts: all }];

  cols.forEach(function (c) {
    const ids = {};
    c.postIds.forEach(function (id) {
      ids[id] = true;
    });
    const posts = selectPosts(idx, { kind: 'collection', key: c.id }, ids);
    if (posts.length) groups.push({ kind: 'collection', key: c.id, title: c.title, label: 'Collection', posts: posts });
  });

  const tags = {};
  Object.keys(idx.posts).forEach(function (id) {
    (idx.posts[id].g || []).forEach(function (tag) {
      const k = tag.toLowerCase();
      if (!tags[k]) tags[k] = tag;
    });
  });
  const extra = [];
  Object.keys(tags).forEach(function (k) {
    const key = hash(k);
    const posts = selectPosts(idx, { kind: 'tag', key: key });
    if (posts.length >= MIN_TAG_POSTS) extra.push({ kind: 'tag', key: key, title: '#' + tags[k], label: 'Tag', posts: posts });
  });

  groups.sort(byLatest);
  extra.sort(byLatest);
  groups.concat(extra).forEach(function (g) {
    if (sameSet(g.posts, all) || seen.some(function (s) { return sameSet(s, g.posts); })) return;
    seen.push(g.posts);
    out.push(g);
  });
  return { camp: camp, groups: out, tagged: Object.keys(tags).length > 0 };
}

/** Search candidates for one creator, in group order. */
async function candidates(cid) {
  const s = await storyGroups(cid);
  return s.groups.slice(0, MAX_CANDIDATES).map(function (g) {
    return candidate(s.camp, g.kind, g.key, g.title, g.label, g.posts);
  });
}

const BROWSE_SORTS = [
  { id: 'latest', label: 'Latest post' },
  { id: 'title', label: 'Name' },
  { id: 'posts', label: 'Most posts' },
];
const TYPE_RANK = { all: 0, collection: 1, tag: 2 };
const TYPE_GROUP = { all: '', collection: 'Collections', tag: 'Tags' };

/** Creator page order: grouped by type (collections, tags), then [sort]; ties fall back to the newest post. */
function sortGroups(groups, sort) {
  const latest = function (g) {
    return latestDate(g.posts);
  };
  const byLatest = function (a, b) {
    const la = latest(a);
    const lb = latest(b);
    return la === lb ? 0 : la < lb ? 1 : -1;
  };
  const cmp = {
    latest: byLatest,
    title: function (a, b) {
      const ta = a.title.replace(/^#/, '').toLowerCase();
      const tb = b.title.replace(/^#/, '').toLowerCase();
      return ta === tb ? byLatest(a, b) : ta < tb ? -1 : 1;
    },
    posts: function (a, b) {
      return b.posts.length - a.posts.length || byLatest(a, b);
    },
  }[sort];
  return groups.slice().sort(function (a, b) {
    return TYPE_RANK[a.kind] - TYPE_RANK[b.kind] || cmp(a, b);
  });
}

async function readSeen() {
  try {
    return JSON.parse((await flow.storage.get('seen')) || '{}');
  } catch (e) {
    return {};
  }
}

async function markSeen(cid, at) {
  const seen = await readSeen();
  seen[cid] = at;
  await flow.storage.set('seen', JSON.stringify(seen));
}

/**
 * New posts per creator in the first page of the signed-in home feed, counted against the
 * `seen` markers (first sighting sets the marker, so nothing counts as new yet).
 */
async function feedNews(cids) {
  const out = {};
  let json;
  try {
    json = await apiGet(
      API + '/stream?' + qs({
        include: 'campaign',
        'fields[post]': 'published_at',
        'fields[campaign]': 'name',
        'page[count]': 50,
        'json-api-version': '1.0',
      }),
      'feed',
    );
  } catch (e) {
    return out;
  }
  const now = new Date().toISOString();
  const seen = await readSeen();
  let changed = false;
  cids.forEach(function (cid) {
    if (!seen[cid]) {
      seen[cid] = now;
      changed = true;
    }
  });
  if (changed) await flow.storage.set('seen', JSON.stringify(seen));
  const data = json.data || [];
  const more = !!nextLink(json);
  data.forEach(function (p) {
    const cid = relIds(p, 'campaign')[0];
    const at = (p.attributes && p.attributes.published_at) || '';
    if (!cid || !at || cids.indexOf(cid) < 0) return;
    const o = (out[cid] = out[cid] || { count: 0, latest: '', oldestNew: '' });
    if (at > o.latest) o.latest = at;
    if (at > seen[cid]) {
      o.count++;
      if (!o.oldestNew || at < o.oldestNew) o.oldestNew = at;
    }
  });
  const pageOldest = data.reduce(function (m, p) {
    const at = (p.attributes && p.attributes.published_at) || '';
    return at && (!m || at < m) ? at : m;
  }, '');
  Object.keys(out).forEach(function (cid) {
    // Every post on the page is new and there are more pages: the true count is higher.
    out[cid].more = more && out[cid].count > 0 && out[cid].oldestNew === pageOldest;
  });
  return out;
}

function money(cents, currency) {
  const value = (cents / 100).toFixed(cents % 100 ? 2 : 0);
  return currency === 'USD' ? '$' + value : value + ' ' + currency;
}

/** Creator page About tab: cached profile only, plus the post count if posts were indexed before. */
async function aboutTab(cid) {
  const camp = await campaign(cid);
  const idx = await loadIndex(cid);
  const posts = Object.keys(idx.posts).filter(function (id) {
    return !SKIP_TYPES.test(idx.posts[id].y || '');
  }).length;
  const stats = [];
  if (posts) stats.push({ icon: 'pages', value: String(posts), label: 'Posts' });
  if (camp.patrons != null) stats.push({ icon: 'followers', value: compact(camp.patrons), label: 'Patrons' });
  const badge = memberTone(await memberStatus(cid));
  return {
    text: camp.about || camp.creation,
    cover: camp.cover,
    stats: stats,
    badges: badge ? [badge] : [],
    links: [{ label: 'Open on Patreon', url: camp.url }],
  };
}

function tierHead(t, payPer) {
  const price = t.cents ? money(t.cents, t.currency) + ' / ' + payPer : 'Free';
  const parts = [t.title];
  if (price.toLowerCase() !== t.title.toLowerCase()) parts.push(price);
  if (t.patrons != null) parts.push(compact(t.patrons) + ' members');
  return parts.join(' · ');
}

/**
 * Monthly cents the signed-in account pledges to [cid]; null when unknown (signed out, not a
 * member, request failed). Patreon's member resource omits the tier itself, only the amount.
 */
async function myPledgeCents(cid) {
  if (!(await isSignedIn())) return null;
  try {
    const json = await apiGet(
      API + '/current_user?' + qs({
        include: 'active_memberships.campaign',
        'fields[user]': 'full_name',
        'fields[member]': 'patron_status,currently_entitled_amount_cents,campaign',
        'fields[campaign]': 'name',
        'json-api-version': '1.0',
      }),
      'membership',
    );
    const member = (json.included || []).filter(function (it) {
      return it.type === 'member' && relIds(it, 'campaign').indexOf(String(cid)) >= 0;
    })[0];
    const cents = member && member.attributes && member.attributes.currently_entitled_amount_cents;
    return typeof cents === 'number' ? cents : null;
  } catch (e) {
    return null;
  }
}

/** The tier a pledge of [cents] gets: the priciest tier it covers. */
function tierForCents(tiers, cents) {
  return tiers.filter(function (t) {
    return t.cents <= cents;
  }).sort(function (a, b) {
    return b.cents - a.cents;
  })[0] || null;
}

/** Creator page Membership tab: your tier and its benefits first, then the other tiers with join links. */
async function membershipTab(cid) {
  const camp = await campaign(cid);
  const manage = camp.url.replace(/\/$/, '') + '/membership';
  const status = await memberStatus(cid);
  const cents = status ? await myPledgeCents(cid) : null;
  const tier = tierForCents(camp.tiers, cents != null ? cents : status === 'free' ? 0 : -1);
  const mine = tier ? [tier] : [];
  const yours = { heading: 'Your membership', links: [{ label: 'Manage on Patreon', url: manage }] };
  if (mine.length) {
    yours.title = tierHead(mine[0], camp.payPer);
    yours.text = mine[0].description;
  } else if (status === 'paid') {
    yours.title = 'Paid member';
    yours.text = 'Patreon did not say which tier you are on.';
  } else if (status === 'free') {
    yours.title = 'Free member';
  } else if (await isSignedIn()) {
    yours.title = 'Not a member';
    yours.links = [];
  } else {
    yours.title = 'Signed out';
    yours.text = 'Sign in to see your membership.';
    yours.links = [];
  }
  const others = camp.tiers.filter(function (t) {
    return mine.indexOf(t) < 0;
  });
  const sections = [yours].concat(
    others.map(function (t, i) {
      return {
        heading: i === 0 ? 'More tiers' : '',
        collapsed: i === 0,
        title: tierHead(t, camp.payPer),
        text: t.description,
        links: [{ label: t.cents ? 'Join ' + t.title : 'Join for free', url: t.url || manage }],
      };
    }),
  );
  const badge = memberTone(status);
  return { cover: camp.cover, badges: badge ? [badge] : [], sections: sections };
}

/** 'paid' (active patron), 'free' (former patron or free member), or '' (not a member / not synced). */
async function memberStatus(cid) {
  try {
    const members = JSON.parse((await flow.storage.get('members')) || '{}');
    if (!(cid in members)) return '';
    return members[cid] === 'active_patron' ? 'paid' : 'free';
  } catch (e) {
    return '';
  }
}

/** Patreon's wording: paid in green, free in red. */
function memberTone(status) {
  if (status === 'paid') return { label: 'Paid', tone: 'positive' };
  if (status === 'free') return { label: 'Free', tone: 'negative' };
  return null;
}

async function memberBadge(cid) {
  const status = await memberStatus(cid);
  return status === 'paid' ? 'Paid member' : status === 'free' ? 'Free member' : '';
}

// --- Post body --------------------------------------------------------------------------------

function markup(text, marks) {
  let out = text;
  (marks || []).forEach(function (m) {
    const t = m && m.type;
    if (t === 'bold' || t === 'strong') out = '<strong>' + out + '</strong>';
    else if (t === 'italic' || t === 'em') out = '<em>' + out + '</em>';
    else if (t === 'underline') out = '<u>' + out + '</u>';
    else if (t === 'strike') out = '<s>' + out + '</s>';
    else if (t === 'code') out = '<code>' + out + '</code>';
    else if (t === 'link') {
      const href = m.attrs && m.attrs.href;
      if (href && /^https?:\/\//i.test(href)) out = '<a href="' + esc(href) + '">' + out + '</a>';
    }
  });
  return out;
}

/** Patreon's rich-text document (`content_json_string`, ProseMirror-style) as HTML. */
function docToHtml(node, captions) {
  if (!node) return '';
  if (Array.isArray(node)) {
    return node
      .map(function (n) {
        return docToHtml(n, captions);
      })
      .join('');
  }
  const inner = function () {
    return docToHtml(node.content || [], captions);
  };
  const attrs = node.attrs || {};
  switch (node.type) {
    case 'text':
      return markup(esc(node.text || ''), node.marks);
    case 'paragraph':
      return '<p>' + inner() + '</p>';
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attrs.level) || 2));
      return '<h' + level + '>' + inner() + '</h' + level + '>';
    }
    case 'hardBreak':
      return '<br>';
    case 'horizontalRule':
      return '<hr>';
    case 'bulletList':
      return '<ul>' + inner() + '</ul>';
    case 'orderedList':
      return '<ol>' + inner() + '</ol>';
    case 'listItem':
      return '<li>' + inner() + '</li>';
    case 'blockquote':
      return '<blockquote>' + inner() + '</blockquote>';
    case 'codeBlock':
      return '<pre>' + inner() + '</pre>';
    case 'image': {
      const caption = captions && attrs.caption ? '<figcaption>' + esc(attrs.caption) + '</figcaption>' : '';
      const img = attrs.src && /^https?:\/\//i.test(attrs.src) ? '<img src="' + esc(attrs.src) + '" alt="' + esc(attrs.alt || '') + '">' : '';
      return img || caption ? '<figure>' + img + caption + '</figure>' : '';
    }
    default:
      return inner();
  }
}

function postHtml(attrs, captions) {
  if (attrs.content && String(attrs.content).trim()) {
    const html = String(attrs.content);
    return captions ? html : html.replace(/<figcaption[\s\S]*?<\/figcaption>/gi, '');
  }
  if (!attrs.content_json_string) return '';
  try {
    return docToHtml(JSON.parse(attrs.content_json_string), captions);
  } catch (e) {
    return '';
  }
}

function attachmentsHtml(json) {
  const files = (json.included || []).filter(function (it) {
    const a = it.attributes || {};
    return it.type === 'media' && a.download_url && /^https?:\/\//i.test(a.download_url);
  });
  if (!files.length) return '';
  return (
    '<p>Attachments:</p><ul>' +
    files
      .map(function (it) {
        const a = it.attributes;
        return '<li><a href="' + esc(a.download_url) + '">' + esc(a.file_name || 'file') + '</a></li>';
      })
      .join('') +
    '</ul>'
  );
}

async function rememberAccess(cid, id, view) {
  if (!cid) return;
  const idx = await loadIndex(cid);
  const e = idx.posts[id];
  if (!e || (e.v === view && (e.e || !view))) return;
  e.v = view;
  e.e = e.e || view;
  await saveIndex(cid, idx);
}

/** Story for a creator, collection, or post link: a post opens its collection when it has exactly one. */
async function resolveWorkUrl(url) {
  if (HOSTS.indexOf(hostOf(url)) < 0) return null;
  const path = pathOf(url);
  const m = /^\/collection\/(\d+)/.exec(path);
  if (m) {
    const json = await apiGet(
      API + '/collection/' + m[1] + '?' + qs({ include: 'campaign', 'fields[collection]': 'title', 'json-api-version': '1.0' }),
      'collection',
    );
    const cid = relIds(json.data, 'campaign')[0];
    return cid ? workIdOf(cid, 'collection', m[1]) : null;
  }
  const postId = postIdOf(url);
  if (postId) {
    const json = await apiGet(
      API + '/posts/' + postId + '?' + qs({ include: 'campaign,collections', 'fields[post]': 'title', 'json-api-version': '1.0' }),
      'post',
    );
    const cid = relIds(json.data, 'campaign')[0];
    if (!cid) return null;
    const cols = relIds(json.data, 'collections');
    return cols.length === 1 ? workIdOf(cid, 'collection', cols[0]) : cid;
  }
  const segs = path.split('/').filter(Boolean);
  let vanity = null;
  if ((segs[0] === 'c' || segs[0] === 'cw') && segs[1]) vanity = segs[1];
  else if (segs.length && RESERVED_PATHS.indexOf(segs[0].toLowerCase()) < 0) vanity = segs[0];
  return vanity ? vanityCampaign(decodeURIComponent(vanity)) : null;
}

// --- Contract ---------------------------------------------------------------------------------

module.exports = {
  async search(query, page) {
    page = Math.max(1, page || 1);
    const q = String(query || '').trim();
    if (!q) return { items: [], hasMore: false };
    let expanded = null;
    if (page === 1) {
      if (/^https?:\/\//i.test(q)) {
        const direct = await resolveWorkUrl(q);
        return { items: direct ? await candidates(parseWorkId(direct).cid) : [], hasMore: false };
      }
      if (!/\s/.test(q)) expanded = await vanityCampaign(q.replace(/^@/, ''));
    }
    const json = await apiGet(API + '/search?' + qs({ q: q, 'page[number]': page, 'json-api-version': '1.0' }), 'search');
    const creators = (json.data || [])
      .filter(function (d) {
        return /^campaign/.test(d.type || '') || /^campaign_/.test(String(d.id));
      })
      .map(function (d) {
        const a = d.attributes || {};
        const stats = [];
        if (a.post_statistics && a.post_statistics.total != null) {
          stats.push({ icon: 'pages', value: String(a.post_statistics.total), label: 'Posts' });
        }
        if (a.patron_count != null) stats.push({ icon: 'followers', value: compact(a.patron_count), label: 'Patrons' });
        return {
          id: String(d.id).replace(/^campaign_/, ''),
          title: a.name || a.creator_name || 'Patreon creator',
          url: a.url || '',
          author: a.creator_name || a.name || '',
          cover: a.avatar_photo_url || a.thumb || '',
          subtitle: a.creation_name || '',
          badges: a.is_nsfw ? ['18+'] : [],
          stats: stats,
        };
      });
    if (page === 1 && !expanded) {
      const exact = creators.filter(function (c) {
        return c.title.toLowerCase() === q.toLowerCase();
      })[0];
      if (exact) expanded = exact.id;
    }
    if (!expanded) return { items: creators, hasMore: !!nextLink(json) };
    const items = (await candidates(expanded)).concat(
      creators.filter(function (c) {
        return c.id !== expanded;
      }),
    );
    return { items: items, hasMore: !!nextLink(json) };
  },

  async list(listId, page) {
    if (listId !== 'memberships') throw flow.error('UNSUPPORTED', 'Patreon cannot sync this list');
    if (Math.max(1, page || 1) > 1) return { items: [], hasMore: false };
    const res = await apiFetch(
      API + '/current_user?' + qs({
        include: 'active_memberships.campaign',
        'fields[user]': 'full_name',
        'fields[member]': 'patron_status',
        'fields[campaign]': 'name,url,avatar_photo_url,creation_name',
        'json-api-version': '1.0',
      }),
    );
    if (res.status === 401 || res.status === 403) {
      await flow.secrets.remove('account');
      throw flow.error('AUTH_REQUIRED', 'Sign in to Patreon to sync your memberships');
    }
    if (res.status < 200 || res.status >= 300) throw flow.error('NETWORK', 'Patreon memberships returned HTTP ' + res.status);
    let json;
    try {
      json = JSON.parse(res.text);
    } catch (e) {
      throw flow.error('PARSE', 'Patreon memberships were not JSON');
    }
    const included = json.included || [];
    const camps = {};
    included.forEach(function (it) {
      if (it.type === 'campaign') camps[String(it.id)] = it.attributes || {};
    });
    const statuses = {};
    included.forEach(function (it) {
      if (it.type !== 'member') return;
      relIds(it, 'campaign').forEach(function (cid) {
        statuses[cid] = (it.attributes && it.attributes.patron_status) || null;
      });
    });
    await flow.storage.set('members', JSON.stringify(statuses));
    const cids = Object.keys(statuses).filter(function (cid) {
      return camps[cid];
    });
    const news = await feedNews(cids);
    const items = cids.map(function (cid) {
      const a = camps[cid];
      const n = news[cid];
      const badges = [];
      if (n && n.count) badges.push(n.count + (n.more ? '+' : '') + ' new');
      const paid = statuses[cid] === 'active_patron';
      badges.push(memberTone(paid ? 'paid' : 'free'));
      const stats = n && n.latest ? [{ icon: 'schedule', value: n.latest.slice(0, 10), label: 'Latest' }] : [];
      return {
        id: cid,
        title: a.name || 'Patreon creator',
        url: a.url || '',
        author: a.name || '',
        cover: a.avatar_photo_url || '',
        subtitle: a.creation_name || '',
        badges: badges,
        stats: stats,
        group: paid ? 'Paid' : 'Free',
      };
    });
    // Paid memberships first; then creators with new posts, then the most recently active.
    items.sort(function (x, y) {
      if (x.group !== y.group) return x.group === 'Paid' ? -1 : 1;
      const nx = news[x.id] || {};
      const ny = news[y.id] || {};
      if (!nx.count !== !ny.count) return ny.count ? 1 : -1;
      const lx = nx.latest || '';
      const ly = ny.latest || '';
      return lx === ly ? 0 : lx < ly ? 1 : -1;
    });
    return { items: items, hasMore: false };
  },

  async browse(id, page, sort, tab) {
    const cid = parseWorkId(id).cid;
    tab = BROWSE_TABS.some(function (t) {
      return t.id === tab;
    })
      ? tab
      : 'about';
    page = Math.max(1, page || 1);
    if (page === 1) await markSeen(cid, new Date().toISOString());
    const base = { tabs: BROWSE_TABS, tab: tab, items: [], hasMore: false };
    if (tab === 'posts') return Object.assign(base, { storyId: workIdOf(cid, 'all', '') });
    if (tab === 'about') return Object.assign(base, await aboutTab(cid));
    if (tab === 'membership') return Object.assign(base, await membershipTab(cid));

    sort = BROWSE_SORTS.some(function (s) {
      return s.id === sort;
    })
      ? sort
      : 'latest';
    const s = await storyGroups(cid);
    const sorted = sortGroups(
      s.groups.filter(function (g) {
        return g.kind !== 'all';
      }),
      sort,
    );
    const start = (page - 1) * BROWSE_PAGE;
    return Object.assign(base, {
      items: sorted.slice(start, start + BROWSE_PAGE).map(function (g) {
        return Object.assign(candidate(s.camp, g.kind, g.key, g.title, g.label, g.posts), { group: TYPE_GROUP[g.kind] });
      }),
      hasMore: sorted.length > start + BROWSE_PAGE,
      sorts: BROWSE_SORTS,
      sort: sort,
      groups: [
        { title: TYPE_GROUP.collection, empty: s.camp.name + ' hasn\'t set up any collections.' },
        {
          title: TYPE_GROUP.tag,
          empty: s.tagged ? 'No tag is shared by ' + MIN_TAG_POSTS + ' or more posts.' : s.camp.name + ' hasn\'t tagged any posts.',
        },
      ],
    });
  },

  async loadWork(workId) {
    const w = parseWorkId(workId);
    const camp = await campaign(w.cid);
    const idx = await refreshIndex(w.cid);
    let col = null;
    let colIds = null;
    if (w.kind === 'collection') {
      let cols;
      try {
        cols = await collections(w.cid);
      } catch (e) {
        cols = await cachedCollections(w.cid);
      }
      col = cols.filter(function (c) {
        return c.id === w.key;
      })[0];
      if (col) {
        colIds = {};
        col.postIds.forEach(function (id) {
          colIds[id] = true;
        });
      }
    }
    const posts = selectPosts(idx, w, colIds);
    if (!posts.length) {
      throw flow.error('PARSE', idx.complete ? 'This story has no posts you can read' : 'Still reading this creator\'s posts. Try again.');
    }

    const tagNames = [];
    posts.forEach(function (p) {
      (p.e.g || []).forEach(function (t) {
        if (tagNames.indexOf(t) < 0) tagNames.push(t);
      });
    });
    let title = camp.name;
    if (w.kind === 'collection') title = col ? col.title : 'Collection';
    if (w.kind === 'tag') {
      const tag = tagNames.filter(function (t) {
        return hash(t.toLowerCase()) === w.key;
      })[0];
      title = '#' + (tag || 'tag');
    }

    const locked = posts.filter(function (p) {
      return !p.e.v;
    }).length;
    const stats = [{ icon: 'pages', value: String(posts.length), label: 'Posts' }];
    const latest = latestDate(posts);
    if (latest) stats.push({ icon: 'schedule', value: latest, label: 'Latest' });
    if (camp.patrons != null) stats.push({ icon: 'followers', value: compact(camp.patrons), label: 'Patrons' });
    const badges = [{ all: 'All posts', collection: 'Collection', tag: 'Tag' }[w.kind]];
    const member = await memberBadge(w.cid);
    if (member) badges.push(member);
    if (locked) badges.push(locked + ' locked');
    const links = [{ label: camp.name + ' on Patreon', url: camp.url }];
    if (w.kind === 'collection') links.push({ label: 'Collection', url: ORIGIN + '/collection/' + w.key });

    return {
      id: workIdOf(w.cid, w.kind, w.key),
      title: title,
      url: w.kind === 'collection' ? ORIGIN + '/collection/' + w.key : camp.url,
      author: camp.name,
      cover: (col && col.thumb) || camp.cover,
      synopsis: (col && col.description) || camp.summary || camp.creation,
      tags: tagNames.slice(0, 8),
      chapters: posts.map(chapterRef),
      card: { stats: stats, badges: badges, links: links },
    };
  },

  async loadChapter(chapter, work) {
    const id = (chapter && chapter.id) || postIdOf(chapter && chapter.url);
    if (!id) throw flow.error('PARSE', 'Not a Patreon post: ' + (chapter && chapter.url));
    const json = await apiGet(
      API + '/posts/' + id + '?' + qs({
        'fields[post]': 'title,content,content_json_string,current_user_can_view,post_type,url',
        include: 'campaign,attachments_media',
        'fields[media]': 'file_name,download_url,mimetype',
        'json-api-version': '1.0',
      }),
      'post',
    );
    const a = (json.data && json.data.attributes) || {};
    const view = !!a.current_user_can_view;
    const cid = relIds(json.data, 'campaign')[0] || (work && work.id ? parseWorkId(work.id).cid : '');
    await rememberAccess(cid, String(id), view);
    if (!view) {
      if (!(await isSignedIn())) throw flow.error('AUTH_REQUIRED', 'Sign in to Patreon to read this post');
      throw flow.error('UNSUPPORTED', 'Your Patreon membership does not include this post');
    }
    let html = postHtml(a, flow.settings.imageCaptions !== false) + attachmentsHtml(json);
    if (!htmlText(html)) {
      const url = a.url || postUrl(id);
      html = '<p>This post has no text. Open it on Patreon: <a href="' + esc(url) + '">' + esc(url) + '</a></p>';
    }
    return { title: a.title || (chapter && chapter.title) || 'Patreon post', html: html };
  },

  async session() {
    let res;
    try {
      res = await apiFetch(API + '/current_user?' + qs({ 'fields[user]': 'full_name,email', 'json-api-version': '1.0' }));
    } catch (e) {
      const cached = await flow.secrets.get('account');
      return { loggedIn: !!cached, account: cached || '' };
    }
    if (res.status === 401 || res.status === 403) {
      await flow.secrets.remove('account');
      return { loggedIn: false };
    }
    if (res.status < 200 || res.status >= 300) {
      const cached = await flow.secrets.get('account');
      return { loggedIn: !!cached, account: cached || '' };
    }
    try {
      const a = (JSON.parse(res.text).data || {}).attributes || {};
      const account = a.full_name || a.email || 'Patreon';
      await flow.secrets.set('account', account);
      return { loggedIn: true, account: account };
    } catch (e) {
      return { loggedIn: false };
    }
  },

  async logout() {
    await flow.cookies.clear();
    await flow.secrets.clear();
    await flow.storage.remove('members');
    await flow.storage.remove('seen');
  },

  async setMembership(workId, listId, on) {
    // Joining or leaving a creator is a payment decision made on Patreon; lists stay local.
    return false;
  },

  async resolveUrl(url) {
    return resolveWorkUrl(url);
  },

  async checkUpdates(works) {
    works = Array.isArray(works) ? works : [];
    const groups = {};
    works.forEach(function (w) {
      let parsed;
      try {
        parsed = parseWorkId(w && w.id);
      } catch (e) {
        return;
      }
      (groups[parsed.cid] = groups[parsed.cid] || []).push({ id: String(w.id), w: parsed });
    });
    const cids = Object.keys(groups);
    const covered = {};

    // Signed in: the home feed shows new posts from every membership at once.
    if (cids.length && (await isSignedIn())) {
      try {
        const members = JSON.parse((await flow.storage.get('members')) || '{}');
        const byCid = {};
        let oldest = '';
        let url = API + '/stream?' + qs({
          include: 'campaign,user_defined_tags,collections',
          'fields[post]': POST_FIELDS,
          'fields[campaign]': 'name',
          'fields[post_tag]': 'value',
          'page[count]': 50,
          'json-api-version': '1.0',
        });
        for (let page = 0; url && page < STREAM_PAGES; page++) {
          const json = await apiGet(url, 'feed');
          (json.data || []).forEach(function (p) {
            const cid = relIds(p, 'campaign')[0];
            if (!cid) return;
            (byCid[cid] = byCid[cid] || { data: [], included: json.included || [] }).data.push(p);
            const at = (p.attributes && p.attributes.published_at) || '';
            if (at && (!oldest || at < oldest)) oldest = at;
          });
          url = nextLink(json);
        }
        for (let i = 0; i < cids.length; i++) {
          const cid = cids[i];
          if (!(cid in members) || !oldest) continue;
          const idx = await loadIndex(cid);
          if (!idx.complete) continue;
          const newest = Object.keys(idx.posts).reduce(function (m, id) {
            return idx.posts[id].p > m ? idx.posts[id].p : m;
          }, '');
          if (byCid[cid]) {
            mergePosts(idx, byCid[cid].data, byCid[cid].included);
            await saveIndex(cid, idx);
          }
          if (newest && newest >= oldest) covered[cid] = true;
        }
      } catch (e) {
        // Feed unavailable: every creator gets its own check below.
      }
    }

    const out = [];
    for (let i = 0; i < cids.length; i++) {
      const cid = cids[i];
      let idx;
      try {
        idx = covered[cid] ? await loadIndex(cid) : await refreshIndex(cid, { quick: true, maxPages: 1 });
      } catch (e) {
        continue;
      }
      const cols = groups[cid].some(function (g) {
        return g.w.kind === 'collection';
      })
        ? await cachedCollections(cid)
        : [];
      groups[cid].forEach(function (g) {
        let colIds = null;
        if (g.w.kind === 'collection') {
          const col = cols.filter(function (c) {
            return c.id === g.w.key;
          })[0];
          if (col) {
            colIds = {};
            col.postIds.forEach(function (id) {
              colIds[id] = true;
            });
          }
        }
        const posts = selectPosts(idx, g.w, colIds);
        if (!posts.length) return;
        out.push({ id: g.id, chapters: posts.length, latestUrl: postUrl(posts[posts.length - 1].id) });
      });
    }
    return out;
  },
};
