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
