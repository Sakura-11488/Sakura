import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const source = path.join(dist, 'assets/node_modules');
// Hosting platforms omit node_modules directories from static deployments,
// even when Expo puts font and icon assets there. Give exported assets a public
// directory name and update the bundle before its build stamp is generated.
if (fs.existsSync(source)) {
  const target = path.join(dist, 'assets/vendor');
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(source, { recursive: true });
  const bundleDir = path.join(dist, '_expo/static/js/web');
  let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  for (const file of fs.readdirSync(bundleDir).filter((name) => /^index-[a-f0-9]+\.js$/.test(name))) {
    const content = fs.readFileSync(path.join(bundleDir, file), 'utf8')
      .replaceAll('/assets/node_modules/', '/assets/vendor/');
    const next = `index-${createHash('md5').update(content).digest('hex')}.js`;
    fs.writeFileSync(path.join(bundleDir, next), content);
    if (next !== file) fs.unlinkSync(path.join(bundleDir, file));
    html = html.replaceAll(file, next);
  }
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  console.log('[normalize-export-assets] Published vendor fonts and icons.');
}
