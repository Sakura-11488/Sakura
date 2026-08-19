/**
 * Validates the store-only ZIP writer by extracting the real implementation
 * from lib/web-download.ts, running it under Node, and unpacking the result
 * with an independent tool. A ZIP that only our own code can read is a silent
 * quality bug — this checks a third party agrees.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const SRC = 'C:/Users/1/Documents/milla projects/Sakura/sakura-mobile/lib/web-download.ts';
const OUT = process.argv[2] || '.';

const src = fs.readFileSync(SRC, 'utf8');

// Pull the pure byte-building functions out verbatim — no edits, so this tests
// the shipped code rather than a re-implementation.
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const crcTable = src.slice(src.indexOf('const CRC_TABLE'), src.indexOf('function crc32'));
const body = [
  crcTable,
  grab('crc32'),
  grab('buildLocalHeader'),
  grab('buildCentralHeader'),
  grab('buildEocd'),
]
  .join('\n')
  .replace(/: Uint8Array|: number|: string/g, '')
  .replace(/function (\w+)\(/g, 'function $1(');

const mod = new Function(`${body}; return { crc32, buildLocalHeader, buildCentralHeader, buildEocd };`)();

// Build an archive the same way StoreZipWriter does, with a CJK entry name to
// exercise the UTF-8 flag.
const enc = new TextEncoder();
const entries = [
  { name: '呪術廻戦 Ch 12/page-0001.jpg', data: Buffer.from('hello page one', 'utf8') },
  { name: '呪術廻戦 Ch 12/page-0002.webp', data: Buffer.from('second page bytes here', 'utf8') },
];

const parts = [];
const centrals = [];
let offset = 0;
for (const e of entries) {
  const nameBytes = enc.encode(e.name);
  const data = new Uint8Array(e.data);
  const crc = mod.crc32(data);
  const lfh = mod.buildLocalHeader(nameBytes, crc, data.length);
  parts.push(Buffer.from(lfh), Buffer.from(data));
  centrals.push(Buffer.from(mod.buildCentralHeader(nameBytes, crc, data.length, offset)));
  offset += lfh.length + data.length;
}
const centralSize = centrals.reduce((n, c) => n + c.length, 0);
const eocd = Buffer.from(mod.buildEocd(centrals.length, centralSize, offset));
const zip = Buffer.concat([...parts, ...centrals, eocd]);

const file = path.join(OUT, 'verify.cbz');
fs.writeFileSync(file, zip);
console.log('wrote', file, zip.length, 'bytes');
console.log('local sig :', zip.subarray(0, 4).toString('hex'), '(expect 504b0304)');
console.log('eocd sig  :', zip.subarray(zip.length - 22, zip.length - 18).toString('hex'), '(expect 504b0506)');

// Independent verification: Node cannot unzip natively, so use PowerShell's
// Expand-Archive, which is the Windows Explorer zip engine.
const dest = path.join(OUT, 'unpacked');
fs.rmSync(dest, { recursive: true, force: true });
const zipCopy = path.join(OUT, 'verify.zip');
fs.copyFileSync(file, zipCopy);
try {
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipCopy}' -DestinationPath '${dest}' -Force"`,
    { stdio: 'pipe' },
  );
  const found = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else found.push({ file: path.relative(dest, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(dest);
  console.log('\nEXPANDED OK by the Windows zip engine:');
  for (const f of found) console.log('  ', f.file, '->', JSON.stringify(f.text));
  const ok =
    found.length === 2 &&
    found.some((f) => f.text === 'hello page one') &&
    found.some((f) => f.text === 'second page bytes here');
  console.log(ok ? '\nPASS: contents round-trip intact' : '\nFAIL: contents wrong');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('\nFAIL: Expand-Archive rejected the archive');
  console.error(String(e.stderr || e.message).slice(0, 800));
  process.exit(1);
}
