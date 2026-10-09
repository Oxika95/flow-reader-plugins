import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPlugin } from './host.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'RoyalRoad');
const ORIGIN = 'https://www.royalroad.com';

function plugin(pages, opts = {}) {
  return loadPlugin(DIR, {
    ...opts,
    routes: (url, reqOpts) => {
      const hit = typeof pages === 'function' ? pages(url, reqOpts) : pages[url];
      if (hit == null) return null;
      return typeof hit === 'string' ? { text: hit } : hit;
    },
  });
}

const FICTION_PAGE = `
<html><head><link rel="canonical" href="${ORIGIN}/fiction/1/demo" /></head><body>
<div class="fic-header">
  <h1>Demo Fiction</h1>
  <h4 class="font-white"><span><a href="/profile/1">Author Name</a></span></h4>
  <div class="cover-art-container"><img src="/covers/demo.jpg" /></div>
</div>
<div class="col-md-8"><div class="margin-bottom-10"><span class="label">Ongoing</span></div></div>
<ul class="list-unstyled"><li>Pages: 10</li><li>12,345</li></ul>
<span class="font-red-sunglo" data-content="4.55/5"></span>
<span class="tags"><a>Fantasy</a><a>Adventure</a></span>
<div class="description"><div class="hidden-content"><p>A short synopsis.</p></div></div>
<script>
window.chapters = [
  {"id":1,"title":"Chapter 1","url":"/fiction/1/demo/chapter/1/c1"},
  {"id":2,"title":"Life\\u2019s Little Problems","url":"/fiction/1/demo/chapter/2/c2"}
];
</script>
</body></html>`;

test('manifest matches the app contract', () => {
  const { manifest } = plugin({});
  assert.equal(manifest.id, 'royalroad');
  assert.equal(manifest.bookIdPrefix, 'rr');
  assert.equal(manifest.apiVersion, 4);
  assert.ok(manifest.capabilities.includes('updates'));
  assert.deepEqual(
    manifest.lists.map((l) => l.id),
    ['follow', 'favorite', 'readlater'],
  );
});

test('loadWork parses metadata and the full ToC', async () => {
  const { api } = plugin({ [`${ORIGIN}/fiction/1`]: { url: `${ORIGIN}/fiction/1/demo`, text: FICTION_PAGE } });
  const work = await api.loadWork('1');
  assert.equal(work.id, '1');
  assert.equal(work.title, 'Demo Fiction');
  assert.equal(work.author, 'Author Name');
  assert.equal(work.synopsis, 'A short synopsis.');
  assert.deepEqual(work.tags, ['Fantasy', 'Adventure']);
  assert.deepEqual(work.card.stats, [
    { icon: 'star', value: '4.55', label: 'Rating' },
    { icon: 'eye', value: '12k', label: 'Views' },
  ]);
  assert.deepEqual(work.card.badges, ['Ongoing']);
  assert.equal(work.status, undefined);
  assert.equal(work.cover, `${ORIGIN}/covers/demo.jpg`);
  assert.equal(work.chapters.length, 2);
  assert.equal(work.chapters[1].title, 'Life\u2019s Little Problems');
  assert.equal(work.chapters[1].url, `${ORIGIN}/fiction/1/demo/chapter/2/c2`);
});

test('loadWork returns media card slots', async () => {
  const html = FICTION_PAGE.replace(
    '<ul class="list-unstyled"><li>Pages: 10</li><li>12,345</li></ul>',
    `<ul class="list-unstyled">
      <li>Total Views :</li><li>1,234,567</li>
      <li>Average Views :</li><li>9,000</li>
      <li>Followers :</li><li>12,345</li>
      <li>Favorites :</li><li>987</li>
    </ul>`,
  );
  const { api } = plugin({ [`${ORIGIN}/fiction/1`]: { url: `${ORIGIN}/fiction/1/demo`, text: html } });
  const work = await api.loadWork('1');
  assert.deepEqual(work.card.stats, [
    { icon: 'star', value: '4.55', label: 'Rating' },
    { icon: 'followers', value: '12k', label: 'Followers' },
    { icon: 'heart', value: '987', label: 'Favorites' },
    { icon: 'eye', value: '1.2M', label: 'Views' },
  ]);
  assert.deepEqual(work.card.badges, ['Ongoing']);
  assert.equal(work.card.links, undefined, 'author is already under the title');
});

test('loadWork falls back to the legacy chapter table', async () => {
  const html = `<html><body><h1>Old</h1><table id="chapters">
    <tr data-url="/fiction/1/demo/chapter/9/start"><td><a href="/fiction/1/demo/chapter/9/start">Start</a></td></tr>
  </table></body></html>`;
  const { api } = plugin({ [`${ORIGIN}/fiction/1`]: { url: `${ORIGIN}/fiction/1/demo`, text: html } });
  const work = await api.loadWork('1');
  assert.deepEqual(work.chapters, [{ title: 'Start', url: `${ORIGIN}/fiction/1/demo/chapter/9/start` }]);
});

test('loadWork without chapters is a PARSE error', async () => {
  const { api } = plugin({ [`${ORIGIN}/fiction/1`]: '<html><body><p>No chapters</p></body></html>' });
  await assert.rejects(api.loadWork('1'), { code: 'PARSE' });
});

test('loadChapter strips watermarks and appends author notes', async () => {
  const url = `${ORIGIN}/fiction/1/demo/chapter/9/start`;
  const html = `<html><head><style>.csecret { display: none; speak: never; }</style></head><body>
    <h1 class="font-white">The First Day</h1>
    <div class="chapter-inner">
      <p>Hello <span class="csecret">WATERMARK</span> world.</p>
      <p style="display:none">Hidden inline.</p>
      <p>Second.</p>
      <div class="nav-buttons"><a class="btn" href="#">Next</a></div>
    </div>
    <div class="portlet solid author-note-portlet">
      <div class="portlet-title"><span class="caption-subject">A note from Alice</span></div>
      <div class="portlet-body author-note"><p>Note here.</p></div>
    </div>
  </body></html>`;
  const { api } = plugin({ [url]: html });
  const ch = await api.loadChapter({ title: 'Start', url }, { id: '1', url: `${ORIGIN}/fiction/1/demo` });
  assert.equal(ch.title, 'The First Day');
  assert.match(ch.html, /Hello/);
  assert.match(ch.html, /Second\./);
  assert.doesNotMatch(ch.html, /WATERMARK|Hidden inline|Next/);
  assert.match(ch.html, /<h3>A note from Alice<\/h3>/);
  assert.match(ch.html, /Note here\./);
});

test('loadChapter honours the authorNotes setting', async () => {
  const url = `${ORIGIN}/fiction/1/demo/chapter/9/start`;
  const html = `<div class="chapter-inner"><p>Body.</p></div>
    <div class="author-note-portlet"><div class="author-note"><p>Note here.</p></div></div>`;
  const { api } = plugin({ [url]: html }, { settings: { authorNotes: false } });
  const ch = await api.loadChapter({ title: 'x', url }, { id: '1', url: '' });
  assert.doesNotMatch(ch.html, /Note here/);
});

test('loadChapter accepts the older chapter-content wrapper and rejects missing bodies', async () => {
  const a = `${ORIGIN}/fiction/1/demo/chapter/1/a`;
  const b = `${ORIGIN}/fiction/1/demo/chapter/2/b`;
  const { api } = plugin({
    [a]: '<h1>T</h1><div class="chapter-content"><p>Hello world.</p></div>',
    [b]: '<p>No chapter wrapper</p>',
  });
  assert.match((await api.loadChapter({ title: '', url: a }, null)).html, /Hello world/);
  await assert.rejects(api.loadChapter({ title: '', url: b }, null), { code: 'PARSE' });
});

test('search parses fiction list items and paging', async () => {
  const html = `<html><body>
    <div class="fiction-list-item">
      <figure><img data-type="cover" src="https://cdn.example/cover.jpg" /></figure>
      <h2 class="fiction-title"><a href="/fiction/21220/mother-of-learning">Mother of Learning</a></h2>
      <div class="stats"><span>109 Chapters</span></div>
    </div>
    <div class="fiction-list-item">
      <img class="img-responsive" src="/dist/img/nocover-new-min.png" />
      <h2 class="fiction-title"><a href="/fiction/5/other">Other</a></h2>
    </div>
    <ul class="pagination"><li><a data-page="2" href="?title=mother&page=2">2</a></li></ul>
  </body></html>`;
  const { api, requests } = plugin({ [`${ORIGIN}/fictions/search?title=mother%20of`]: html });
  const page = await api.search('mother of', 1);
  assert.equal(requests[0].url, `${ORIGIN}/fictions/search?title=mother%20of`);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.items[0], {
    id: '21220',
    title: 'Mother of Learning',
    url: `${ORIGIN}/fiction/21220/mother-of-learning`,
    author: '',
    cover: 'https://cdn.example/cover.jpg',
    subtitle: '109 Chapters',
  });
  assert.equal(page.items[1].cover, '');
});

test('list requires sign-in and pages through follows', async () => {
  const html = `<div class="fiction-list-item"><h2 class="fiction-title"><a href="/fiction/7/x">X</a></h2></div>
    <script>window.royalroad.userId = 42;</script>`;
  const signedOut = plugin({});
  await assert.rejects(signedOut.api.list('follow', 1), { code: 'AUTH_REQUIRED' });

  const { api } = plugin({ [`${ORIGIN}/my/follows?page=1`]: html }, { secrets: { loggedIn: 'true' } });
  const page = await api.list('follow', 1);
  assert.deepEqual(page.items.map((w) => w.id), ['7']);
  assert.equal(page.hasMore, false);
  await assert.rejects(api.list('other', 1), { code: 'UNSUPPORTED' });
});

test('favorites and read later sync from their own pages', async () => {
  const row = (id) => `<div class="fiction-list-item"><h2 class="fiction-title"><a href="/fiction/${id}/x">X${id}</a></h2></div>
    <script>window.royalroad.userId = 42;</script>`;
  const { api } = plugin(
    { [`${ORIGIN}/my/favorites?page=1`]: row(8), [`${ORIGIN}/my/readlater?page=1`]: row(9) },
    { secrets: { loggedIn: 'true' } },
  );
  assert.deepEqual((await api.list('favorite', 1)).items.map((w) => w.id), ['8']);
  assert.deepEqual((await api.list('readlater', 1)).items.map((w) => w.id), ['9']);
});

test('an expired session raises AUTH_REQUIRED and marks the plugin signed out', async () => {
  const loginPage = '<form class="form-login-details"></form><script>window.royalroad.userId = 0;</script>';
  const host = plugin({ [`${ORIGIN}/my/follows?page=1`]: loginPage }, { secrets: { loggedIn: 'true' } });
  await assert.rejects(host.api.list('follow', 1), { code: 'AUTH_REQUIRED' });
  assert.equal(host.secrets.get('loggedIn'), 'false');
});

test('manifest signs in on the site, not with a password form', () => {
  const host = plugin({});
  assert.equal(host.manifest.auth.fields, undefined);
  assert.equal(host.manifest.auth.web.url, `${ORIGIN}/account/login`);
  assert.equal(host.manifest.auth.web.doneCookie, '.AspNetCore.Identity.Application');
  assert.equal(host.api.login, undefined);
});

test('session reads the signed-in user from the home page', async () => {
  const home = `<ul class="dropdown-menu"><li><a href="/profile/42">My Profile</a></li></ul>
    <script>window.royalroad.userId = 42;
    window.royalroad.username = "Reader Name";</script>`;
  const host = plugin({ [`${ORIGIN}/home`]: home });
  assert.deepEqual(await host.api.session(), { loggedIn: true, account: 'Reader Name' });
  assert.equal(host.secrets.get('loggedIn'), 'true');
  assert.equal(host.secrets.get('account'), 'Reader Name');
});

test('session falls back to a generic account name when the username is missing', async () => {
  const host = plugin({ [`${ORIGIN}/home`]: '<script>window.royalroad.userId = 42; window.royalroad.username = "";</script>' });
  assert.deepEqual(await host.api.session(), { loggedIn: true, account: 'Royal Road' });
});

test('session reports signed out and clears state when the cookies are not accepted', async () => {
  const home = '<a href="/account/login">Log in</a><script>window.royalroad.userId = 0;</script>';
  const host = plugin({ [`${ORIGIN}/home`]: home }, { secrets: { loggedIn: 'true', account: 'Reader Name' } });
  assert.deepEqual(await host.api.session(), { loggedIn: false, account: '' });
  assert.equal(host.secrets.size, 0);
});

test('session keeps the last known state when Royal Road is unreachable', async () => {
  const host = plugin({ [`${ORIGIN}/home`]: { status: 503, text: '' } }, { secrets: { loggedIn: 'true', account: 'Reader Name' } });
  assert.deepEqual(await host.api.session(), { loggedIn: true, account: 'Reader Name' });
});

test('logout clears cookies and secrets', async () => {
  const host = plugin({}, { secrets: { loggedIn: 'true', email: 'me' } });
  await host.api.logout();
  assert.equal(host.cookiesCleared, 1);
  assert.equal(host.secrets.size, 0);
  assert.deepEqual(await host.api.session(), { loggedIn: false, account: '' });
});

// Fiction page toggles as Royal Road renders them: `mark` is what submitting would set.
const bookmarkForms = (marks) =>
  Object.entries(marks)
    .map(
      ([type, mark]) => `<form method="post" action="/fictions/setbookmark/21220">
      <input type="hidden" name="type" value="${type}" /><input type="hidden" name="mark" value="${mark}" />
      <button class="button-icon-large toggle"></button>
      <input name="__RequestVerificationToken" type="hidden" value="${type}-token" /></form>`,
    )
    .join('\n') + '<script>window.royalroad.userId = 42;</script>';

function bookmarkHost(marks, opts = { secrets: { loggedIn: 'true' } }) {
  const routes = (url, reqOpts) => {
    if (url === `${ORIGIN}/fiction/21220`) return { url: `${ORIGIN}/fiction/21220/mol`, text: bookmarkForms(marks) };
    if (url === `${ORIGIN}/fictions/setbookmark/21220` && reqOpts.method === 'POST') return 'ok';
    return null;
  };
  return plugin(routes, opts);
}

test('setMembership adds with the list type (Read Later is "ril")', async () => {
  const host = bookmarkHost({ follow: 'False', favorite: 'True', ril: 'True' });
  assert.equal(await host.api.setMembership('21220', 'readlater', true), true);
  const post = host.requests.find((r) => r.method === 'POST');
  assert.deepEqual(post.form, { type: 'ril', mark: 'true', __RequestVerificationToken: 'ril-token' });
});

test('setMembership removes from the site', async () => {
  const host = bookmarkHost({ follow: 'False', favorite: 'True', ril: 'True' });
  assert.equal(await host.api.setMembership('21220', 'follow', false), true);
  const post = host.requests.find((r) => r.method === 'POST');
  assert.deepEqual(post.form, { type: 'follow', mark: 'false', __RequestVerificationToken: 'follow-token' });
});

test('setMembership skips the post when the site already matches', async () => {
  const host = bookmarkHost({ follow: 'False', favorite: 'True', ril: 'True' });
  assert.equal(await host.api.setMembership('21220', 'follow', true), true, 'already followed');
  assert.equal(await host.api.setMembership('21220', 'favorite', false), true, 'already not a favorite');
  assert.equal(host.requests.filter((r) => r.method === 'POST').length, 0);
});

test('setMembership without a form or session leaves the site alone', async () => {
  assert.equal(await bookmarkHost({ follow: 'True' }).api.setMembership('21220', 'favorite', true), false, 'form absent');
  assert.equal(await bookmarkHost({ follow: 'True' }).api.setMembership('21220', 'other', true), false, 'unknown list');
  assert.equal(await bookmarkHost({ follow: 'True' }, {}).api.setMembership('21220', 'follow', true), false, 'signed out');
});

test('loadChapter fetches without cookies so downloads never move Last read', async () => {
  const url = `${ORIGIN}/fiction/1/demo/chapter/1/c1`;
  const { api, requests } = plugin({ [url]: '<h1>C1</h1><div class="chapter-inner chapter-content"><p>Text</p></div>' });
  await api.loadChapter({ title: 'C1', url }, null);
  assert.equal(requests[0].cookies, false);
});

test('resolveUrl extracts fiction ids and follows short chapter links', async () => {
  const { api } = plugin({
    [`${ORIGIN}/fiction/chapter/99`]: {
      url: `${ORIGIN}/fiction/21220/mol/chapter/99/start`,
      text: '<div class="chapter-inner"><p>x</p></div>',
    },
  });
  assert.equal(await api.resolveUrl('https://www.royalroad.com/fiction/21220/mother-of-learning'), '21220');
  assert.equal(await api.resolveUrl('https://royalroadl.com/fiction/1/demo/chapter/9/start'), '1');
  assert.equal(await api.resolveUrl(`${ORIGIN}/fiction/chapter/99`), '21220');
  assert.equal(await api.resolveUrl('https://example.com/fiction/1'), null);
  assert.equal(await api.resolveUrl('not a url'), null);
});

const RSS = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Demo</title>
<link>${ORIGIN}/fiction/syndication/1</link>
<item><title>Demo - 3. Third</title><link>${ORIGIN}/fiction/chapter/300</link><guid isPermaLink="false">300</guid></item>
<item><title>Demo - 2. Second</title><link>${ORIGIN}/fiction/chapter/200</link><guid isPermaLink="false">200</guid></item>
</channel></rss>`;

const work = (id, lastChapter, chapters = 2) => ({
  id,
  url: `${ORIGIN}/fiction/${id}/demo`,
  chapters,
  lastChapterUrl: `${ORIGIN}/fiction/${id}/demo/chapter/${lastChapter}/slug`,
});

test('checkUpdates signed out reads each RSS feed and compares chapter ids', async () => {
  const { api, requests } = plugin({
    [`${ORIGIN}/fiction/syndication/1`]: RSS,
    [`${ORIGIN}/fiction/syndication/2`]: RSS,
  });
  const out = await api.checkUpdates([work('1', 200), work('2', 300)]);
  assert.deepEqual(out, [
    { id: '1', latestUrl: `${ORIGIN}/fiction/chapter/300` },
    { id: '2', latestUrl: `${ORIGIN}/fiction/2/demo/chapter/300/slug` },
  ]);
  assert.ok(requests.every((r) => r.url.includes('/syndication/')));
});

test('checkUpdates never reports a feed older than the stored ToC', async () => {
  const { api } = plugin({ [`${ORIGIN}/fiction/syndication/1`]: RSS });
  const out = await api.checkUpdates([work('1', 999)]);
  assert.deepEqual(out, [{ id: '1', latestUrl: `${ORIGIN}/fiction/1/demo/chapter/999/slug` }]);
});

test('checkUpdates signed in reads the follows page, then RSS for the rest', async () => {
  const follows = `<script>window.royalroad.userId = 42;</script>
    <div class="fiction-list-item">
      <h2 class="fiction-title"><a href="/fiction/1/demo">Demo</a></h2>
      <div class="list-item"><span>Last Update:</span> <a href="/fiction/1/demo/chapter/310/new">Chapter 4</a></div>
      <div class="list-item"><span>Last Read:</span> <a href="/fiction/1/demo/chapter/200/old">Chapter 2</a></div>
    </div>
    <div class="fiction-list-item">
      <h2 class="fiction-title"><a href="/fiction/5/count-only">Count only</a></h2>
      <div class="stats"><span>1,204 Chapters</span></div>
    </div>`;
  const { api, requests } = plugin(
    {
      [`${ORIGIN}/my/follows?page=1`]: follows,
      [`${ORIGIN}/fiction/syndication/9`]: RSS,
    },
    { secrets: { loggedIn: 'true' } },
  );
  const out = await api.checkUpdates([work('1', 200), work('5', 50, 1200), work('9', 300)]);
  assert.deepEqual(out, [
    { id: '1', latestUrl: `${ORIGIN}/fiction/1/demo/chapter/310/new` },
    { id: '5', chapters: 1204 },
    { id: '9', latestUrl: `${ORIGIN}/fiction/9/demo/chapter/300/slug` },
  ]);
  assert.equal(requests.filter((r) => r.url.includes('/my/follows')).length, 1);
});

test('checkUpdates falls back to RSS when the session expired and skips failed feeds', async () => {
  const loginPage = '<form class="form-login-details"></form><script>window.royalroad.userId = 0;</script>';
  const host = plugin(
    {
      [`${ORIGIN}/my/follows?page=1`]: loginPage,
      [`${ORIGIN}/fiction/syndication/1`]: RSS,
      [`${ORIGIN}/fiction/syndication/2`]: { status: 404, text: 'missing' },
    },
    { secrets: { loggedIn: 'true' } },
  );
  const out = await host.api.checkUpdates([work('1', 200), work('2', 200)]);
  assert.deepEqual(out, [{ id: '1', latestUrl: `${ORIGIN}/fiction/chapter/300` }]);
  assert.equal(host.secrets.get('loggedIn'), 'false');
});

test('syncProgress views the chapter signed in and throws when offline so the host retries', async () => {
  const url = `${ORIGIN}/fiction/1/demo/chapter/1/c1`;
  const host = plugin({ [url]: '<div class="chapter-inner"><p>x</p></div>' }, { secrets: { loggedIn: 'true' } });
  await host.api.syncProgress('1', { title: 'c', url });
  assert.equal(host.requests.length, 1);
  assert.equal(host.requests[0].cookies, undefined, 'sends the session');

  const offline = plugin(() => {
    throw new Error('offline');
  }, { secrets: { loggedIn: 'true' } });
  await assert.rejects(offline.api.syncProgress('1', { title: 'c', url }));

  const signedOut = plugin({});
  await signedOut.api.syncProgress('1', { title: 'c', url });
  assert.equal(signedOut.requests.length, 0);
});

test('syncProgress to an earlier chapter submits the backtrack form', async () => {
  const url = `${ORIGIN}/fiction/1/demo/chapter/5/c5`;
  const page = `<script>window.royalroad.userId = 42;</script>
    <div class="portlet light" id="rewind-container">
      It appears that you've backtracked! Do you want to move your Reading Progress to this chapter?
      <form method="post" class="rewind-form" action="/fiction/1/setprogress/chapter/5">
        <button class="btn btn-sm btn-primary">Set Progress</button>
        <input name="__RequestVerificationToken" type="hidden" value="rewind-token" /></form>
    </div>
    <div class="chapter-inner"><p>x</p></div>`;
  const host = plugin(
    (u, o) => {
      if (u === url) return page;
      if (u === `${ORIGIN}/fiction/1/setprogress/chapter/5` && o.method === 'POST') return 'ok';
      return null;
    },
    { secrets: { loggedIn: 'true' } },
  );
  await host.api.syncProgress('1', { title: 'c5', url });
  const post = host.requests.find((r) => r.method === 'POST');
  assert.equal(post.url, `${ORIGIN}/fiction/1/setprogress/chapter/5`);
  assert.deepEqual(post.form, { __RequestVerificationToken: 'rewind-token' });
});

// Follows rows as Royal Road renders them (trimmed): separate "Last read", combined, and never read.
const FOLLOWS_ROWS = `<script>window.royalroad.userId = 42;</script>
<div class="fiction-list-item row"><div class="col-sm-10">
  <h2 class="fiction-title"><a href="/fiction/10/ten" class="font-red-sunglo bold">Ten</a></h2>
  <ul class="list-unstyled margin-bottom-15">
    <li class="list-item">
Last Update:  <a href="/fiction/10/ten/chapter/1500/c15" class="bold row no-margin"><span>Chapter 15</span>
      <span><time datetime="2026-10-09T16:03:57.0000000">33 minutes</time> ago</span></a></li>
    <li class="list-item">
      Last read:  <a href="/fiction/10/ten/chapter/1200/c12" class="bold row no-margin"><span>Chapter 12</span>
      <span><time datetime="2026-10-07T12:44:10.0000000">2 days</time> ago</span></a></li>
  </ul>
  <a class="btn btn-primary" href="/chapter/next/10">Open Next Chapter</a>
</div></div>
<div class="fiction-list-item row"><div class="col-sm-10">
  <h2 class="fiction-title"><a href="/fiction/20/twenty">Twenty</a></h2>
  <ul class="list-unstyled"><li class="list-item">
Last Update &amp; Last Read:  <a href="/fiction/20/twenty/chapter/2700/c27" class="bold row no-margin"><span>Chapter 27</span></a>
  </li></ul>
</div></div>
<div class="fiction-list-item row"><div class="col-sm-10">
  <h2 class="fiction-title"><a href="/fiction/30/thirty">Thirty</a></h2>
  <ul class="list-unstyled"><li class="list-item">
Last Update:  <a href="/fiction/30/thirty/chapter/3100/c31" class="bold row no-margin"><span>Chapter 31</span></a>
  </li></ul>
</div></div>`;

const continuePage = (id, label, chapter) => `<script>window.royalroad.userId = 42;</script>
<div class="col-md-4 col-lg-3 fic-buttons text-center md-text-left">
  <a href="/fiction/${id}/x/chapter/${chapter}/c" class="btn btn-lg btn-primary">
    <i class="fa fa-play-circle"></i><span>${label} <span class="hidden-xs">Reading</span></span></a>
</div>`;

test('readPositions reads Last read from Follows and skips never-read rows', async () => {
  const host = plugin({ [`${ORIGIN}/my/follows?page=1`]: FOLLOWS_ROWS }, { secrets: { loggedIn: 'true' } });
  const out = await host.api.readPositions([work('10', 1500), work('20', 2700), work('30', 3100)]);
  assert.deepEqual(out, [
    { id: '10', chapterUrl: `${ORIGIN}/fiction/10/ten/chapter/1200/c12`, chapterTitle: 'Chapter 12' },
    { id: '20', chapterUrl: `${ORIGIN}/fiction/20/twenty/chapter/2700/c27`, chapterTitle: 'Chapter 27' },
  ]);
  assert.equal(host.requests.length, 1, 'never-read follows need no fiction page');
});

test('readPositions shares one Follows scan with checkUpdates', async () => {
  const host = plugin({ [`${ORIGIN}/my/follows?page=1`]: FOLLOWS_ROWS }, { secrets: { loggedIn: 'true' } });
  await host.api.checkUpdates([work('10', 1200)]);
  await host.api.readPositions([work('10', 1500)]);
  assert.equal(host.requests.filter((r) => r.url.includes('/my/follows')).length, 1);
});

test('readPositions fetches no fiction pages for stories off Follows', async () => {
  const host = plugin({ [`${ORIGIN}/my/follows?page=1`]: FOLLOWS_ROWS }, { secrets: { loggedIn: 'true' } });
  const out = await host.api.readPositions([work('10', 1500), work('41', 1), work('42', 1)]);
  assert.deepEqual(out.map((p) => p.id), ['10']);
  assert.equal(host.requests.length, 1);
});

test('loadWork returns the Continue chapter as readChapterUrl, not Start', async () => {
  const page = (label) => ({ url: `${ORIGIN}/fiction/1/demo`, text: FICTION_PAGE + continuePage(1, label, 2) });
  const reading = await plugin({ [`${ORIGIN}/fiction/1`]: page('Continue') }).api.loadWork('1');
  assert.equal(reading.readChapterUrl, `${ORIGIN}/fiction/1/x/chapter/2/c`);
  const unread = await plugin({ [`${ORIGIN}/fiction/1`]: page('Start') }).api.loadWork('1');
  assert.equal(unread.readChapterUrl, undefined);
});

test('readPositions signed out does nothing', async () => {
  const host = plugin({});
  assert.deepEqual(await host.api.readPositions([work('10', 1)]), []);
  assert.equal(host.requests.length, 0);
});
