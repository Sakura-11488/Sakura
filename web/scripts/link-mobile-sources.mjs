import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = path.resolve(webRoot, '..', 'sakura-mobile');

const LINKS = ['app', 'components', 'lib', 'constants', 'assets', 'types', 'widgets'];

if (!fs.existsSync(mobileRoot)) {
  console.error(`Missing sakura-mobile at ${mobileRoot}`);
  process.exit(1);
}

for (const name of LINKS) {
  const source = path.join(mobileRoot, name);
  const target = path.join(webRoot, name);

  if (!fs.existsSync(source)) {
    console.warn(`Skip missing mobile folder: ${name}`);
    continue;
  }

  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const current = fs.readlinkSync(target);
      const resolved = path.resolve(path.dirname(target), current);
      if (path.resolve(resolved) === path.resolve(source)) {
        continue;
      }
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(source, target, type);
  console.log(`Linked ${name} -> ${source}`);
}
