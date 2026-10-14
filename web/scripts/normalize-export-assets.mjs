/**
 * Checks that the export publishes no asset under a `node_modules` path.
 *
 * Why: hosting platforms omit node_modules directories from static
 * deployments (Vercel serves 404 for any such path), and Expo puts font and
 * icon assets exactly there. This script used to move dist/assets/node_modules
 * to dist/assets/vendor and patch the main bundle's text to match. It missed
 * dist/assets/_sakura-mobile/node_modules, where the app's own copies of the
 * packages landed, so the live site 404ed on all four Nunito weights and every
 * icon font, and once the bundle was split into chunks a text patch could no
 * longer work anyway: Expo names each chunk after a hash of its contents and
 * of the chunks it loads, so editing one after the export leaves stale names
 * behind it.
 *
 * The rename now happens inside Metro (scripts/public-asset-paths.cjs, wired
 * in metro.config.js), so the export is already correct. This step makes sure
 * of it and fails the build otherwise: a deploy with unreachable fonts is
 * worse than no deploy, because nothing else flags it.
 *
 *   node scripts/normalize-export-assets.mjs [distDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = /\.(?:js|css|html|json)$/;
/** An exported asset URL with a node_modules segment, as bundles and CSS reference it. */
const BAD_URL = /\/assets\/(?:[^"'`\s()\\]*\/)?node_modules\/[^"'`\s()\\]*/g;

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory()) walk(full, visit);
  }
}

/** Problems with the export in `distDir`, as human-readable strings. */
export function findNodeModulesAssets(distDir) {
  const problems = [];
  const assets = path.join(distDir, 'assets');
  if (fs.existsSync(assets)) {
    walk(assets, (full, entry) => {
      if (entry.isDirectory() && entry.name === 'node_modules') {
        problems.push(`directory ${path.relative(distDir, full)}`);
      }
    });
  }
  walk(distDir, (full, entry) => {
    if (!entry.isFile() || !TEXT.test(entry.name) || full.startsWith(assets + path.sep)) return;
    const urls = new Set(fs.readFileSync(full, 'utf8').match(BAD_URL) || []);
    for (const url of urls) problems.push(`${path.relative(distDir, full)} references ${url}`);
  });
  return problems;
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(webRoot, 'dist'));
  if (!fs.existsSync(distDir)) {
    console.error('[normalize-export-assets] Missing', distDir, '— run the export first.');
    process.exit(1);
  }
  const problems = findNodeModulesAssets(distDir);
  if (problems.length) {
    console.error('[normalize-export-assets] The export publishes assets under node_modules, which the host will not serve.');
    console.error('Is scripts/public-asset-paths.cjs still in metro.config.js transformer.assetPlugins?');
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    if (problems.length > 20) console.error(`  … and ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log('[normalize-export-assets] No assets under node_modules paths.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
