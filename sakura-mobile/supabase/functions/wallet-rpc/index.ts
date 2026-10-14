import { createReadOnlyRpcFetch, FALLBACK_READ_METHODS } from '../../../lib/wallet/read-only-rpc.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const methods = new Set([
  'getAccountInfo', 'getAddressLookupTable', 'getBalance', 'getBlockHeight', 'getEpochInfo', 'getHealth',
  'getFeeForMessage', 'getGenesisHash', 'getLatestBlockhash',
  'getMultipleAccounts', 'getProgramAccounts', 'getSlot', 'getBlockTime',
  'getSignaturesForAddress',
  'getMinimumBalanceForRentExemption', 'getRecentPrioritizationFees',
  'getSignatureStatuses', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
  'getTokenLargestAccounts', 'getTokenSupply', 'getTransaction', 'getVersion',
  'sendTransaction', 'simulateTransaction',
]);
/**
 * Browsers preflight every call here, and the preflight must name each header
 * the page will send. @solana/web3.js adds `solana-client` to EVERY request,
 * after the caller's own `httpHeaders`, so a client cannot leave it out; with
 * it missing from this list the browser refused every web balance read, pass
 * check and send. Native apps never preflight, which is why only web broke.
 *
 * Max-Age lets the browser reuse one preflight (Chrome caps it at 2 h) instead
 * of paying an extra OPTIONS round trip, and invocation, before nearly every
 * call — the balance refresh alone runs every 20 s.
 *
 * Only headers are widened. The method allowlist, size limit and rate limit
 * below are what keep this proxy narrow, and they are unchanged.
 */
export const WALLET_RPC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, solana-client',
  'Access-Control-Max-Age': '86400',
};
const cors = WALLET_RPC_CORS;

let readFetch: typeof fetch | undefined;
let readFetchUrl = '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405, headers: cors });
  try {
    const raw = await req.text();
    if (raw.length > 100_000) return new Response('Request too large.', { status: 413, headers: cors });
    const body = JSON.parse(raw) as { jsonrpc?: string; id?: string | number; method?: string; params?: unknown[] };
    if (!body || body.jsonrpc !== '2.0' || !body.method || !methods.has(body.method) ||
      !Array.isArray(body.params)) {
      return new Response('Unsupported RPC method.', { status: 400, headers: cors });
    }
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 64);
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const limit = await checkRateLimit(supabase, `wallet-rpc:${ip}`, 3600, 3600);
    if (!limit.allowed) return new Response('RPC rate limit reached.', { status: 429, headers: cors });

    const heliusKey = Deno.env.get('HELIUS_API_KEY')?.trim() || Deno.env.get('EXPO_PUBLIC_HELIUS_API_KEY')?.trim();
    const upstream = Deno.env.get('SOLANA_RPC_URL')?.trim() || Deno.env.get('SOLANA_RPC')?.trim() ||
      (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : '') ||
      'https://api.mainnet-beta.solana.com';
    if (!readFetch || readFetchUrl !== upstream) {
      readFetch = createReadOnlyRpcFetch(upstream);
      readFetchUrl = upstream;
    }
    // Keep submission/simulation on their original single provider and deadline.
    const rpcFetch = FALLBACK_READ_METHODS.has(body.method) ? readFetch : fetch;
    const response = await rpcFetch(upstream, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1,
        method: body.method, params: body.params }),
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(response.body, { status: response.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000,
      message: 'RPC is temporarily unavailable.' }, id: null }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
