/** Minimum SAKURA (SKR) balance required to use Sakura AI. */
export const SAKURA_AI_MIN_HOLDING = 500_000;

export function hasSakuraAiAccess(
  connected: boolean,
  sakuraBalance: number | null,
): boolean {
  if (!connected || sakuraBalance === null) return false;
  return sakuraBalance >= SAKURA_AI_MIN_HOLDING;
}

export function formatSakuraAiRequirement(): string {
  return `${SAKURA_AI_MIN_HOLDING.toLocaleString()} SKR`;
}

export function getSakuraAiProgress(sakuraBalance: number | null): number {
  if (sakuraBalance === null || sakuraBalance <= 0) return 0;
  return Math.min(1, sakuraBalance / SAKURA_AI_MIN_HOLDING);
}
