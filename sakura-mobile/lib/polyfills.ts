import { getRandomValues } from 'expo-crypto';

// @solana/web3.js requires crypto.getRandomValues — patch it using expo-crypto
// which is bundled with the Expo SDK and works in Expo Go without a native build.
if (typeof global.crypto !== 'object') {
  (global as any).crypto = {};
}
if (typeof (global as any).crypto.getRandomValues !== 'function') {
  (global as any).crypto.getRandomValues = getRandomValues;
}
