const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const webRoot = __dirname;
const mobileRoot = path.resolve(webRoot, '..', 'sakura-mobile');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(webRoot);

config.watchFolders = [mobileRoot];
config.resolver.nodeModulesPaths = [path.resolve(webRoot, 'node_modules')];
config.resolver.unstable_enablePackageExports = true;
config.resolver.assetExts = [...config.resolver.assetExts, 'lottie'];

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

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-router/_ctx') {
    return { type: 'sourceFile', filePath: routerContext };
  }
  const dedupeHit = dedupeFromWeb(moduleName);
  if (dedupeHit) return dedupeHit;
  if (shimModules[moduleName]) {
    return { type: 'sourceFile', filePath: shimModules[moduleName] };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
