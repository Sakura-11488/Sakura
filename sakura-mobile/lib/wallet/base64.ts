/**
 * React Native has no Node `Buffer`, and server-built transactions arrive
 * base64-encoded. Shared by the swap and creator-coin launch paths so there is
 * one decoder rather than two that can drift.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const atobFn = globalThis.atob;
  if (typeof atobFn !== 'function') {
    throw new Error('Base64 decode is not available on this device');
  }
  const binary = atobFn(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
