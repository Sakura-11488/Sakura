/**
 * Which copy of an npm package the web build gives to app source.
 *
 * The app source lives in sakura-mobile/ (web/app, web/lib, ... are symlinks),
 * so Metro's normal lookup walks up from sakura-mobile/lib/foo.ts and finds
 * sakura-mobile/node_modules first; web/node_modules was only a fallback. The
 * web bundle therefore mixed two dependency trees: measured on the live
 * bundle, 1,330 of its 2,430 source files came from sakura-mobile/node_modules,
 * 22 packages were bundled twice (1.35MB, 28 copies of @solana/errors alone),
 * and react-native-safe-area-context, expo-constants and expo-modules-core ran
 * as two instances each, with two separate React contexts where there should
 * be one.
 *
 * metro.config.js now resolves bare imports made by app source as if they were
 * made from web/, so app code and web-only code share web/node_modules, the
 * tree web/package.json pins and npm dedupes. A package is only switched when
 * that is a like-for-like swap:
 *   - web's installed version satisfies the range sakura-mobile/package.json
 *     declares for it (the range the app is written against), or, for a
 *     package the app does not declare, equals the version the app resolved;
 *   - it is not in KEEP_APP_COPY.
 * Anything else keeps resolving exactly as it did, so this can only remove
 * duplicates, never pick a version the app has not been run with.
 *
 * Native builds are unaffected: they use sakura-mobile's own Metro config.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Packages the web build keeps resolving from sakura-mobile/node_modules even
 * though web/node_modules has a copy that satisfies the declared range.
 *
 * @ellipsis-labs/rise: the Phoenix perps SDK builds the orders the trade
 * screen signs. web/ has 0.4.44, the app (and the native release) 0.4.9; that
 * is a large jump for a 0.x SDK whose output goes on chain, and it cannot be
 * checked without a funded wallet. Upgrade it in sakura-mobile first, then
 * drop it from this list.
 */
const KEEP_APP_COPY = new Set(['@ellipsis-labs/rise']);

/** 'expo-image', '@solana/web3.js/lib/x' -> '@solana/web3.js'; null for relative, absolute and '@/' paths. */
function packageNameOf(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) return null;
  if (/^[a-z]+:/i.test(specifier)) return null; // node:fs, data:, ...
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

function readVersion(root, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Whether web's copy may stand in for the app's.
 * `satisfies` is semver.satisfies, injected so tests need no install.
 */
function webCopyAllowed({ name, webVersion, appRange, appVersion, satisfies, keep = KEEP_APP_COPY }) {
  if (!webVersion || keep.has(name)) return false;
  // Only web has it: Metro already falls back to web/node_modules for these.
  if (!appRange && !appVersion) return true;
  if (appRange) {
    try {
      return satisfies(webVersion, appRange);
    } catch {
      return false;
    }
  }
  return webVersion === appVersion;
}

/**
 * Returns redirect(context, moduleName): the resolution context to use instead
 * (origin moved to web/), or null to resolve as before.
 */
function createAppPackageRedirect({ webRoot, mobileRoot, keep = KEEP_APP_COPY, satisfies }) {
  if (!satisfies) {
    const semver = require(require.resolve('semver', { paths: [webRoot] }));
    satisfies = (version, range) => semver.satisfies(version, range);
  }
  let appManifest = {};
  try {
    appManifest = JSON.parse(fs.readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'));
  } catch {
    // No manifest: every decision falls back to exact version equality.
  }
  const declared = { ...(appManifest.devDependencies || {}), ...(appManifest.dependencies || {}) };
  const mobileSource = mobileRoot + path.sep;
  const nodeModules = `${path.sep}node_modules${path.sep}`;
  const webOrigin = path.join(webRoot, 'index.js');
  const decisions = new Map();

  const allowed = (name) => {
    if (!decisions.has(name)) {
      decisions.set(name, webCopyAllowed({
        name,
        webVersion: readVersion(webRoot, name),
        appRange: declared[name],
        appVersion: readVersion(mobileRoot, name),
        satisfies,
        keep,
      }));
    }
    return decisions.get(name);
  };

  return function redirect(context, moduleName) {
    const origin = context.originModulePath || '';
    // App source only. A package's own imports must keep resolving inside its
    // tree, or a library could end up paired with a dependency it never saw.
    if (!origin.startsWith(mobileSource) || origin.includes(nodeModules)) return null;
    const name = packageNameOf(moduleName);
    if (!name || !allowed(name)) return null;
    return { ...context, originModulePath: webOrigin };
  };
}

module.exports = { KEEP_APP_COPY, packageNameOf, webCopyAllowed, createAppPackageRedirect };
