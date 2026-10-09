import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadPlugin } from './host.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'Patreon');
const ORIGIN = 'https://www.patreon.com';
const CID = '777';

// Shapes follow Patreon's JSON:API (`/api/posts`, `/api/campaigns`, `/api/collection`); data is made up.
function post(id, title, at, { view = true, type = 'text_only', tags = [], cols = [] } = {}) {
  return {
    id: String(id),
    type: 'post',
    attributes: {
      title,
      published_at: at,
      current_user_can_view: view,
      post_type: type,
      url: `${ORIGIN}/plum_parrot/posts/slug-${id}`,
    },
    relationships: {
      user_defined_tags: { data: tags.map((t) => ({ id: `user_defined;${t}`, type: 'post_tag' })) },
      collections: { data: cols.map((c) => ({ id: String(c), type: 'collection' })) },
    },
  };
}

function basePosts() {
  return [
    post(1001, 'Aura Overload 3.21 - Black Wing', '2026-09-01T10:00:00.000+00:00', { tags: ['AO3'], cols: [900] }),
    post(1002, 'Andy 4.34 - The Children', '2026-09-02T10:00:00.000+00:00'),
    post(1003, 'Aura Overload 3.22 - Happy Early Birthday', '2026-09-03T10:00:00.000+00:00', { tags: ['AO3'], cols: [900] }),
    post(1004, '[Early Access] Andy 4.35 - New Paths', '2026-09-04T10:00:00.000+00:00', { tags: ['AA4'] }),
    post(1005, 'Victor of Tucson, Book 11, is out today!', '2026-09-05T10:00:00.000+00:00', { type: 'image_file' }),
    post(1006, 'Which series next?', '2026-09-06T10:00:00.000+00:00', { type: 'poll' }),
    post(1007, 'Aura Overload 3.23 - All Systems Optimal', '2026-09-07T10:00:00.000+00:00', { tags: ['AO3'], cols: [900] }),
    post(1008, 'Andy 4.36 - Room to Grow', '2026-09-08T10:00:00.000+00:00', { tags: ['AA4'] }),
    post(1009, 'Andy 4.37 - Top Tier Only', '2026-09-09T10:00:00.000+00:00', { view: false, tags: ['AA4'] }),
  ];
}

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The wing <unfolded>.' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Read ', marks: [{ type: 'italic' }] },
        { type: 'text', text: 'more', marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }] },
      ],
    },
    { type: 'image', attrs: { src: 'https://c10.patreonusercontent.com/i.jpg', alt: '', caption: 'Map of the city' } },
  ],
};

function json(obj, status = 200) {
  return { status, text: JSON.stringify(obj) };
}

function postsPage(posts) {
  const data = [...posts].sort((a, b) => (a.attributes.published_at < b.attributes.published_at ? 1 : -1));
  const tags = new Set();
  data.forEach((p) => p.relationships.user_defined_tags.data.forEach((t) => tags.add(t.id)));
  return {
    data,
    included: [...tags].map((id) => ({ id, type: 'post_tag', attributes: { value: id.replace('user_defined;', '') } })),
    links: {},
  };
}

function makeRoutes(state) {
  return (url) => {
    const u = new URL(url);
    const p = u.pathname;
    const q = u.searchParams;
    if (p === '/api/campaigns') {
      return json({ data: q.get('filter[vanity]') === 'plum_parrot' ? [{ id: CID, type: 'campaign' }] : [] });
    }
    if (p === `/api/campaigns/${CID}`) {
      return json({
        data: {
          id: CID,
          type: 'campaign',
          attributes: {
            name: 'Plum Parrot',
            url: `${ORIGIN}/plum_parrot`,
            avatar_photo_url: 'https://c10.patreonusercontent.com/avatar.jpg',
            summary: '<p>LitRPG serials.</p>Weekly chapters.<br>',
            patron_count: 3820,
            pay_per_name: 'month',
          },
        },
        included: [
          { id: '-1', type: 'reward', attributes: { amount_cents: 0, description: 'Everyone' } },
          { id: '12', type: 'reward', attributes: { title: 'Fan', amount_cents: 500, currency: 'USD', description: '<p>Early chapters.</p><p>Votes.</p>', patron_count: 40, published: true, url: `${ORIGIN}/checkout/plum_parrot?rid=12` } },
          { id: '11', type: 'reward', attributes: { title: 'Free', amount_cents: 0, currency: 'USD', description: '', patron_count: 2100, published: true } },
          { id: '13', type: 'reward', attributes: { title: 'Retired', amount_cents: 900, currency: 'USD', published: false } },
        ],
      });
    }
    if (p === '/api/posts' && q.get('filter[campaign_id]') === CID) return json(postsPage(state.posts));
    if (p === '/api/collection' && q.get('filter[campaign_id]') === CID) {
      return json({
        data: [
          {
            id: '900',
            type: 'collection',
            attributes: {
              title: 'Aura Overload Book 3',
              description: '',
              post_ids: [1007, 1003, 1001],
              thumbnail: { default: 'https://c10.patreonusercontent.com/col.jpg' },
            },
          },
        ],
      });
    }
    if (p === '/api/collection/900') {
      return json({
        data: { id: '900', type: 'collection', attributes: { title: 'Aura Overload Book 3' }, relationships: { campaign: { data: { id: CID, type: 'campaign' } } } },
      });
    }
    const m = /^\/api\/posts\/(\d+)$/.exec(p);
    if (m) {
      const src = state.posts.find((x) => x.id === m[1]);
      if (!src) return null;
      return json({
        data: {
          id: src.id,
          type: 'post',
          attributes: {
            title: src.attributes.title,
            content: null,
            content_json_string: src.attributes.current_user_can_view ? JSON.stringify(DOC) : null,
            current_user_can_view: src.attributes.current_user_can_view,
            post_type: src.attributes.post_type,
            url: src.attributes.url,
          },
          relationships: {
            campaign: { data: { id: CID, type: 'campaign' } },
            collections: src.relationships.collections,
            attachments_media: { data: [] },
          },
        },
        included: [],
      });
    }
    if (p === '/api/current_user') {
      if (!state.user) return json({ errors: [{ status: '401' }] }, 401);
      // Patreon leaves `memberships` empty; only `active_memberships` includes them.
      const withMembers = (q.get('include') || '').split(',').some((i) => i.startsWith('active_memberships'));
      return json(withMembers ? state.user : { ...state.user, included: [] });
    }
    if (p === '/api/stream') {
      if (!state.stream) return null;
      return json({ data: state.stream, links: state.streamNext ? { next: `${ORIGIN}/api/stream?page%5Bcursor%5D=x` } : {} });
    }
    if (p === '/api/search') {
      return json({
        data: [
          {
            id: `campaign_${CID}`,
            type: 'campaign-document',
            attributes: { name: 'Plum Parrot', creator_name: 'Plum Parrot', url: `${ORIGIN}/plum_parrot`, patron_count: 3820, post_statistics: { total: 9 } },
          },
          { id: 'campaign_5', type: 'campaign-document', attributes: { name: 'Other Bird', patron_count: 12, post_statistics: { total: 3 } } },
        ],
        links: { next: `${ORIGIN}/api/search?q=x&page%5Bnumber%5D=2` },
      });
    }
    return null;
  };
}

function plugin({ posts = basePosts(), user = null, settings = {}, secrets = {} } = {}) {
  const state = { posts, user };
  const p = loadPlugin(DIR, { routes: makeRoutes(state), settings, secrets });
  p.state = state;
  return p;
}

const byTitle = (items, title) => items.find((i) => i.title === title);

test('manifest matches the app contract', () => {
  const { manifest } = plugin();
  assert.equal(manifest.id, 'patreon');
  assert.equal(manifest.bookIdPrefix, 'pt');
  assert.equal(manifest.apiVersion, 4);
  assert.deepEqual(manifest.auth.web, { url: 'https://www.patreon.com/login', doneCookie: 'session_id' });
  assert.deepEqual(manifest.lists.map((l) => [l.id, l.kind || 'stories', !!l.syncable, !!l.notifyDefault]), [
    ['memberships', 'browse', true, false],
    ['follow', 'stories', false, true],
  ]);
  assert.ok(manifest.capabilities.includes('browse'));
});

test('searching a vanity lists the creator\'s stories without duplicates', async () => {
  const { api } = plugin();
  const { items, hasMore } = await api.search('plum_parrot', 1);
  assert.equal(hasMore, true);
  assert.deepEqual(items.map((i) => i.title), ['Plum Parrot', 'Aura Overload Book 3', '#AA4', 'Other Bird']);
  assert.equal(items[0].id, CID);
  assert.equal(items[1].id, `${CID}.c900`);
  assert.match(byTitle(items, '#AA4').id, /^777\.t[0-9a-z]+$/);
  assert.match(items[0].subtitle, /^All posts · 7 posts · latest 2026-09-08$/);
  assert.match(byTitle(items, '#AA4').subtitle, /^Tag · 2 posts/);
});

test('a pasted link lists only that creator\'s stories', async () => {
  const { api } = plugin();
  const res = await api.search(`${ORIGIN}/collection/900`, 1);
  assert.equal(res.hasMore, false);
  assert.deepEqual(res.items.map((i) => i.title), ['Plum Parrot', 'Aura Overload Book 3', '#AA4']);
  assert.deepEqual(await api.search('https://www.royalroad.com/fiction/1', 1), { items: [], hasMore: false });
});

test('free-text search expands an exact creator match and keeps paging', async () => {
  const { api } = plugin();
  const res = await api.search('Plum Parrot', 1);
  assert.equal(res.hasMore, true);
  assert.equal(res.items[0].id, CID);
  assert.ok(res.items.some((i) => i.id === '5' && i.title === 'Other Bird'));
  const page2 = await api.search('Plum Parrot', 2);
  assert.ok(page2.items.every((i) => !i.id.includes('.')));
});

test('loadWork builds a tag story oldest first with stable post URLs', async () => {
  const { api } = plugin();
  const tag = byTitle((await api.search('plum_parrot', 1)).items, '#AA4');
  const work = await api.loadWork(tag.id);
  assert.equal(work.title, '#AA4');
  assert.equal(work.author, 'Plum Parrot');
  assert.deepEqual(work.chapters.map((c) => c.id), ['1004', '1008']);
  assert.equal(work.chapters[0].url, `${ORIGIN}/posts/1004`);
  assert.ok(work.card.badges.includes('Tag'));
  assert.deepEqual(work.card.stats[0], { icon: 'pages', value: '2', label: 'Posts' });
});

test('series ids are not Patreon story ids', async () => {
  await assert.rejects(plugin().api.loadWork(`${CID}.sabc`), { code: 'PARSE' });
});

test('all posts skip polls and hidden locked posts; collections use their own title and cover', async () => {
  const { api } = plugin();
  const all = await api.loadWork(CID);
  assert.deepEqual(all.chapters.map((c) => c.id), ['1001', '1002', '1003', '1004', '1005', '1007', '1008']);
  assert.equal(all.synopsis, 'LitRPG serials.Weekly chapters.');
  const col = await api.loadWork(`${CID}.c900`);
  assert.equal(col.title, 'Aura Overload Book 3');
  assert.equal(col.cover, 'https://c10.patreonusercontent.com/col.jpg');
  assert.deepEqual(col.chapters.map((c) => c.id), ['1001', '1003', '1007']);
});

test('locked posts can be shown as locked chapters', async () => {
  const { api } = plugin({ settings: { lockedPosts: 'show' } });
  const work = await api.loadWork(CID);
  const locked = work.chapters.find((c) => c.id === '1009');
  assert.equal(locked.title, 'Andy 4.37 - Top Tier Only');
  assert.equal(locked.locked, true);
  assert.equal(work.chapters.find((c) => c.id === '1008').locked, false);
  assert.ok(work.card.badges.includes('1 locked'));
});

test('posts read once stay in the ToC after access lapses', async () => {
  const p = plugin();
  await p.api.loadWork(CID);
  p.state.posts = p.state.posts.map((x) =>
    x.id === '1001' ? { ...x, attributes: { ...x.attributes, current_user_can_view: false } } : x,
  );
  const work = await p.api.loadWork(CID);
  const kept = work.chapters.find((c) => c.id === '1001');
  assert.ok(kept);
  assert.equal(kept.locked, true);
  assert.equal(work.chapters.length, 7);
});

test('title-number order sorts tag chapters by the numbers in their titles', async () => {
  const posts = basePosts();
  posts.push(post(1010, 'Andy 4.33 - Late Upload', '2026-09-10T10:00:00.000+00:00', { tags: ['AA4'] }));
  const { api } = plugin({ posts, settings: { order: 'titleNumber' } });
  const tag = byTitle((await api.search('plum_parrot', 1)).items, '#AA4');
  const work = await api.loadWork(tag.id);
  assert.deepEqual(work.chapters.map((c) => c.id), ['1010', '1004', '1008']);
});

test('loadChapter renders the rich-text document', async () => {
  const { api } = plugin();
  const ch = await api.loadChapter({ title: 'x', url: `${ORIGIN}/posts/1001`, id: '1001' }, { id: CID, url: '' });
  assert.equal(ch.title, 'Aura Overload 3.21 - Black Wing');
  assert.match(ch.html, /<p>The wing &lt;unfolded&gt;\.<\/p>/);
  assert.match(ch.html, /<em>Read <\/em><a href="https:\/\/example.com\/x">more<\/a>/);
  assert.match(ch.html, /<figcaption>Map of the city<\/figcaption>/);
  const noCaptions = plugin({ settings: { imageCaptions: false } });
  const plain = await noCaptions.api.loadChapter({ title: 'x', url: `${ORIGIN}/posts/1001` }, { id: CID, url: '' });
  assert.doesNotMatch(plain.html, /figcaption/);
});

test('locked chapters ask for sign-in, or say the tier lacks access', async () => {
  const ref = { title: 'x', url: `${ORIGIN}/posts/1009`, id: '1009' };
  await assert.rejects(plugin().api.loadChapter(ref, { id: CID }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(plugin({ secrets: { account: 'Reader' } }).api.loadChapter(ref, { id: CID }), { code: 'UNSUPPORTED' });
});

test('resolveUrl maps creator, collection, and post links to stories', async () => {
  const { api } = plugin();
  assert.equal(await api.resolveUrl(`${ORIGIN}/cw/plum_parrot`), CID);
  assert.equal(await api.resolveUrl(`${ORIGIN}/plum_parrot/posts`), CID);
  assert.equal(await api.resolveUrl(`${ORIGIN}/collection/900?view=expanded`), `${CID}.c900`);
  assert.equal(await api.resolveUrl(`${ORIGIN}/posts/aura-overload-3-1001`), `${CID}.c900`);
  assert.equal(await api.resolveUrl(`${ORIGIN}/posts/andy-4-36-1008`), CID);
  assert.equal(await api.resolveUrl(`${ORIGIN}/home`), null);
  assert.equal(await api.resolveUrl('https://www.royalroad.com/fiction/1'), null);
});

test('checkUpdates reports new posts per story from one page of the creator feed', async () => {
  const p = plugin();
  const tag = byTitle((await p.api.search('plum_parrot', 1)).items, '#AA4');
  const before = await p.api.checkUpdates([
    { id: CID, url: '', chapters: 7, lastChapterUrl: `${ORIGIN}/posts/1008` },
    { id: tag.id, url: '', chapters: 2, lastChapterUrl: `${ORIGIN}/posts/1008` },
  ]);
  assert.deepEqual(before, [
    { id: CID, chapters: 7, latestUrl: `${ORIGIN}/posts/1008` },
    { id: tag.id, chapters: 2, latestUrl: `${ORIGIN}/posts/1008` },
  ]);
  p.state.posts.push(post(1011, 'Andy 4.38 - Fresh', '2026-09-11T10:00:00.000+00:00', { tags: ['AA4'] }));
  const requestsBefore = p.requests.length;
  const after = await p.api.checkUpdates([{ id: tag.id, url: '', chapters: 2, lastChapterUrl: `${ORIGIN}/posts/1008` }]);
  assert.deepEqual(after, [{ id: tag.id, chapters: 3, latestUrl: `${ORIGIN}/posts/1011` }]);
  assert.equal(p.requests.length - requestsBefore, 1);
});

test('memberships sync needs sign-in and records patron status', async () => {
  await assert.rejects(plugin().api.list('memberships', 1), { code: 'AUTH_REQUIRED' });
  const user = {
    data: { id: '1', type: 'user', attributes: { full_name: 'Reader' } },
    included: [
      { id: 'm1', type: 'member', attributes: { patron_status: 'active_patron' }, relationships: { campaign: { data: { id: CID, type: 'campaign' } } } },
      { id: CID, type: 'campaign', attributes: { name: 'Plum Parrot', url: `${ORIGIN}/plum_parrot`, avatar_photo_url: 'https://c10.patreonusercontent.com/a.jpg' } },
    ],
  };
  const p = plugin({ user });
  const res = await p.api.list('memberships', 1);
  assert.deepEqual(res.items.map((i) => [i.id, i.title]), [[CID, 'Plum Parrot']]);
  const work = await p.api.loadWork(CID);
  assert.ok(work.card.badges.includes('Paid member'));
});

const PAID = { label: 'Paid', tone: 'positive' };
const FREE = { label: 'Free', tone: 'negative' };

function memberUser() {
  return {
    data: { id: '1', type: 'user', attributes: { full_name: 'Reader' } },
    included: [
      {
        id: 'm1',
        type: 'member',
        attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 700 },
        relationships: { campaign: { data: { id: CID, type: 'campaign' } } },
      },
      { id: CID, type: 'campaign', attributes: { name: 'Plum Parrot', url: `${ORIGIN}/plum_parrot` } },
      { id: 'm2', type: 'member', attributes: { patron_status: 'former_patron' }, relationships: { campaign: { data: { id: '5', type: 'campaign' } } } },
      { id: '5', type: 'campaign', attributes: { name: 'Other Bird', url: `${ORIGIN}/other_bird` } },
    ],
  };
}

test('memberships rows split into Paid (green) and Free (red) groups, paid first', async () => {
  const p = plugin({ user: memberUser() });
  const items = (await p.api.list('memberships', 1)).items;
  assert.deepEqual(items.map((i) => [i.title, i.group, i.badges]), [
    ['Plum Parrot', 'Paid', [PAID]],
    ['Other Bird', 'Free', [FREE]],
  ]);
});

function feedPost(id, at, cid = CID) {
  return { id: String(id), type: 'post', attributes: { published_at: at }, relationships: { campaign: { data: { id: cid, type: 'campaign' } } } };
}

test('browse Collections tab groups collections, then tags; sorts apply within a group', async () => {
  const posts = basePosts();
  posts.push(post(1012, 'Aside', '2026-09-12T10:00:00.000+00:00', { tags: ['ZZ'] }));
  posts.push(post(1013, 'Aside two', '2026-09-13T10:00:00.000+00:00', { tags: ['ZZ'] }));
  const { api } = plugin({ posts });
  const rows = async (sort) => (await api.browse(CID, 1, sort, 'collections')).items.map((i) => [i.group, i.title]);
  const latest = await api.browse(CID, 1, '', 'collections');
  assert.equal(latest.tab, 'collections');
  assert.equal(latest.sort, 'latest');
  assert.equal(latest.hasMore, false);
  assert.deepEqual(latest.sorts.map((s) => s.id), ['latest', 'title', 'posts']);
  assert.deepEqual(await rows(''), [
    ['Collections', 'Aura Overload Book 3'],
    ['Tags', '#ZZ'],
    ['Tags', '#AA4'],
  ]);
  assert.deepEqual((await rows('title')).map((r) => r[1]), ['Aura Overload Book 3', '#AA4', '#ZZ']);
  assert.deepEqual((await rows('posts')).map((r) => r[1]), ['Aura Overload Book 3', '#ZZ', '#AA4']);
  assert.equal((await api.browse(`${CID}.c900`, 1, 'type', 'collections')).sort, 'latest');
  assert.deepEqual(latest.groups.map((g) => g.title), ['Collections', 'Tags']);
});

test('browse Collections tab declares both groups with empty-state text', async () => {
  const bare = plugin({ posts: [post(3001, 'Hello', '2026-09-01T10:00:00.000+00:00'), post(3002, 'Again', '2026-09-02T10:00:00.000+00:00')] });
  const page = await bare.api.browse(CID, 1, '', 'collections');
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.groups, [
    { title: 'Collections', empty: 'Plum Parrot hasn\'t set up any collections.' },
    { title: 'Tags', empty: 'Plum Parrot hasn\'t tagged any posts.' },
  ]);
  const lone = plugin({ posts: [post(3001, 'Hello', '2026-09-01T10:00:00.000+00:00', { tags: ['Once'] })] });
  assert.equal((await lone.api.browse(CID, 1, '', 'collections')).groups[1].empty, 'No tag is shared by 2 or more posts.');
});

test('browse opens on a cached About tab without crawling posts', async () => {
  const p = plugin();
  const about = await p.api.browse(CID, 1, '', '');
  assert.deepEqual(about.tabs.map((t) => t.label), ['About', 'Posts', 'Collections', 'Membership']);
  assert.equal(about.tab, 'about');
  assert.equal(about.text, 'LitRPG serials.\n\nWeekly chapters.');
  assert.deepEqual(about.stats, [{ icon: 'followers', value: '3.8k', label: 'Patrons' }]);
  assert.ok(p.requests.every((r) => !r.url.includes('/api/posts')));
  const before = p.requests.length;
  await p.api.browse(CID, 1, '', 'about');
  assert.equal(p.requests.length, before);

  const posts = await p.api.browse(CID, 1, '', 'posts');
  assert.equal(posts.storyId, CID);
  assert.deepEqual(posts.items, []);
  assert.equal(p.requests.length, before);
});

test('browse Membership tab shows your tier first, then the other published tiers with join links', async () => {
  const signedOut = await plugin().api.browse(CID, 1, '', 'membership');
  assert.deepEqual(signedOut.badges, []);
  assert.deepEqual(
    signedOut.sections.map((s) => [s.heading, s.title]),
    [['Your membership', 'Signed out'], ['More tiers', 'Free · 2.1k members'], ['', 'Fan · $5 / month · 40 members']],
  );
  assert.deepEqual(signedOut.sections.map((s) => !!s.collapsed), [false, true, false]);
  assert.equal(signedOut.sections[2].text, 'Early chapters.\n\nVotes.');
  assert.deepEqual(signedOut.sections[2].links, [{ label: 'Join Fan', url: `${ORIGIN}/checkout/plum_parrot?rid=12` }]);
  assert.equal(signedOut.sections[1].links[0].url, `${ORIGIN}/plum_parrot/membership`);

  const p = plugin({ user: memberUser(), secrets: { account: 'Reader' } });
  await p.api.list('memberships', 1);
  const paid = await p.api.browse(CID, 1, '', 'membership');
  assert.deepEqual(paid.badges, [PAID]);
  assert.deepEqual(paid.sections.map((s) => [s.heading, s.title]), [
    ['Your membership', 'Fan · $5 / month · 40 members'],
    ['More tiers', 'Free · 2.1k members'],
  ]);
  assert.equal(paid.sections[0].text, 'Early chapters.\n\nVotes.');
  assert.equal(paid.sections[0].links[0].label, 'Manage on Patreon');
});

test('browse pages past 40 stories', async () => {
  const posts = [];
  for (let i = 0; i < 45; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    posts.push(post(3000 + 2 * i, `Note ${i}a`, `2026-08-${day}T10:00:00.000+00:00`, { tags: [`T${i}`] }));
    posts.push(post(3001 + 2 * i, `Note ${i}b`, `2026-08-${day}T11:00:00.000+00:00`, { tags: [`T${i}`] }));
  }
  const { api } = plugin({ posts });
  const first = await api.browse(CID, 1, 'title', 'collections');
  assert.equal(first.items.length, 40);
  assert.equal(first.hasMore, true);
  const second = await api.browse(CID, 2, 'title', 'collections');
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((i) => i.id)).size, 40 + second.items.length);
});

test('memberships rows count new feed posts until the creator page is opened', async () => {
  const p = plugin({ user: memberUser() });
  p.state.stream = [feedPost(2001, '2026-09-20T10:00:00.000+00:00'), feedPost(2900, '2026-09-25T10:00:00.000+00:00', '5')];
  const first = (await p.api.list('memberships', 1)).items[0];
  assert.deepEqual(first.badges, [PAID]);
  assert.deepEqual(first.stats, [{ icon: 'schedule', value: '2026-09-20', label: 'Latest' }]);

  p.storage.set('seen', JSON.stringify({ [CID]: '2026-09-01T00:00:00.000Z' }));
  p.state.stream.push(feedPost(2002, '2026-09-21T10:00:00.000+00:00'));
  assert.deepEqual((await p.api.list('memberships', 1)).items[0].badges, ['2 new', PAID]);
  p.state.streamNext = true;
  assert.equal((await p.api.list('memberships', 1)).items[0].badges[0], '2+ new');

  await p.api.browse(CID, 1, '');
  assert.deepEqual((await p.api.list('memberships', 1)).items[0].badges, [PAID]);
  await p.api.logout();
  assert.equal(p.storage.has('seen'), false);
});

test('session reflects the imported cookies; logout clears them', async () => {
  const signedOut = plugin();
  assert.deepEqual(await signedOut.api.session(), { loggedIn: false });
  const p = plugin({ user: { data: { id: '1', type: 'user', attributes: { full_name: 'Reader' } } } });
  assert.deepEqual(await p.api.session(), { loggedIn: true, account: 'Reader' });
  await p.api.logout();
  assert.equal(p.cookiesCleared, 1);
  assert.equal(p.secrets.size, 0);
  assert.equal(await p.api.setMembership(CID, 'follow', true), false);
});
