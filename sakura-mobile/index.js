// Solana + wallet code expect Node globals; polyfill before any other imports.
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// Polyfill crypto.getRandomValues before any Solana/noble-hashes module loads.
// @noble/hashes captures globalThis.crypto at import time, so this MUST run first.
import * as ExpoCrypto from 'expo-crypto';
if (typeof global.crypto !== 'object' || global.crypto === null) {
  global.crypto = {};
}
if (typeof global.crypto.getRandomValues !== 'function') {
  global.crypto.getRandomValues = ExpoCrypto.getRandomValues;
}

import 'expo-router/entry';
