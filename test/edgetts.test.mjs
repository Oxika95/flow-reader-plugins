import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from './host.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'EdgeTts');

describe('EdgeTts', () => {
  it('manifest is kind tts with clip capabilities', () => {
    const { manifest } = loadPlugin(dir);
    assert.equal(manifest.kind, 'tts');
    assert.equal(manifest.apiVersion, 5);
    assert.ok(manifest.capabilities.includes('clipAudio'));
    assert.ok(manifest.allowedHosts.includes('speech.platform.bing.com'));
  });

  it('listVoices prefers msedgeservices with Sec-MS-GEC', async () => {
    const sample = [
      {
        ShortName: 'en-US-AndrewNeural',
        FriendlyName: 'Microsoft Andrew Online (Natural) - English (United States)',
        Locale: 'en-US',
      },
      {
        ShortName: 'ja-JP-NanamiNeural',
        FriendlyName: 'Microsoft Nanami Online (Natural) - Japanese (Japan)',
        Locale: 'ja-JP',
      },
    ];
    const urls = [];
    const { api } = loadPlugin(dir, {
      routes: (url) => {
        urls.push(url);
        if (url.includes('api.msedgeservices.com') && url.includes('Sec-MS-GEC=')) {
          return { status: 200, text: JSON.stringify(sample) };
        }
        return { status: 403, text: 'Forbidden' };
      },
    });
    const voices = await api.listVoices();
    assert.match(urls[0], /api\.msedgeservices\.com.*Sec-MS-GEC=/);
    assert.equal(voices.length, 2);
    assert.equal(voices[0].id, 'en-US-AndrewNeural');
    assert.match(voices[0].label, /Andrew/);
  });

  it('listVoices falls back to Bing when new host 403s', async () => {
    const sample = [
      {
        ShortName: 'en-US-JennyNeural',
        FriendlyName: 'Microsoft Jenny Online (Natural) - English (United States)',
        Locale: 'en-US',
      },
    ];
    const urls = [];
    const { api } = loadPlugin(dir, {
      routes: (url) => {
        urls.push(url);
        if (url.includes('speech.platform.bing.com')) {
          return { status: 200, text: JSON.stringify(sample) };
        }
        return { status: 403, text: 'Forbidden' };
      },
    });
    const voices = await api.listVoices();
    assert.ok(urls.some((u) => u.includes('api.msedgeservices.com')));
    assert.ok(urls.some((u) => u.includes('speech.platform.bing.com')));
    assert.equal(voices[0].id, 'en-US-JennyNeural');
  });

  it('generateSecMsGec is v2 shaped and stable in a 5-minute window', async () => {
    const { api } = loadPlugin(dir);
    const t0 = Date.UTC(2026, 9, 26, 17, 42, 0);
    const a = await api.generateSecMsGec(t0);
    const b = await api.generateSecMsGec(t0 + 60_000);
    assert.match(a, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
    assert.equal(a, b);
  });

  it('generateSecMsGec matches Readest-style SHA-256 for a fixed clock', async () => {
    const { createHash } = await import('node:crypto');
    const { api } = loadPlugin(dir);
    const t0 = Date.UTC(2026, 9, 26, 17, 42, 0);
    const gec = await api.generateSecMsGec(t0);
    const shaPart = gec.slice(17);
    // Same tick math as Readest (Number + toFixed), not BigInt.
    let ticks = Math.floor(t0 / 1000) + 11644473600;
    ticks -= ticks % 300;
    ticks *= 1000000000 / 100;
    const suffix = Buffer.from(`${ticks.toFixed(0)}6A5AA1D4EAFF4E9FB37E23D68491D6F4`, 'ascii');
    const data = Buffer.alloc(57 + suffix.length);
    const words = [
      0x79706f43, 0x68676972, 0x43282074, 0x694d2029, 0x736f7263, 0x2074666f, 0x70726f43, 0x7461726f,
      0x2e6e6f69, 0x6c6c4120, 0x67697220, 0x20737468, 0x65736572, 0x64657672, 0x0000002e,
    ];
    for (let i = 0; i < words.length; i++) data.writeUInt32LE(words[i] >>> 0, i * 4);
    suffix.copy(data, 57);
    const expect = createHash('sha256').update(data).digest('hex').toUpperCase();
    assert.equal(shaPart, expect);
  });

  it('synthesize uses flow.ws.collect and returns mp3', async () => {
    // Minimal fake: empty binary with 2-byte header length 0 + no payload fails;
    // send one frame with headerLen=0 and 4 audio bytes.
    const header = Buffer.alloc(2);
    const audio = Buffer.from([1, 2, 3, 4]);
    const frame = Buffer.concat([header, audio]);
    const { api } = loadPlugin(dir, {
      wsCollect: async () => ({
        texts: ['Path:turn.end\r\n\r\n'],
        binariesBase64: [frame.toString('base64')],
      }),
    });
    const out = await api.synthesize({
      text: 'Hello',
      voice: 'en-US-AndrewNeural',
      lang: 'en-US',
    });
    assert.ok(out.mp3Base64);
    assert.equal(Buffer.from(out.mp3Base64, 'base64').length, 4);
  });
});
