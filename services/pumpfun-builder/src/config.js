/** Every tunable, named once. Nothing here is ever logged. */
export function loadConfig() {
  const need = (name) => {
    const v = process.env[name]?.trim();
    if (!v) throw new Error(`${name} is required`);
    return v;
  };

  const cfg = {
    port: Number(process.env.PORT || 8080),
    supabaseUrl: need('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: need('SUPABASE_SERVICE_ROLE_KEY'),
    encryptionKey: need('VANITY_MINT_ENCRYPTION_KEY'),
    /** Shared secret with creator-coin-launch. See the note in server.js. */
    authSecret: need('BUILDER_AUTH_SECRET'),
    rpcUrl: need('SOLANA_RPC'),
    priorityFeeMicroLamports: Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0),
    /** Metadata must be reachable; pump.fun stores the URI, not the content. */
    metadataFetchTimeoutMs: Number(process.env.METADATA_TIMEOUT_MS || 6000),
  };

  if (cfg.authSecret.length < 32) {
    throw new Error('BUILDER_AUTH_SECRET must be at least 32 characters');
  }
  return cfg;
}

/**
 * An RPC URL carries an api-key. Redact before anything reaches a log line.
 */
export function redactRpc(url) {
  return String(url).replace(/(api-key=)[^&\s]*/gi, '$1<redacted>');
}
