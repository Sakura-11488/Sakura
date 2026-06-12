const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Enable package.json `exports` field resolution so htmlparser2 can resolve
// the entities/decode subpath export required by entities@8.
config.resolver.unstable_enablePackageExports = true;

// Allow Metro to bundle .lottie (dotLottie) files as binary assets
config.resolver.assetExts = [...config.resolver.assetExts, 'lottie'];

module.exports = config;
