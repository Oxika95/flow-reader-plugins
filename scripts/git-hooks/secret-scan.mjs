#!/usr/bin/env node
// Scan a git diff (or pre-push rev ranges on stdin) for cookie/token/password leaks.
// Prints file:line with masked values. Exit 1 on any hit.
// Usage:
//   node secret-scan.mjs --diff <rev1> <rev2>
//   node secret-scan.mjs --pre-push
//   git diff A B | node secret-scan.mjs
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const ZERO = '0'.repeat(40);

const COOKIE_NAMES = [
  String.raw`\.AspNetCore\.Identity\.Application`,
  'session_id',
  String.raw`techaro\.lol-anubis(?:-[A-Za-z0-9._-]+)?`,
  'cf_clearance',
  '__cf_bm',
  '__cfruid',
];

const RULES = [
  {
    id: 'cookie-assignment',
    re: new RegExp(`(${COOKIE_NAMES.join('|')})\\s*[=:]\\s*['"]?([^\\s'";\\\\]{8,})`, 'gi'),
  },
  {
    id: 'cookie-header',
    re: /((?:^|[;\s])(?:Cookie|Set-Cookie)\s*[:=]\s*)([^\n]{12,})/gi,
  },
  {
    id: 'password',
    re: /(password\s*[:=]\s*['"])([^'"]{6,})(['"])/gi,
  },
  {
    id: 'authorization',
    re: /((?:Authorization\s*:\s*|Bearer\s+))([A-Za-z0-9\-._~+/=]{12,})/gi,
  },
  {
    // Line-scoped: a PEM header on an added line is enough to fail the push.
    id: 'private-key',
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)/g,
  },
  {
    id: 'token-or-secret',
    re: /\b([A-Za-z0-9_]*(?:token|secret)[A-Za-z0-9_]*)\s*[:=]\s*['"]?([A-Za-z0-9\-._~+/=]{20,})/gi,
  },
];

function isAllowlisted(line) {
  if (/\b[A-Z][A-Z0-9_]*PASSWORD\b\s*=\s*["']password["']/i.test(line)) return true;
  if (/6A5AA1D4EAFF4E9FB37E23D68491D6F4/i.test(line)) return true;
  // Audiobookshelf tests sign in with the placeholder password "secret".
  if (/password\s*[:=]\s*['"]secret['"]/i.test(line)) return true;
  return false;
}

function mask(value) {
  const v = String(value);
  if (v.length <= 8) return '***';
  return `${v.slice(0, 2)}…${v.slice(-2)} (${v.length} chars)`;
}

function git(args, { input, cwd } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }
  return r.stdout || '';
}

function scanText(text, label = 'stdin') {
  const hits = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let file = label;
  let newLine = 0;
  let inHunk = false;

  const checkLine = (content, lineNo) => {
    if (!content || isAllowlisted(content)) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(content)) !== null) {
        const secret = m[2] !== undefined ? m[2] : m[0];
        if ((rule.id === 'cookie-assignment' || rule.id === 'cookie-header') && secret.length < 8) continue;
        hits.push({
          file,
          line: lineNo,
          rule: rule.id,
          masked: mask(secret),
          snippet: content.trim().slice(0, 120),
        });
        break;
      }
    }
  };

  if (lines.some((l) => l.startsWith('diff --git ') || l.startsWith('+++ ') || l.startsWith('@@ '))) {
    for (const line of lines) {
      if (line.startsWith('diff --git ')) {
        inHunk = false;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        file = p === '/dev/null' ? label : p.replace(/^[ab]\//, '');
        continue;
      }
      if (line.startsWith('@@ ')) {
        const m = /\+(\d+)/.exec(line);
        newLine = m ? Number(m[1]) : 0;
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        checkLine(line.slice(1), newLine);
        newLine += 1;
      } else if (line.startsWith(' ')) {
        newLine += 1;
      }
    }
    return hits;
  }

  lines.forEach((line, i) => checkLine(line, i + 1));
  return hits;
}

function diffRange(a, b, cwd) {
  if (a === ZERO) {
    const empty = git(['hash-object', '-t', 'tree', '--stdin'], { input: '', cwd }).trim();
    return git(['diff', empty, b], { cwd });
  }
  if (b === ZERO) return '';
  return git(['diff', `${a}..${b}`], { cwd });
}

async function readPrePushLines() {
  const lines = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) lines.push(t);
  }
  return lines;
}

function printHits(hits) {
  for (const h of hits) {
    console.error(`secret-scan: ${h.file}:${h.line} [${h.rule}] ${h.masked}`);
    console.error(`  ${h.snippet}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  let hits = [];

  if (argv[0] === '--diff' && argv.length >= 3) {
    hits = scanText(diffRange(argv[1], argv[2], cwd));
  } else if (argv[0] === '--pre-push') {
    const lines = await readPrePushLines();
    if (lines.length === 0) process.exit(0);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      const [, localSha, , remoteSha] = parts;
      if (localSha === ZERO) continue;
      hits = hits.concat(scanText(diffRange(remoteSha, localSha, cwd)));
    }
  } else if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    hits = scanText(Buffer.concat(chunks).toString('utf8'));
  } else {
    console.error('Usage: secret-scan.mjs --diff <a> <b> | --pre-push | <diff on stdin>');
    process.exit(2);
  }

  const seen = new Set();
  hits = hits.filter((h) => {
    const k = `${h.file}:${h.line}:${h.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (hits.length) {
    printHits(hits);
    console.error(`secret-scan: ${hits.length} hit(s); push blocked`);
    process.exit(1);
  }
  console.log('secret-scan: ok');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
