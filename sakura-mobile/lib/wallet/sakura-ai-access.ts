/**
 * The Sakura AI gate, client half.
 *
 * This is presentation only. The authoritative check runs inside the
 * `sakura-ai-chat` edge function against a signature-verified wallet — until
 * Stage 0 there was no server check at all, so the gate below was the *whole*
 * gate, and the anon key that reaches the function ships inside the APK and the
 * PWA bundle. Keep the two thresholds in step with SAKURA_AI_MIN_HOLDING and
 * SAKURA_AI_MIN_XP on the function, or the UI will promise access the server
 * refuses.
 */

/** Minimum $SAKURA balance that unlocks Sakura AI. */
export const SAKURA_AI_MIN_HOLDING = 100_000;

/**
 * Lifetime XP that unlocks it instead — Level 5, roughly 20 chapters read.
 * Lifetime, not spendable: reading `user_xp_state.xp` is a gate, nothing is
 * debited, so the xp_redemptions ledger stays reconcilable.
 */
export const SAKURA_AI_MIN_XP = 1_000;

export function hasSakuraAiAccess(
  connected: boolean,
  sakuraBalance: number | null,
  lifetimeXp: number | null = null,
): boolean {
  if (!connected) return false;
  if ((lifetimeXp ?? 0) >= SAKURA_AI_MIN_XP) return true;
  if (sakuraBalance === null) return false;
  return sakuraBalance >= SAKURA_AI_MIN_HOLDING;
}

export function formatSakuraAiRequirement(): string {
  return `${SAKURA_AI_MIN_HOLDING.toLocaleString()} SKR`;
}

/** Progress toward whichever door the user is closest to. */
export function getSakuraAiProgress(
  sakuraBalance: number | null,
  lifetimeXp: number | null = null,
): number {
  const byHolding = sakuraBalance && sakuraBalance > 0 ? sakuraBalance / SAKURA_AI_MIN_HOLDING : 0;
  const byXp = lifetimeXp && lifetimeXp > 0 ? lifetimeXp / SAKURA_AI_MIN_XP : 0;
  return Math.min(1, Math.max(byHolding, byXp));
}
