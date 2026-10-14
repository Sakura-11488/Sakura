const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { resolveWebCardImages } = require('./scripts/card-images.cjs');
const { createAppPackageRedirect } = require('./scripts/app-package-dedupe.cjs');

const webRoot = __dirname;
const mobileRoot = path.resolve(webRoot, '..', 'sakura-mobile');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(webRoot);

config.watchFolders = [mobileRoot];
config.resolver.nodeModulesPaths = [path.resolve(webRoot, 'node_modules')];
config.resolver.unstable_enablePackageExports = true;
config.resolver.assetExts = [...config.resolver.assetExts, 'lottie'];
// Exported asset URLs must not contain node_modules: the host does not serve
// those paths. See scripts/public-asset-paths.cjs.
config.transformer.assetPlugins = [
  ...(config.transformer.assetPlugins ?? []),
  path.join(webRoot, 'scripts/public-asset-paths.cjs'),
];

// Single React instance — mobile watchFolders must not pull in sakura-mobile/node_modules/react.
config.resolver.extraNodeModules = {
  react: path.resolve(webRoot, 'node_modules/react'),
  'react-dom': path.resolve(webRoot, 'node_modules/react-dom'),
  'react-native': path.resolve(webRoot, 'node_modules/react-native'),
};

const shimRoot = path.resolve(webRoot, 'shims');
const routerContext = path.join(webRoot, 'router-context.js');
const shimModules = {
  'react-native-webview': path.join(shimRoot, 'react-native-webview.tsx'),
  'lottie-react-native': path.join(shimRoot, 'lottie-react-native.tsx'),
  'expo-local-authentication': path.join(shimRoot, 'expo-local-authentication.ts'),
  'expo-haptics': path.join(shimRoot, 'expo-haptics.ts'),
  'expo-navigation-bar': path.join(shimRoot, 'expo-navigation-bar.ts'),
  'expo-screen-orientation': path.join(shimRoot, 'expo-screen-orientation.ts'),
  'expo-notifications': path.join(shimRoot, 'expo-notifications.ts'),
  'expo-widgets': path.join(shimRoot, 'expo-widgets.ts'),
  'expo-updates': path.join(shimRoot, 'expo-updates.ts'),
  'expo-media-library': path.join(shimRoot, 'expo-media-library.ts'),
  'expo-file-system': path.join(shimRoot, 'expo-file-system.ts'),
  'expo-file-system/legacy': path.join(shimRoot, 'expo-file-system-legacy.ts'),
  'expo-secure-store': path.join(shimRoot, 'expo-secure-store.ts'),
};

const dedupeFromWeb = (moduleName) => {
  const shouldDedupe =
    moduleName === 'react' ||
    moduleName === 'react-dom' ||
    moduleName === 'react-native' ||
    moduleName === 'expo-router' ||
    moduleName.startsWith('react/') ||
    (moduleName.startsWith('expo-router/') && moduleName !== 'expo-router/_ctx') ||
    moduleName.startsWith('@react-navigation/');

  if (!shouldDedupe) return null;

  try {
    return {
      type: 'sourceFile',
      filePath: require.resolve(moduleName, { paths: [path.join(webRoot, 'node_modules')] }),
    };
  } catch {
    return null;
  }
};

// App source resolves npm packages from web/node_modules when that copy is a
// like-for-like swap, so the bundle carries one copy of each. See
// scripts/app-package-dedupe.cjs for the policy and the measurements.
const appPackageRedirect = createAppPackageRedirect({ webRoot, mobileRoot });

// Lazily loaded screens (router-context.js) render expo-router's
// SuspenseFallback while their chunk downloads; its production version is
// blank. router-suspense-fallback.tsx paints the app background instead.
const expoRouterBuild = path.join(
  path.dirname(require.resolve('expo-router/package.json', { paths: [path.join(webRoot, 'node_modules')] })),
  'build',
) + path.sep;
const routerSuspenseFallback = path.join(webRoot, 'router-suspense-fallback.tsx');

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-router/_ctx') {
    return { type: 'sourceFile', filePath: routerContext };
  }
  if (moduleName === './views/SuspenseFallback' && (context.originModulePath || '').startsWith(expoRouterBuild)) {
    return { type: 'sourceFile', filePath: routerSuspenseFallback };
  }
  const dedupeHit = dedupeFromWeb(moduleName);
  if (dedupeHit) return dedupeHit;
  if (shimModules[moduleName]) {
    return { type: 'sourceFile', filePath: shimModules[moduleName] };
  }
  const resolveWith = (ctx) => (originalResolveRequest
    ? originalResolveRequest(ctx, moduleName, platform)
    : ctx.resolveRequest(ctx, moduleName, platform));
  let resolution = null;
  const fromWeb = appPackageRedirect(context, moduleName);
  if (fromWeb) {
    try {
      resolution = resolveWith(fromWeb);
    } catch {
      // Not resolvable from web/ after all (a subpath only the app's copy
      // has, say): resolve it the way it always was.
    }
  }
  resolution ??= resolveWith(context);
  return resolveWebCardImages(resolution, platform, { mobileRoot, webRoot });
};

module.exports = config;
