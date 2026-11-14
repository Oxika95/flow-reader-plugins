import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from './host.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'Audiobookshelf');
const SERVER = 'http://192.168.1.20:13378';

function routes() {
  return (url, opts) => {
    const u = new URL(url);
    const path = u.pathname;
    if (path === '/login' && opts.method === 'POST') {
      assert.equal(opts.auth, false);
      assert.equal(opts.headers['x-return-tokens'], 'true');
      assert.ok(String(opts.contentType || opts.headers['Content-Type'] || '').includes('application/json'));
      const body = JSON.parse(opts.body);
      assert.equal(body.username, 'reader');
      assert.ok(body.password);
      assert.equal(opts.headers.Authorization, undefined);
      return {
        status: 200,
        text: JSON.stringify({
          user: {
            username: 'reader',
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
          },
        }),
      };
    }
    if (path === '/api/me') {
      return { status: 200, text: JSON.stringify({ username: 'reader' }) };
    }
    if (path === '/api/libraries') {
      return {
        status: 200,
        text: JSON.stringify({ libraries: [{ id: 'lib1', name: 'Books' }] }),
      };
    }
    if (path.startsWith('/api/libraries/lib1/items')) {
      return {
        status: 200,
        text: JSON.stringify({
          results: [
            {
              id: 'epub1',
              mediaType: 'book',
              media: {
                ebookFormat: 'epub',
                metadata: { title: 'EPUB Book', authorName: 'A' },
              },
            },
            {
              id: 'pdf1',
              media: {
                ebookFile: { ebookFormat: 'pdf' },
                metadata: { title: 'PDF Book' },
              },
            },
            {
              id: 'audio1',
              media: {
                tracks: [{ index: 0 }],
                metadata: { title: 'Audio Only' },
              },
            },
          ],
          total: 3,
        }),
      };
    }
    if (path === '/api/me/progress' && (!opts.method || opts.method === 'GET')) {
      return {
        status: 200,
        text: JSON.stringify([
          {
            libraryItemId: 'epub1',
            ebookLocation: 'epubcfi(/6/2!)',
            ebookProgress: 0.4,
            progress: 0,
            currentTime: 0,
            lastUpdate: 1000,
          },
          {
            libraryItemId: 'audio1',
            progress: 0.9,
            currentTime: 120,
            lastUpdate: 2000,
          },
        ]),
      };
    }
    if (path === '/api/me/progress/epub1' && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      assert.deepEqual(Object.keys(body).sort(), ['ebookLocation', 'ebookProgress', 'lastUpdate']);
      assert.ok(body.ebookLocation.startsWith('epubcfi('));
      assert.equal(body.ebookProgress, 0.55);
      assert.equal(body.lastUpdate, 9999);
      assert.equal(body.progress, undefined);
      assert.equal(body.currentTime, undefined);
      assert.equal(body.isFinished, undefined);
      return { status: 200, text: '{}' };
    }
    if (path === '/api/items/epub1/ebook') {
      return { status: 200, text: 'PK-fake-epub', bytes: Buffer.from('PK-fake-epub') };
    }
    if (path === '/api/items/epub1') {
      return {
        status: 200,
        text: JSON.stringify({
          id: 'epub1',
          media: {
            ebookFile: { ebookFormat: 'epub', metadata: { filename: 'a.epub' } },
            metadata: { title: 'EPUB Book', authorName: 'A', description: 'Desc' },
          },
        }),
      };
    }
    return null;
  };
}

const epub = {
  spine() {
    return [
      { index: 0, href: 'OEBPS/ch1.xhtml', title: 'One', bytes: 10 },
      { index: 1, href: 'OEBPS/ch2.xhtml', title: 'Two', bytes: 20 },
    ];
  },
  html() {
    return '<p>Hello</p>';
  },
  cfiWrite(opts) {
    return 'epubcfi(/6/' + ((opts.spineIndex + 1) * 2) + '!/4:0)';
  },
  cfiRead(_file, cfi) {
    const m = /epubcfi\(\/6\/(\d+)/.exec(cfi);
    return { spineIndex: Number(m[1]) / 2 - 1, blockIndex: 1, charOffset: 2, anchorText: 'ab', fraction: 0.4 };
  },
};

function load() {
  return loadPlugin(dir, { routes: routes(), settings: { server: SERVER }, epub });
}

{
  const p = load();
  const session = await p.api.login({ username: 'reader', password: 'secret' });
  assert.equal(session.loggedIn, true);
  assert.equal(p.secrets.get('accessToken'), 'access-1');
  assert.equal(p.secrets.get('refreshToken'), 'refresh-1');
  assert.equal(p.secrets.has('password'), false);
  assert.ok(![...p.secrets.keys()].includes('password'));
}

{
  const p = load();
  await p.api.login({ username: 'reader', password: 'secret' });
  const catalog = await p.api.list('catalog', 1);
  assert.equal(catalog.items.length, 0);
  const downloaded = await p.api.list('downloaded', 1);
  assert.equal(downloaded.items.length, 0);
  const shelf = await p.api.browse('catalog', 1, '', 'library');
  assert.equal(shelf.items.length, 1);
  assert.equal(shelf.items[0].id, 'epub1');
  assert.equal(shelf.items[0].title, 'EPUB Book');
  assert.deepEqual(shelf.tabs.map((t) => t.id), ['library', 'series', 'collections', 'authors']);
  assert.ok(shelf.sorts.some((s) => s.id === 'media.metadata.title'));
}

{
  const p = load();
  await p.api.login({ username: 'reader', password: 'secret' });
  const libs = await p.api.listLibraries();
  assert.equal(libs.length, 1);
  assert.equal(libs[0].id, 'lib1');
  assert.equal(libs[0].enabled, true);
  await p.api.setLibraryEnabled('lib1', false);
  const again = await p.api.listLibraries();
  assert.equal(again[0].enabled, false);
  assert.equal((await p.api.browse('catalog', 1)).items.length, 0);
  await p.api.setLibraryEnabled('lib1', true);
  const page = await p.api.browse('lib1', 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 'epub1');
  assert.equal(page.items[0].title, 'EPUB Book');
}

{
  const p = load();
  await p.api.login({ username: 'reader', password: 'secret' });
  await p.api.syncProgress(
    'epub1',
    { title: 'One', url: 'spine:OEBPS/ch1.xhtml' },
    { blockIndex: 0, charOffset: 0, anchorText: '', fraction: 0.55, positionAt: 9999 },
  );
}

{
  const p = load();
  await p.api.login({ username: 'reader', password: 'secret' });
  const positions = await p.api.readPositions(['epub1', 'audio1']);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].id, 'epub1');
  assert.equal(positions[0].fraction, 0.4);
  assert.ok(positions[0].chapterUrl.startsWith('spine:'));
  assert.equal(positions.find((x) => x.id === 'audio1'), undefined);
}

{
  const p = load();
  await p.api.login({ username: 'reader', password: 'secret' });
  const detail = await p.api.loadWork('epub1');
  assert.equal(detail.file, 'ebooks/epub1.epub');
  assert.equal(detail.chapters.length, 2);
  assert.equal(detail.chapters[0].url, 'spine:OEBPS/ch1.xhtml');
  const saved = p.requests.find((r) => r.saveAs === 'ebooks/epub1.epub');
  assert.ok(saved);
}

console.log('audiobookshelf.test.mjs: ok');
