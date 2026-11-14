// Node stand-in for the Flow Reader plugin host (`flow` global, apiVersion 6).
// Mirrors app/src/main/java/com/personal/flowreader/plugin/runtime: fetch returns non-2xx instead
// of throwing, HTML nodes follow Jsoup semantics (normalized text, `abs:` attributes).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

function makeHtml() {
  function wrap($, el, base) {
    return el ? new Node($, el, base) : null;
  }
  class Node {
    constructor($, el, base) {
      this.$ = $;
      this.el = el;
      this.base = base;
    }
    select(css) {
      return this.$(this.el).find(css).toArray().map((e) => wrap(this.$, e, this.base));
    }
    selectFirst(css) {
      return wrap(this.$, this.$(this.el).find(css).get(0), this.base);
    }
    text() {
      return this.$(this.el).text().replace(/\s+/g, ' ').trim();
    }
    ownText() {
      return this.$(this.el)
        .contents()
        .toArray()
        .filter((n) => n.type === 'text')
        .map((n) => n.data)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    }
    html() {
      return (this.$(this.el).html() || '').trim();
    }
    outerHtml() {
      return this.$.html(this.el);
    }
    data() {
      return this.$(this.el).html() || '';
    }
    attr(name) {
      if (name.startsWith('abs:')) {
        const raw = this.$(this.el).attr(name.slice(4));
        if (!raw) return '';
        try {
          return new URL(raw.trim(), this.base || undefined).toString();
        } catch {
          return '';
        }
      }
      return this.$(this.el).attr(name) || '';
    }
    hasClass(name) {
      return this.$(this.el).hasClass(name);
    }
    children() {
      return this.$(this.el).children().toArray().map((e) => wrap(this.$, e, this.base));
    }
    parent() {
      const p = this.el.parent;
      return p && p.type !== 'root' ? wrap(this.$, p, this.base) : null;
    }
    contains(other) {
      return !!other && other.el !== this.el && cheerio.contains(this.el, other.el);
    }
    remove() {
      this.$(this.el).remove();
    }
  }
  return {
    parse(html, base) {
      const $ = cheerio.load(html == null ? '' : String(html));
      return new Node($, $.root().get(0), base || '');
    },
  };
}

/**
 * Load a plugin directory. [routes] maps a request `(url, opts)` to `{ status?, url?, text }`
 * or null for a 404.
 */
export function loadPlugin(dir, { routes = () => null, wsCollect = null, settings = {}, secrets = {}, epub = {} } = {}) {
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  const code = readFileSync(join(dir, 'index.js'), 'utf8');
  const secretStore = new Map(Object.entries(secrets));
  const kv = new Map();
  const requests = [];
  let cookiesCleared = 0;

  const allowed = (manifest.allowedHosts || []).map((h) => h.toLowerCase().replace(/^www\./, ''));
  const error = (code, message) => Object.assign(new Error(message || code), { code });
  const defaults = {};
  (manifest.settings || []).forEach((s) => (defaults[s.key] = s.default));
  const mergedSettings = { ...defaults, ...settings };
  const serverHost = () => {
    const key = (manifest.serverSetting || '').trim();
    if (!key) return '';
    const raw = String(mergedSettings[key] || '').trim();
    if (!raw) return '';
    try {
      const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
      return new URL(withScheme).host.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const isAllowed = (host) => {
    const h = host.toLowerCase().replace(/^www\./, '');
    const dynamic = serverHost();
    if (dynamic && h === dynamic) return true;
    return allowed.some((a) => h === a || h.endsWith('.' + a));
  };
  const files = new Map();

  const flow = {
    plugin: { id: manifest.id, version: manifest.version },
    settings: mergedSettings,
    async fetch(url, opts = {}) {
      const host = new URL(url).host;
      if (!isAllowed(host)) throw error('BLOCKED', 'Host not allowed by plugin manifest: ' + host);
      const o = { ...opts };
      const bearerKey = (manifest.auth && manifest.auth.bearer) || '';
      if (o.auth !== false && bearerKey && !Object.keys(o.headers || {}).some((k) => k.toLowerCase() === 'authorization')) {
        const token = secretStore.get(bearerKey);
        if (token) {
          o.headers = { ...(o.headers || {}), Authorization: 'Bearer ' + token };
        }
      }
      requests.push(JSON.parse(JSON.stringify({ url, ...o })));
      const r = routes(url, o);
      if (!r) return { status: 404, url, headers: {}, text: '' };
      if (o.saveAs) {
        const path = String(o.saveAs).replace(/^\/+/, '');
        files.set(path, r.bytes ?? Buffer.from(r.text ?? '', 'utf8'));
        return {
          status: r.status ?? 200,
          url: r.url ?? url,
          headers: r.headers ?? {},
          path,
          bytes: files.get(path).length,
        };
      }
      return { status: r.status ?? 200, url: r.url ?? url, headers: r.headers ?? {}, text: r.text ?? '' };
    },
    epub: {
      spine(file) {
        if (typeof epub.spine === 'function') return epub.spine(file) || [];
        return [];
      },
      html(file, href) {
        if (typeof epub.html === 'function') return epub.html(file, href) || '';
        return '';
      },
      cfiWrite(opts) {
        if (typeof epub.cfiWrite === 'function') return epub.cfiWrite(opts);
        return 'epubcfi(/6/' + (((opts && opts.spineIndex) || 0) + 1) * 2 + '!)';
      },
      cfiRead(file, cfi) {
        if (typeof epub.cfiRead === 'function') return epub.cfiRead(file, cfi);
        // No regex literal here: contract-check's object walker does not skip them, and a
        // parenthesis inside one makes it treat the rest of `flow` as nested under `epub`.
        const text = String(cfi || '');
        const marker = 'epubcfi(/6/';
        const start = text.indexOf(marker);
        if (start < 0) return null;
        let i = start + marker.length;
        let odd = 0;
        let saw = false;
        while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) {
          saw = true;
          odd = odd * 10 + (text.charCodeAt(i) - 48);
          i++;
        }
        if (!saw || odd % 2 !== 0 || odd < 2) return null;
        return { spineIndex: odd / 2 - 1, blockIndex: 0, charOffset: 0, anchorText: '', fraction: 0 };
      },
    },
    html: makeHtml(),
    storage: {
      async get(k) {
        return kv.has(k) ? kv.get(k) : null;
      },
      async set(k, v) {
        kv.set(k, String(v));
      },
      async remove(k) {
        kv.delete(k);
      },
    },
    secrets: {
      async get(k) {
        return secretStore.has(k) ? secretStore.get(k) : null;
      },
      async set(k, v) {
        secretStore.set(k, String(v));
      },
      async remove(k) {
        secretStore.delete(k);
      },
      async clear() {
        secretStore.clear();
      },
    },
    cookies: {
      async clear() {
        cookiesCleared++;
      },
    },
    crypto: {
      sha256(inputBase64) {
        const buf = Buffer.from(String(inputBase64), 'base64');
        return createHash('sha256').update(buf).digest('base64');
      },
      sha256Hex(inputHex) {
        const hex = String(inputHex).toLowerCase().replace(/[^0-9a-f]/g, '');
        return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
      },
    },
    ws: {
      async collect(opts = {}) {
        const url = opts.url || '';
        const host = new URL(url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')).host;
        if (!isAllowed(host)) throw error('BLOCKED', 'Host not allowed by plugin manifest: ' + host);
        if (typeof wsCollect === 'function') return wsCollect(opts);
        throw error('UNSUPPORTED', 'flow.ws.collect is not mocked in this test');
      },
    },
    error,
    url: {
      resolve(base, href) {
        try {
          return new URL(String(href).trim(), base).toString();
        } catch {
          return href;
        }
      },
    },
    async sleep() {},
    log() {},
  };

  const module = { exports: {} };
  const context = vm.createContext({ flow, module, exports: module.exports, console });
  vm.runInContext(code, context, { filename: join(dir, 'index.js') });

  // Round-trip through JSON like the host does, so non-serializable results fail tests.
  const api = {};
  for (const [name, fn] of Object.entries(module.exports)) {
    api[name] = async (...args) => {
      const value = await fn.apply(module.exports, JSON.parse(JSON.stringify(args)));
      return value === undefined ? null : JSON.parse(JSON.stringify(value));
    };
  }
  return {
    manifest,
    api,
    requests,
    secrets: secretStore,
    storage: kv,
    get cookiesCleared() {
      return cookiesCleared;
    },
  };
}
