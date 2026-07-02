type RpcResult<T> = {
  result?: T;
  error?: { message?: string };
};

export function getSolanaRpcUrl(): string {
  const heliusKey = Deno.env.get('HELIUS_API_KEY')?.trim() || Deno.env.get('EXPO_PUBLIC_HELIUS_API_KEY')?.trim();
  const url =
    Deno.env.get('SOLANA_RPC_URL')?.trim() ||
    Deno.env.get('SOLANA_RPC')?.trim() ||
    Deno.env.get('EXPO_PUBLIC_SOLANA_RPC')?.trim() ||
    (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : '') ||
    'https://api.mainnet-beta.solana.com';
  return url;
}

export async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(getSolanaRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `sakura-${method}`,
      method,
      params,
    }),
  });

  const json = (await response.json()) as RpcResult<T>;
  if (json.error) {
    throw new Error(json.error.message ?? `Solana RPC ${method} failed.`);
  }
  if (json.result === undefined) {
    throw new Error(`Solana RPC ${method} returned no result.`);
  }
  return json.result;
}

export async function fetchConfirmedTransaction(signature: string): Promise<Record<string, unknown>> {
  const result = await solanaRpc<Record<string, unknown> | null>('getTransaction', [
    signature,
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);
  if (!result) throw new Error('Payment transaction not found or not confirmed yet.');
  const meta = result.meta as { err?: unknown } | undefined;
  if (meta?.err) throw new Error('Payment transaction failed on-chain.');
  return result;
}
