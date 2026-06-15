export type SakuraBalanceSource =
  | 'ata'
  | 'ownerParsedScan'
  | 'legacyMintScan'
  | 'rawScan'
  | 'none'
  | 'error';

export type BalanceDiagnostics = {
  sakuraSource: SakuraBalanceSource;
  sakuraError: string | null;
  rpcLabel: string;
  lastRefreshAt: number | null;
};

let diagnostics: BalanceDiagnostics = {
  sakuraSource: 'none',
  sakuraError: null,
  rpcLabel: 'unknown',
  lastRefreshAt: null,
};

export function getBalanceDiagnostics(): BalanceDiagnostics {
  return { ...diagnostics };
}

export function setBalanceDiagnostics(patch: Partial<BalanceDiagnostics>): void {
  diagnostics = { ...diagnostics, ...patch };
}

export function rpcDisplayLabel(rpc: string): string {
  if (!rpc) return 'default';
  if (rpc.includes('helius')) return 'Helius mainnet';
  if (rpc.includes('mainnet-beta')) return 'Solana public RPC';
  if (rpc.includes('devnet')) return 'Devnet';
  return rpc.replace(/^https?:\/\//, '').slice(0, 40);
}
