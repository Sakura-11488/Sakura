import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'sakura-mobile/lib/sakura-originals.ts'), 'utf8');
const eps = [...src.matchAll(/\[\s*(\d+)\s*,\s*'([A-Za-z0-9_-]{11})'\s*,\s*'((?:\\'|[^'])*)'/g)].map(
  (m) => ({ num: Number(m[1]), id: m[2], title: m[3].replace(/\\'/g, "'") }),
);
const server = new Set(
  fs
    .readFileSync(path.join(root, '.psyop-server-ids.txt'), 'utf8')
    .replace(/\r/g, '')
    .split(/\s+/)
    .filter(Boolean),
);
const missing = eps.filter((e) => e.num >= 44 && !server.has(e.id));
const outDir = path.join(root, '.psyop-sync');
fs.mkdirSync(outDir, { recursive: true });
const lines = missing.map((e) => `${e.id}|${e.title}`);
fs.writeFileSync(path.join(outDir, 'missing.txt'), lines.join('\n'));
console.log(`Missing on server: ${missing.length}`);
for (const line of lines) console.log(line);
