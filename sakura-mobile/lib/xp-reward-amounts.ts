export const XP_SOL_RATE = 0.00000312;
export const XP_REDEEM_MIN = 100;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Preview in whole lamports, matching the server's per-XP payout precision. */
export function previewSol(xp: number, rate = XP_SOL_RATE): number {
  if (!Number.isFinite(xp) || xp <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  const lamports = Math.floor(xp) * Math.round(rate * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) return 0;
  return lamports / LAMPORTS_PER_SOL;
}

export function formatSol(sol: number): string {
  return sol.toLocaleString(undefined, { maximumFractionDigits: 9 });
}

/** Old token swaps retain their original asset and amount in mixed history. */
export function formatRedemptionAmount(redemption: {
  payout_asset: 'SAKURA' | 'SOL';
  sakura_amount: number | null;
  sol_lamports: number | null;
}): string {
  if (redemption.payout_asset === 'SOL') {
    return `${formatSol(Number(redemption.sol_lamports) / LAMPORTS_PER_SOL)} SOL`;
  }
  return `${Number(redemption.sakura_amount).toLocaleString(undefined, { maximumFractionDigits: 6 })} SAKURA`;
}
