import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
// Comments may name the variable; code must not.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the web build never references the Helius key, so Expo cannot inline it into the public bundle', () => {
  const web = code(source('../lib/wallet/helius-key.web.ts'));
  assert.ok(!/process\.env/.test(web), 'helius-key.web.ts must not read process.env');
  assert.ok(!/HELIUS_API_KEY\s*=\s*[^'"\s]/.test(web.replace(/HELIUS_API_KEY = '';/, '')), 'the web key is a constant empty string');
  assert.match(web, /export const HELIUS_API_KEY = '';/);
});

test('config reads the key only through the platform module, and native still gets it', () => {
  assert.ok(!/process\.env\.EXPO_PUBLIC_HELIUS_API_KEY/.test(code(source('../lib/wallet/config.ts'))));
  assert.match(code(source('../lib/wallet/helius-key.ts')), /process\.env\.EXPO_PUBLIC_HELIUS_API_KEY/);
});
