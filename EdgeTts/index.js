'use strict';

/**
 * Edge Read Aloud client — handshake / Sec-MS-GEC v2 mirrored from Readest.
 * Upstream (do not diverge without porting from here first):
 * https://github.com/readest/readest/blob/main/apps/readest-app/src/libs/edgeTTS.ts
 * Raw WS upgrade (host PluginWs): Readest workersWebSocket.ts
 * (rany2/edge-tts#492).
 */

const EDGE_SPEECH_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const EDGE_VOICES_URL = 'https://api.msedgeservices.com/tts/cognitiveservices/voices/list';
const EDGE_VOICES_URL_LEGACY =
  'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list';
const EDGE_API_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split('.')[0];
const WIN_EPOCH_OFFSET = 11644473600;
const S_TO_NS = 1000000000;
const GEC_PREFIX_WORDS = [
  0x79706f43, 0x68676972, 0x43282074, 0x694d2029, 0x736f7263, 0x2074666f, 0x70726f43, 0x7461726f,
  0x2e6e6f69, 0x6c6c4120, 0x67697220, 0x20737468, 0x65736572, 0x64657672, 0x0000002e,
];
const GEC_PREFIX_LENGTH = 57;

const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
  ` (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36` +
  ` Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function rol16(x) {
  return ((x << 16) | (x >>> 16)) >>> 0;
}

function toWords(bytes) {
  const padded = new Uint8Array(Math.ceil(bytes.length / 8) * 8);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  return Array.from({ length: padded.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

function cs64WordSwap(words, a, b) {
  let acc = 0;
  let last = 0;
  for (let i = 0; i < words.length; i += 2) {
    const x = words[i];
    const y = words[i + 1];
    let t = rol16((Math.imul(rol16(x), 0xef0569fb) + Math.imul(x, a)) >>> 0);
    let q = Math.imul(t, 0x76f50f34) >>> 0;
    acc = (acc + Math.imul(rol16(q), 0xc3efea97) + q) >>> 0;
    t = rol16((Math.imul(rol16(y), 0xc31713db) + Math.imul(y, b)) >>> 0);
    q = Math.imul(t, 0x1881ce3c) >>> 0;
    last = (Math.imul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    acc = (acc + last) >>> 0;
  }
  return [last, acc];
}

function cs64Reversible(words, a, b) {
  let state = 0;
  let acc = 0;
  for (let i = 0; i < words.length; i += 2) {
    state = Math.imul(state + words[i], a) >>> 0;
    for (const c of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = Math.imul(rol16(state), c) >>> 0;
    }
    let t = Math.imul(words[i + 1] + state, b) >>> 0;
    t = Math.imul(rol16(t), 0xa27416f5) >>> 0;
    t = rol16(Math.imul(rol16(t), 0xd38396ff) >>> 0);
    acc = (acc + state) >>> 0;
    state = Math.imul(rol16(Math.imul(t, 0x7c932b89) >>> 0), 0xbfa49f69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  return [state, acc];
}

function encodeAscii(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/** Hex in → hex out via host MessageDigest (no Base64 round-trip). */
function sha256Bytes(bytes) {
  const hexIn = Array.from(bytes, (b) => (b & 255).toString(16).padStart(2, '0')).join('');
  const hexOut = flow.crypto.sha256Hex(hexIn);
  const out = new Uint8Array(hexOut.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hexOut.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Readest generateSecMsGec — same ticks / prefix / CS64.
 * @see https://github.com/readest/readest/blob/main/apps/readest-app/src/libs/edgeTTS.ts
 */
function generateSecMsGec(nowMs) {
  let ticks = Math.floor((nowMs == null ? Date.now() : nowMs) / 1000);
  ticks += WIN_EPOCH_OFFSET;
  ticks -= ticks % 300;
  ticks *= S_TO_NS / 100;
  const suffix = encodeAscii(`${ticks.toFixed(0)}${EDGE_API_TOKEN}`);
  const data = new Uint8Array(GEC_PREFIX_LENGTH + suffix.length);
  const view = new DataView(data.buffer);
  GEC_PREFIX_WORDS.forEach((word, i) => view.setUint32(i * 4, word, true));
  data.set(suffix, GEC_PREFIX_LENGTH);
  const digest = sha256Bytes(data);
  const words = toWords(data);
  const [key0, key1] = toWords(digest);
  const a = (key0 | 1) >>> 0;
  const b = (key1 | 1) >>> 0;
  const [s0, s1] = cs64WordSwap(words, a, b);
  const [r0, r1] = cs64Reversible(words, a, b);
  const cs64 = new DataView(new ArrayBuffer(8));
  cs64.setUint32(0, s0 ^ r0, true);
  cs64.setUint32(4, s1 ^ r1, true);
  return `${toHex(new Uint8Array(cs64.buffer))}-${toHex(digest)}`;
}

function generateMuid() {
  const array = new Uint8Array(16);
  for (let i = 0; i < 16; i++) array[i] = (Math.random() * 256) | 0;
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Readest randomMd5-shaped ConnectionId (32 lowercase hex). */
function randomConnectId() {
  return generateMuid().toLowerCase();
}

/** Same query keys/order as Readest URLSearchParams. */
function speechUrl(connectId) {
  const gec = generateSecMsGec();
  return (
    `${EDGE_SPEECH_URL}?ConnectionId=${connectId}` +
    `&Ocp-Apim-Subscription-Key=${EDGE_API_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=2-${CHROMIUM_FULL_VERSION}`
  );
}

function voicesAuthQuery() {
  const gec = generateSecMsGec();
  return (
    `Ocp-Apim-Subscription-Key=${EDGE_API_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=2-${CHROMIUM_FULL_VERSION}`
  );
}

function edgeWsHeaders() {
  // Match Readest baseHeaders (omit Sec-WebSocket-Version — OkHttp sets that).
  return {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    Cookie: `muid=${generateMuid()};`,
  };
}

const LANG_NAMES = {
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', az: 'Azerbaijani', bg: 'Bulgarian',
  bn: 'Bengali', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish',
  de: 'German', el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', eu: 'Basque',
  fa: 'Persian', fi: 'Finnish', fil: 'Filipino', fr: 'French', ga: 'Irish', gl: 'Galician',
  gu: 'Gujarati', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', hy: 'Armenian',
  id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', jv: 'Javanese',
  ka: 'Georgian', kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean', lo: 'Lao',
  lt: 'Lithuanian', lv: 'Latvian', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian',
  mr: 'Marathi', ms: 'Malay', mt: 'Maltese', my: 'Burmese', nb: 'Norwegian', ne: 'Nepali',
  nl: 'Dutch', pl: 'Polish', ps: 'Pashto', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
  si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', so: 'Somali', sq: 'Albanian', sr: 'Serbian',
  su: 'Sundanese', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese',
  zh: 'Chinese', zu: 'Zulu',
};

function languageLabel(locale) {
  if (!locale) return '';
  const primary = String(locale).split('-')[0].toLowerCase();
  return LANG_NAMES[primary] || primary;
}

function bytesToB64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] & 255;
    const b = i + 1 < bytes.length ? bytes[i + 1] & 255 : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] & 255 : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += alphabet[(triple >>> 18) & 63];
    out += alphabet[(triple >>> 12) & 63];
    out += i + 1 < bytes.length ? alphabet[(triple >>> 6) & 63] : '=';
    out += i + 2 < bytes.length ? alphabet[triple & 63] : '=';
  }
  return out;
}

function extractMp3(binariesBase64) {
  const chunks = [];
  let total = 0;
  for (const b64 of binariesBase64 || []) {
    const bin = typeof atob === 'function' ? atob(b64) : null;
    let arr;
    if (bin != null) {
      arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    } else {
      // Host returns standard base64; decode via flow if needed — binaries already base64 from host.
      const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const out = [];
      for (let i = 0; i < clean.length; i += 4) {
        const n =
          ((alphabet.indexOf(clean[i]) & 63) << 18) |
          ((alphabet.indexOf(clean[i + 1]) & 63) << 12) |
          ((clean[i + 2] === '=' ? 0 : alphabet.indexOf(clean[i + 2]) & 63) << 6) |
          (clean[i + 3] === '=' ? 0 : alphabet.indexOf(clean[i + 3]) & 63);
        out.push((n >>> 16) & 255);
        if (clean[i + 2] !== '=') out.push((n >>> 8) & 255);
        if (clean[i + 3] !== '=') out.push(n & 255);
      }
      arr = new Uint8Array(out);
    }
    // Edge binary frames: 2-byte header length (BE) then audio.
    if (arr.length >= 2) {
      const headerLen = (arr[0] << 8) | arr[1];
      const start = 2 + headerLen;
      if (start < arr.length) {
        chunks.push(arr.subarray(start));
        total += arr.length - start;
      }
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function parseBoundaries(texts) {
  const out = [];
  for (const message of texts || []) {
    if (!/Path:\s*audio\.metadata/i.test(message)) continue;
    const sep = message.indexOf('\r\n\r\n');
    const body = sep >= 0 ? message.slice(sep + 4) : '';
    if (!body) continue;
    let root;
    try {
      root = JSON.parse(body);
    } catch (_) {
      continue;
    }
    const meta = root.Metadata || [];
    for (const entry of meta) {
      if (entry.Type !== 'WordBoundary' || !entry.Data) continue;
      const text = entry.Data.text && entry.Data.text.Text;
      if (!text) continue;
      out.push({
        offset: Number(entry.Data.Offset) || 0,
        duration: Number(entry.Data.Duration) || 0,
        text: String(text),
      });
    }
  }
  return out;
}

function voiceLabel(v, id, locale) {
  const friendly = String(v.FriendlyName || '')
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s*Online\s*\(Natural\)\s*-?\s*/i, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  if (friendly) return friendly;
  const localeBit = locale ? ` (${locale})` : '';
  return id + localeBit;
}

function normalizeGender(raw) {
  const g = String(raw || '').trim().toLowerCase();
  return g === 'male' || g === 'female' ? g : '';
}

function parseVoiceList(text) {
  const raw = JSON.parse(text);
  return (Array.isArray(raw) ? raw : []).map((v) => {
    const id = v.ShortName || v.Name || '';
    const locale = v.Locale || (id.includes('-') ? id.split('-').slice(0, 2).join('-') : '');
    return {
      id,
      label: voiceLabel(v, id, locale),
      language: languageLabel(locale),
      langTag: locale,
      gender: normalizeGender(v.Gender),
    };
  }).filter((v) => v.id);
}

async function fetchVoiceList() {
  const headers = edgeWsHeaders();
  let res = await flow.fetch(`${EDGE_VOICES_URL}?${voicesAuthQuery()}`, { headers });
  if (res.status >= 200 && res.status < 300 && res.text) return res.text;
  res = await flow.fetch(`${EDGE_VOICES_URL_LEGACY}?trustedclienttoken=${EDGE_API_TOKEN}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (res.status >= 200 && res.status < 300 && res.text) return res.text;
  throw flow.error('NETWORK', `voices list status ${res.status}`);
}

function cacheHasGender(voices) {
  return voices.some((v) => {
    const g = String((v && v.gender) || '').toLowerCase();
    return g === 'male' || g === 'female';
  });
}

async function listVoices() {
  const cached = await flow.storage.get('voices.json');
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      // Old caches omit gender; refetch so Settings Gender filter can work.
      if (Array.isArray(parsed) && parsed.length >= 50 && cacheHasGender(parsed)) return parsed;
    } catch (_) {}
  }
  let text;
  try {
    text = await fetchVoiceList();
  } catch (e) {
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (_) {}
    }
    throw e;
  }
  let voices;
  try {
    voices = parseVoiceList(text);
  } catch (_) {
    throw flow.error('PARSE', 'voices list was not JSON');
  }
  if (voices.length >= 50) await flow.storage.set('voices.json', JSON.stringify(voices));
  return voices;
}

async function synthesize(opts) {
  const text = String((opts && opts.text) || '').trim();
  if (!text) throw flow.error('PARSE', 'Nothing to synthesize.');
  const voice = String((opts && opts.voice) || 'en-US-AndrewNeural');
  const lang = String((opts && opts.lang) || 'en-US');
  const ratePercent = Number((opts && opts.ratePercent) || 0);
  const pitchPercent = Number((opts && opts.pitchPercent) || 0);
  const rate = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const pitch = pitchPercent >= 0 ? `+${pitchPercent}%` : `${pitchPercent}%`;
  const connectId = randomConnectId();
  const url = speechUrl(connectId);
  const date = new Date().toString();
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Same framing as Readest genSendContent
  const config =
    'Content-Type: application/json; charset=utf-8\r\n' +
    'Path: speech.config\r\n' +
    `X-Timestamp: ${date}\r\n\r\n` +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":true},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
  const ssml =
    'Content-Type: application/ssml+xml\r\n' +
    'Path: ssml\r\n' +
    `X-RequestId: ${connectId}\r\n` +
    `X-Timestamp: ${date}\r\n\r\n` +
    `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}">${escaped}</prosody></voice></speak>`;
  const session = await flow.ws.collect({
    url,
    headers: edgeWsHeaders(),
    messages: [config, ssml],
    endPath: 'turn.end',
    timeoutMs: 15000,
  });
  const mp3 = extractMp3(session.binariesBase64);
  if (!mp3.length) throw flow.error('NETWORK', 'No audio data received.');
  return {
    mp3Base64: bytesToB64(mp3),
    boundaries: parseBoundaries(session.texts),
  };
}

module.exports = {
  listVoices,
  synthesize,
  generateSecMsGec,
};
