/** Only idempotent balance/health reads may leave the configured provider. */
export const FALLBACK_READ_METHODS = new Set([
  'getBalance', 'getAccountInfo', 'getTokenAccountBalance', 'getTokenAccountsByOwner',
  'getHealth', 'getVersion',
]);

export function publicRpcForConfiguredUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    if (host === 'api.devnet.solana.com' || host === 'devnet.helius-rpc.com') {
      return 'https://api.devnet.solana.com';
    }
    if (host === 'api.testnet.solana.com') return 'https://api.testnet.solana.com';
    if (host === 'api.mainnet-beta.solana.com' || host === 'mainnet.helius-rpc.com') {
      return 'https://api.mainnet-beta.solana.com';
    }
  } catch {
    // Unknown/custom and local-validator endpoints must never change networks.
  }
  return null;
}

function transientRpcResponse(response: Response, payload: unknown): boolean {
  if (response.status === 429 || response.status >= 500) return true;
  const error = (payload as { error?: { code?: number; message?: string } } | null)?.error;
  return !!error && (error.code === 429 || error.code === -32005 ||
    /max(?:imum)? usage|quota|rate.limit|too many requests|temporarily unavailable/i.test(error.message ?? ''));
}

/**
 * Per-consumer cooldown avoids hammering an exhausted provider. Request bodies
 * and responses are buffered inside the deadline; even a stalled body stops.
 * Mutation methods get one attempt on their original endpoint, never failover.
 */
export function createReadOnlyRpcFetch(
  configuredUrl: string,
  request: typeof fetch = fetch,
  timeoutMs = 5000,
): typeof fetch {
  const fallbackUrl = publicRpcForConfiguredUrl(configuredUrl);
  let retryPrimaryAt = 0;

  return async (input, init) => {
    let method = '';
    try {
      method = typeof init?.body === 'string' ? JSON.parse(init.body)?.method : '';
    } catch {
      // Malformed and batch requests do not receive automatic retries.
    }
    const canFallback = FALLBACK_READ_METHODS.has(method) && !!fallbackUrl && fallbackUrl !== configuredUrl;
    const endpoints = canFallback
      ? (Date.now() < retryPrimaryAt ? [fallbackUrl!] : [configuredUrl, fallbackUrl!])
      : [typeof input === 'string' ? input : input instanceof URL ? input.href : input.url];
    let lastError: unknown;
    for (const endpoint of endpoints) {
      if (init?.signal?.aborted) throw new Error('Balance refresh cancelled.');
      const controller = new AbortController();
      const abort = () => controller.abort();
      init?.signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          (async () => {
            const headers = new Headers(init?.headers);
            if (endpoint !== configuredUrl) {
              headers.delete('authorization');
              headers.delete('apikey');
              headers.delete('x-api-key');
            }
            const res = await request(endpoint, { ...init, headers, signal: controller.signal });
            const body = await res.text();
            let payload: unknown;
            try { payload = JSON.parse(body); } catch { payload = null; }
            if (canFallback && transientRpcResponse(res, payload)) {
              throw new Error('RPC provider is temporarily unavailable.');
            }
            return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('RPC read timed out.'));
            }, timeoutMs);
          }),
        ]);
        return response;
      } catch (error) {
        lastError = error;
        if (endpoint === configuredUrl && canFallback) retryPrimaryAt = Date.now() + 60_000;
      } finally {
        clearTimeout(timer);
        init?.signal?.removeEventListener('abort', abort);
      }
    }
    throw lastError ?? new Error('RPC is temporarily unavailable.');
  };
}
