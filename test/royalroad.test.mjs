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
  assert.equal(manifest.apiVersion, 2);
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
  assert.equal(work.views, 12345);
  assert.equal(work.rating, '4.55 / 5');
  assert.equal(work.status, 'Ongoing');
  assert.equal(work.cover, `${ORIGIN}/covers/demo.jpg`);
  assert.equal(work.chapters.length, 2);
  assert.equal(work.chapters[1].title, 'Life\u2019s Little Problems');
  assert.equal(work.chapters[1].url, `${ORIGIN}/fiction/1/demo/chapter/2/c2`);
});

test('loadWork returns v2 media card slots', async () => {
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
  assert.equal(work.views, 1234567);
  assert.deepEqual(work.card.stats, [
    { icon: 'star', value: '4.55', label: 'Rating' },
    { icon: 'followers', value: '12k', label: 'Followers' },
    { icon: 'heart', value: '987', label: 'Favorites' },
    { icon: 'eye', value: '1.2M', label: 'Views' },
  ]);
  assert.deepEqual(work.card.badges, ['Ongoing']);
  assert.deepEqual(work.card.links, [{ label: 'Author Name', url: `${ORIGIN}/profile/1` }]);
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

  const { api } = plugin({ [`${ORIGIN}/fictions/follows?page=1`]: html }, { secrets: { loggedIn: 'true' } });
  const page = await api.list('follow', 1);
  assert.deepEqual(page.items.map((w) => w.id), ['7']);
  assert.equal(page.hasMore, false);
  await assert.rejects(api.list('favorite', 1), { code: 'UNSUPPORTED' });
});

test('an expired session raises AUTH_REQUIRED and marks the plugin signed out', async () => {
  const loginPage = '<form class="form-login-details"></form><script>window.royalroad.userId = 0;</script>';
  const host = plugin({ [`${ORIGIN}/fictions/follows?page=1`]: loginPage }, { secrets: { loggedIn: 'true' } });
  await assert.rejects(host.api.list('follow', 1), { code: 'AUTH_REQUIRED' });
  assert.equal(host.secrets.get('loggedIn'), 'false');
});

test('login posts the verification token and stores only the session state', async () => {
  const loginUrl = `${ORIGIN}/account/login`;
  const loginForm = `<form class="form-horizontal"><input name="__RequestVerificationToken" value="oauth" /></form>
    <form method="post" class="form-login-details"><input name="__RequestVerificationToken" value="login-token" /></form>`;
  const host = plugin((url, opts) => {
    if (url !== loginUrl) return null;
    if (opts.method === 'POST') {
      return { url: `${ORIGIN}/home`, text: '<script>window.royalroad.userId = 42;</script>' };
    }
    return loginForm;
  });
  const session = await host.api.login({ email: ' me@example.com ', password: 'pw' });
  assert.deepEqual(session, { loggedIn: true, account: 'me@example.com' });
  const post = host.requests.find((r) => r.method === 'POST');
  assert.equal(post.form.__RequestVerificationToken, 'login-token');
  assert.equal(post.form.Email, 'me@example.com');
  assert.equal(host.secrets.get('loggedIn'), 'true');
  assert.equal([...host.secrets.values()].includes('pw'), false);
  assert.deepEqual(await host.api.session(), { loggedIn: true, account: 'me@example.com' });
});

test('failed login is reported', async () => {
  const loginUrl = `${ORIGIN}/account/login`;
  const form = '<form class="form-login-details"><input name="__RequestVerificationToken" value="t" /></form>';
  const { api } = plugin((url) => (url === loginUrl ? { url: loginUrl, text: form } : null));
  await assert.rejects(api.login({ email: 'a', password: 'b' }), { code: 'AUTH_REQUIRED' });
});

test('logout clears cookies and secrets', async () => {
  const host = plugin({}, { secrets: { loggedIn: 'true', email: 'me' } });
  await host.api.logout();
  assert.equal(host.cookiesCleared, 1);
  assert.equal(host.secrets.size, 0);
  assert.deepEqual(await host.api.session(), { loggedIn: false, account: '' });
});

test('setMembership posts the matching bookmark form', async () => {
  const page = `<form action="/fictions/setbookmark/21220" method="post">
      <input name="type" value="follow" /><input name="__RequestVerificationToken" value="follow-token" />
    </form>
    <form action="/fictions/setbookmark/21220" method="post">
      <input name="type" value="readlater" /><input name="__RequestVerificationToken" value="later-token" />
    </form>
    <script>window.royalroad.userId = 42;</script>`;
  const routes = (url, opts) => {
    if (url === `${ORIGIN}/fiction/21220`) return { url: `${ORIGIN}/fiction/21220/mol`, text: page };
    if (url === `${ORIGIN}/fictions/setbookmark/21220` && opts.method === 'POST') return 'ok';
    return null;
  };
  const host = plugin(routes, { secrets: { loggedIn: 'true' } });
  assert.equal(await host.api.setMembership('21220', 'readlater', true), true);
  const post = host.requests.find((r) => r.method === 'POST');
  assert.deepEqual(post.form, { type: 'readlater', __RequestVerificationToken: 'later-token' });

  assert.equal(await host.api.setMembership('21220', 'favorite', true), false, 'form absent');
  assert.equal(await host.api.setMembership('21220', 'follow', false), false, 'removal is local only');
  assert.equal(await plugin(routes).api.setMembership('21220', 'follow', true), false, 'signed out');
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

test('syncProgress never throws', async () => {
  const { api } = plugin(() => {
    throw new Error('offline');
  });
  await api.syncProgress('1', { title: 'c', url: `${ORIGIN}/fiction/1/demo/chapter/1/c1` });
});
