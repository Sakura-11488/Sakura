import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { collectPrecache, stampServiceWorker, usedIconFamilies, LIMITS } from './write-precache-manifest.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = '/app/_expo/static/js/web/index-0123456789abcdef0123456789abcdef.js';
const NUNITO = '/app/assets/vendor/@expo-google-fonts/nunito';
const ICONS = '/app/assets/vendor/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts';
const H = '0123456789abcdef0123456789abcdef';
const asset = {
  regular: `${NUNITO}/400Regular/Nunito_400Regular.${H}.ttf`,
  light: `${NUNITO}/300Light/Nunito_300Light.${H}.ttf`,
  ionicons: `${ICONS}/Ionicons.${H}.ttf`,
  fa6solid: `${ICONS}/FontAwesome6_Solid.${H}.ttf`,
  fa6brands: `${ICONS}/FontAwesome6_Brands.${H}.ttf`,
  fa5solid: `${ICONS}/FontAwesome5_Solid.${H}.ttf`,
  fontawesome: `${ICONS}/FontAwesome.${H}.ttf`,
  mci: `${ICONS}/MaterialCommunityIcons.${H}.ttf`,
  tap: `/app/assets/_sakura-mobile/assets/sounds/tap.${H}.mp3`,
  logo: `/app/assets/_sakura-mobile/assets/images/logo.${H}.png`,
  banner: `/app/assets/_sakura-mobile/assets/images/banner.${H}.png`,
  unreferenced: `/app/assets/_sakura-mobile/assets/images/unused.${H}.png`,
};

function fixture(t, { sources = {}, sizes = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-precache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  const write = (url, bytes) => {
    const file = path.join(dist, url.replace(/^\/app\//, ''));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
  };
  const defaults = {
    regular: 130_000, light: 130_000, ionicons: 390_000, fa6solid: 420_000, fa6brands: 210_000,
    fa5solid: 200_000, fontawesome: 165_000, mci: 1_300_000, tap: 47_000, logo: 430_000,
    banner: 1_200_000, unreferenced: 1_000,
  };
  for (const [key, url] of Object.entries(asset)) write(url, sizes[key] ?? defaults[key]);
  const referenced = Object.entries(asset).filter(([key]) => key !== 'unreferenced').map(([, url]) => url);
  fs.mkdirSync(path.dirname(path.join(dist, BUNDLE.slice(5))), { recursive: true });
  fs.writeFileSync(path.join(dist, BUNDLE.slice(5)),
    referenced.map((url, i) => `var a${i}={uri:"${url}"};`).join('\n') +
    // A string that only looks like an asset path must be ignored.
    '\nvar ghost="/app/assets/vendor/does-not-exist.png";');
  fs.writeFileSync(path.join(dist, 'index.html'),
    `<html><head><link rel="preload" as="font" type="font/ttf" crossorigin="anonymous" href="${asset.regular}" />` +
    `</head><body><script src="${BUNDLE}" defer></script></body></html>`);
  fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ build: H }));
  const src = path.join(root, 'src');
  fs.mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(src, name), text);
  return { dist, src };
}

test('precaches the shell bundle, registered fonts, imported icon families and small assets', (t) => {
  const { dist, src } = fixture(t, {
    sources: {
      'a.tsx': "import { Ionicons, FontAwesome6 as FA } from '@expo/vector-icons';",
      'b.ts': "import type { Something } from './x';",
    },
  });
  const result = collectPrecache({ distDir: dist, sourceRoots: [src] });
  assert.equal(result.build, H);
  assert.equal(result.urls[0], BUNDLE, 'the entry bundle comes first');
  assert.equal(result.urls[1], asset.regular, 'then the preloaded font');
  for (const key of ['ionicons', 'fa6solid', 'fa6brands', 'tap', 'logo']) {
    assert.ok(result.urls.includes(asset[key]), `${key} should be precached`);
  }
  const why = Object.fromEntries(result.excluded.map((e) => [e.url, e.why]));
  assert.match(why[asset.light], /not registered/);
  assert.match(why[asset.fa5solid], /not imported/);
  assert.match(why[asset.fontawesome], /not imported/, 'FontAwesome must not match FontAwesome6');
  assert.match(why[asset.mci], /not imported/);
  assert.match(why[asset.banner], /cap/);
  assert.ok(!result.urls.includes(asset.unreferenced) && !why[asset.unreferenced], 'unreferenced files are not considered');
  assert.ok(!result.urls.some((u) => u.includes('does-not-exist')));
  assert.equal(result.bytes.entries, fs.statSync(path.join(dist, BUNDLE.slice(5))).size);
});

test('falls back to every icon family when imports cannot be read', (t) => {
  const { dist, src } = fixture(t, { sources: { 'a.tsx': "import * as Icons from '@expo/vector-icons';" } });
  const result = collectPrecache({ distDir: dist, sourceRoots: [src] });
  for (const key of ['ionicons', 'fa5solid', 'fontawesome', 'mci']) assert.ok(result.urls.includes(asset[key]), key);
  assert.equal(collectPrecache({ distDir: dist, sourceRoots: [path.join(src, 'missing')] }).urls.includes(asset.mci), true);
});

test('icon family detection reads named, aliased and subpath imports', (t) => {
  const { src } = fixture(t, {
    sources: {
      'a.tsx': "import { Octicons, FontAwesome6, Entypo, Ionicons } from '@expo/vector-icons';",
      'b.tsx': "import AntDesign from '@expo/vector-icons/AntDesign';\nconst S = require('@expo/vector-icons/SimpleLineIcons');",
      'c.tsx': "import {\n  type IconProps,\n  Feather as F,\n} from '@expo/vector-icons';",
      'd.ts': "import type { Zocial } from '@expo/vector-icons';",
    },
  });
  assert.deepEqual([...usedIconFamilies([src])].sort(),
    ['AntDesign', 'Entypo', 'Feather', 'FontAwesome6', 'Ionicons', 'Octicons', 'SimpleLineIcons']);
});

test('the repository source resolves to the families the app actually imports', () => {
  const families = usedIconFamilies(['app', 'components', 'lib', 'constants'].map((d) => path.join(webRoot, d)));
  assert.ok(families, 'source roots must be readable through the web/ symlinks');
  assert.ok(families.has('Ionicons'));
});

test('the total budget cuts the largest optional assets, never the bundle', (t) => {
  const { dist, src } = fixture(t, { sources: { 'a.tsx': "import { Ionicons } from '@expo/vector-icons';" } });
  const result = collectPrecache({
    distDir: dist,
    sourceRoots: [src],
    limits: { ...LIMITS, totalBytes: 200_000 },
  });
  assert.ok(result.urls.includes(BUNDLE));
  assert.ok(result.urls.includes(asset.regular));
  assert.ok(result.bytes.assets <= 200_000);
  assert.ok(result.excluded.some((e) => /total budget/.test(e.why)));
});

test('the lazy chunks the document names are precached whole, with the assets only they reference', (t) => {
  const { dist, src } = fixture(t, { sources: { 'a.tsx': "import Octicons from '@expo/vector-icons/Octicons';" } });
  // A lazy screen chunk (named like a route, brackets and all) that is the
  // only file referencing an icon font, plus a route chunk that is also
  // called index-<hash>.js, as novel/index's is.
  const reader = `/app/_expo/static/js/web/[id]-${'a'.repeat(32)}.js`;
  const novelIndex = `/app/_expo/static/js/web/index-${'b'.repeat(32)}.js`;
  const onlyInReader = `${ICONS}/Octicons.${H}.ttf`;
  for (const [url, text] of [[reader, `var o={uri:"${onlyInReader}"};`], [novelIndex, 'x'], [onlyInReader, 'TTF']]) {
    fs.mkdirSync(path.dirname(path.join(dist, url.slice(5))), { recursive: true });
    fs.writeFileSync(path.join(dist, url.slice(5)), text);
  }
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
    .replace('</body>', `<link rel="sakura-chunk" href="${novelIndex}">\n<link rel="sakura-chunk" href="${reader}">\n</body>`);
  fs.writeFileSync(path.join(dist, 'index.html'), html);
  fs.rmSync(path.join(dist, 'version.json'));
  const result = collectPrecache({ distDir: dist, sourceRoots: [src] });
  assert.ok(result.urls.includes(reader) && result.urls.includes(novelIndex), 'every chunk is in, no size cap');
  assert.ok(result.urls.includes(onlyInReader), 'assets referenced only by a lazy chunk are found');
  assert.equal(result.build, '0123456789abcdef0123456789abcdef', 'the build id is the entry script\'s, not a route chunk\'s');
});

test('an export whose document loads a missing bundle fails loudly', (t) => {
  const { dist, src } = fixture(t);
  fs.rmSync(path.join(dist, BUNDLE.slice(5)));
  assert.throws(() => collectPrecache({ distDir: dist, sourceRoots: [src] }), /not in the export/);
});

test('stamping replaces the placeholder, is repeatable, and yields valid JavaScript', () => {
  const source = fs.readFileSync(path.join(webRoot, 'public', 'sw.js'), 'utf8');
  const once = stampServiceWorker(source, { build: 'abc', urls: [BUNDLE] });
  assert.match(once, /const PRECACHE = \/\* @sakura-precache \*\/ \{"build":"abc","urls":\[[^\]]+\]\};/);
  const twice = stampServiceWorker(once, { build: 'def', urls: [] });
  assert.match(twice, /\{"build":"def","urls":\[\]\};/);
  assert.equal(twice.match(/@sakura-precache/g).length, 1);
  assert.doesNotThrow(() => new vm.Script(twice));
  assert.throws(() => stampServiceWorker('const x = 1;', { build: 'a', urls: [] }), /found 0/);
  const doubled = `${source}\nconst AGAIN = /* @sakura-precache */ null;`;
  assert.throws(() => stampServiceWorker(doubled, { build: 'a', urls: [] }), /found 2/);
});
