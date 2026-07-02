// @expo/metro-runtime must load before other imports (Fast Refresh + router).
import '@expo/metro-runtime';

// Solana + wallet code expect Node globals; polyfill before any other imports.
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

import * as ExpoCrypto from 'expo-crypto';
if (typeof global.crypto !== 'object' || global.crypto === null) {
  global.crypto = {};
}
if (typeof global.crypto.getRandomValues !== 'function') {
  global.crypto.getRandomValues = ExpoCrypto.getRandomValues;
}

// react-native-web does not ship Image.resolveAssetSource; lottie and bundled assets need it.
const { patchResolveAssetSource } = require('./polyfills/resolve-asset-source');
const ReactNative = require('react-native');
patchResolveAssetSource(ReactNative.Image);
patchResolveAssetSource(ReactNative);
patchResolveAssetSource(ReactNative.default);

import 'expo-router/entry';
