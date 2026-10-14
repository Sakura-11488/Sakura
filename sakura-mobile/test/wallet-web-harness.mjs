// Shared by wallet-rpc-cors.test.mjs and wallet-confirm.test.mjs. Runs the real
// edge-function sources in a vm with in-memory stand-ins: no Deno, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// The web bundle's own copies, so the headers under test are the ones the browser sends.
export const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = webRequire('typescript');

export const WEB_ORIGIN = 'https://sakuraonseeker.com';
export const WALLET_RPC_URL = 'https://project.supabase.test/functions/v1/wallet-rpc';

export function loadTs(relativeUrl, imports, globals = {}) {
  const url = new URL(relativeUrl, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: url.pathname,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Response, Request, Headers, URL, TextEncoder,
    AbortController, AbortSignal, setTimeout, clearTimeout, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
      return imports[name];
    },
  }, { filename: url.pathname });
  return module.exports;
}

// Fetch spec: only these are exempt from a preflight. Content-Type is exempt
// only for form and text/plain bodies, never JSON-RPC's application/json.
const SAFELISTED = new Set(['accept', 'accept-language', 'content-language']);

export function headersNeedingPreflight(headers) {
  return [...new Headers(headers).keys()].filter((name) => !SAFELISTED.has(name)).sort();
}

export function headersMissingFrom(allowHeaders, requested) {
  const allowed = (allowHeaders ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return requested.filter((h) => !allowed.includes(h) && !(allowed.includes('*') && h !== 'authorization'));
}

/** What the browser asks before a cross-origin call, and whether it would then send the call. */
export async function browserPreflight(handler, url, { method = 'POST', headers = {} } = {}) {
  const requested = headersNeedingPreflight(headers);
  const response = await handler(new Request(url, {
    method: 'OPTIONS',
    headers: {
      Origin: WEB_ORIGIN,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': requested.join(','),
    },
  }));
  const allowOrigin = response.headers.get('access-control-allow-origin');
  const methods = (response.headers.get('access-control-allow-methods') ?? '')
    .split(',').map((m) => m.trim().toUpperCase());
  const missing = headersMissingFrom(response.headers.get('access-control-allow-headers'), requested);
  return {
    ok: response.ok && (allowOrigin === '*' || allowOrigin === WEB_ORIGIN) && methods.includes(method) &&
      missing.length === 0,
    status: response.status,
    requested,
    missing,
    maxAge: response.headers.get('access-control-max-age'),
  };
}

/**
 * The real wallet-rpc handler. `upstream(body)` plays the Solana RPC behind
 * it; every request the function forwards is recorded.
 */
export function loadWalletRpc({ upstream, rateLimited = false } = {}) {
  const forwarded = [];
  const upstreamFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    forwarded.push({ url: String(url), body, headers: new Headers(init.headers) });
    if (upstream) return upstream(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'ok' }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const readOnlyRpc = loadTs('../lib/wallet/read-only-rpc.ts', {}, { fetch: upstreamFetch });
  const env = {
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    SOLANA_RPC_URL: 'https://upstream-rpc.test/',
  };
  let handler;
  const exports = loadTs('../supabase/functions/wallet-rpc/index.ts', {
    '../../../lib/wallet/read-only-rpc.ts': readOnlyRpc,
    'https://esm.sh/@supabase/supabase-js@2.49.1': { createClient: () => ({}) },
    '../_shared/rate-limit.ts': { checkRateLimit: async () => ({ allowed: !rateLimited }) },
  }, {
    fetch: upstreamFetch,
    Deno: { serve(fn) { handler = fn; }, env: { get: (key) => env[key] } },
  });
  assert.equal(typeof handler, 'function', 'wallet-rpc registers a handler');
  return { handler, cors: exports.WALLET_RPC_CORS, forwarded };
}

/** A fetch for web3.js's Connection that behaves like a browser calling wallet-rpc. */
export function browserFetchThrough(handler, { preflights = [] } = {}) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const preflight = await browserPreflight(handler, url, { method: init.method ?? 'GET', headers: init.headers });
    preflights.push(preflight);
    if (!preflight.ok) {
      // Chrome's net::ERR_FAILED surfaces to page script as exactly this.
      throw new TypeError(`Failed to fetch (CORS: ${preflight.missing.join(', ') || 'preflight rejected'})`);
    }
    const headers = new Headers(init.headers);
    headers.set('Origin', WEB_ORIGIN);
    const response = await handler(new Request(url, { method: init.method, headers, body: init.body }));
    const allowOrigin = response.headers.get('access-control-allow-origin');
    // The response itself must name the origin too, or script cannot read it.
    if (allowOrigin !== '*' && allowOrigin !== WEB_ORIGIN) throw new TypeError('Failed to fetch (CORS: response)');
    return response;
  };
}
