// Where the web export puts package assets, and which copy of a package app source gets:
// scripts/public-asset-paths.cjs, scripts/app-package-dedupe.cjs, normalize-export-assets.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { findNodeModulesAssets } from './normalize-export-assets.mjs';

const require = createRequire(import.meta.url);
const publicAssetPaths = require('./public-asset-paths.cjs');
const { publicAssetLocation } = publicAssetPaths;
const { packageNameOf, webCopyAllowed, createAppPackageRedirect, KEEP_APP_COPY } = require('./app-package-dedupe.cjs');
const webRoot = fileURLToPath(new URL('..', import.meta.url));

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('exported asset URLs lose every node_modules segment', () => {
  assert.equal(
    publicAssetLocation('/assets?export_path=/app/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts'),
    '/assets?export_path=/app/assets/vendor/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts',
    'same URL normalize-export-assets.mjs used to produce, so cached copies stay valid',
  );
  // The live 404s: the app's own copies, outside the web project.
  assert.equal(
    publicAssetLocation('/assets?export_path=/app/assets/../sakura-mobile/node_modules/@expo-google-fonts/nunito/400Regular'),
    '/assets?export_path=/app/assets/../sakura-mobile/vendor/@expo-google-fonts/nunito/400Regular',
  );
  assert.equal(
    publicAssetLocation('/assets?export_path=/app/assets/node_modules/expo/node_modules/foo/img'),
    '/assets?export_path=/app/assets/vendor/expo/vendor/foo/img',
  );
  assert.equal(publicAssetLocation('/assets?export_path=/app/assets/../sakura-mobile/assets/images'),
    '/assets?export_path=/app/assets/../sakura-mobile/assets/images', 'app assets are untouched');
  assert.equal(publicAssetLocation('/assets?export_path=/app/assets/my_node_modules_x/a'),
    '/assets?export_path=/app/assets/my_node_modules_x/a', 'only whole path segments');
});

test('the dev server keeps serving assets from where Metro found them', () => {
  const dev = '/assets/?unstable_path=.%2F..%2Fsakura-mobile%2Fnode_modules%2F%40expo-google-fonts%2Fnunito';
  assert.equal(publicAssetLocation(dev), dev);
  const asset = { httpServerLocation: dev, name: 'Nunito' };
  assert.equal(publicAssetPaths(asset), asset);
  const exported = { httpServerLocation: '/assets?export_path=/app/assets/node_modules/x', name: 'x' };
  assert.deepEqual(publicAssetPaths(exported), { httpServerLocation: '/assets?export_path=/app/assets/vendor/x', name: 'x' });
});

test('metro.config.js runs the asset plugin', () => {
  const config = require('../metro.config.js');
  assert.ok(config.transformer.assetPlugins.includes(path.join(webRoot, 'scripts/public-asset-paths.cjs')));
});

test('the export check fails on any asset directory or reference under node_modules', (t) => {
  const dist = tempDir(t, 'sakura-export-');
  const write = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dist, rel)), { recursive: true });
    fs.writeFileSync(path.join(dist, rel), text);
  };
  write('assets/vendor/@expo-google-fonts/nunito/400Regular/Nunito.0123.ttf');
  write('_expo/static/js/web/index-0123.js', 'a="/app/assets/vendor/@expo-google-fonts/nunito/400Regular/Nunito.0123.ttf"');
  write('index.html', '<script src="/app/_expo/static/js/web/index-0123.js"></script>');
  assert.deepEqual(findNodeModulesAssets(dist), []);

  write('assets/_sakura-mobile/node_modules/@expo/vector-icons/Fonts/Ionicons.0123.ttf');
  write('_expo/static/js/web/[id]-0123.js', 'b={uri:"/app/assets/_sakura-mobile/node_modules/@expo/vector-icons/Fonts/Ionicons.0123.ttf"}');
  const problems = findNodeModulesAssets(dist);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.ok(problems.some((p) => p.startsWith('directory assets/_sakura-mobile/node_modules')));
  assert.ok(problems.some((p) => p.includes('[id]-0123.js references /assets/_sakura-mobile/node_modules/')),
    'lazy chunks are checked too, not only the entry bundle');
});

test('package names are read from bare specifiers only', () => {
  assert.equal(packageNameOf('expo-image'), 'expo-image');
  assert.equal(packageNameOf('@solana/web3.js'), '@solana/web3.js');
  assert.equal(packageNameOf('@expo/vector-icons/Ionicons'), '@expo/vector-icons');
  assert.equal(packageNameOf('react-native-svg/lib/x'), 'react-native-svg');
  for (const spec of ['./x', '../x', '/abs/x', '@/lib/theme', 'node:fs', '@scope', '']) assert.equal(packageNameOf(spec), null, spec);
});

test('web copies replace the app\'s only when they match what the app declares', () => {
  const satisfies = (v, r) => (r.startsWith('~') ? v.split('.').slice(0, 2).join('.') === r.slice(1).split('.').slice(0, 2).join('.') : v === r);
  const allowed = (o) => webCopyAllowed({ satisfies, name: 'pkg', ...o });
  assert.equal(allowed({ webVersion: '56.0.11', appRange: '~56.0.9', appVersion: '56.0.9' }), true, 'within the declared range');
  assert.equal(allowed({ webVersion: '57.0.0', appRange: '~56.0.9', appVersion: '56.0.9' }), false, 'outside it');
  assert.equal(allowed({ webVersion: '1.2.3', appVersion: '1.2.3' }), true, 'undeclared but identical');
  assert.equal(allowed({ webVersion: '1.2.4', appVersion: '1.2.3' }), false, 'undeclared and different');
  assert.equal(allowed({ webVersion: '6.3.0' }), true, 'only web has it (Metro falls back to web anyway)');
  assert.equal(allowed({ webVersion: null, appVersion: '1.0.0' }), false, 'web lacks it');
  assert.equal(webCopyAllowed({ satisfies: () => true, name: '@ellipsis-labs/rise', webVersion: '0.4.44', appRange: '^0.4.9', appVersion: '0.4.9' }), false,
    'the perps SDK stays on the version the app ships');
  assert.ok(KEEP_APP_COPY.has('@ellipsis-labs/rise'));
});

test('only bare imports made by app source are redirected to web/', (t) => {
  const root = tempDir(t, 'sakura-dedupe-');
  const web = path.join(root, 'web');
  const mobile = path.join(root, 'sakura-mobile');
  const pkg = (base, name, version) => {
    fs.mkdirSync(path.join(base, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(base, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }));
  };
  pkg(web, 'same', '1.0.0'); pkg(mobile, 'same', '1.0.0');
  pkg(web, 'drift', '2.0.0'); pkg(mobile, 'drift', '1.0.0');
  pkg(web, 'web-only', '1.0.0');
  fs.writeFileSync(path.join(mobile, 'package.json'), JSON.stringify({ dependencies: { same: '^1.0.0', drift: '^1.0.0' } }));
  const redirect = createAppPackageRedirect({
    webRoot: web, mobileRoot: mobile, satisfies: (v, r) => v.split('.')[0] === r.replace(/^\^/, '').split('.')[0],
  });
  const appFile = { originModulePath: path.join(mobile, 'lib', 'x.ts'), extra: 1 };
  assert.deepEqual(redirect(appFile, 'same'), { originModulePath: path.join(web, 'index.js'), extra: 1 });
  assert.ok(redirect(appFile, 'same/sub/path'));
  assert.ok(redirect(appFile, 'web-only'));
  assert.equal(redirect(appFile, 'drift'), null, 'major version drift keeps the app copy');
  assert.equal(redirect(appFile, './local'), null);
  assert.equal(redirect(appFile, '@/lib/theme'), null);
  assert.equal(redirect({ originModulePath: path.join(mobile, 'node_modules', 'lib', 'index.js') }, 'same'), null,
    'a package\'s own imports keep resolving inside its tree');
  assert.equal(redirect({ originModulePath: path.join(web, 'index.js') }, 'same'), null, 'web files already resolve from web/');
});
