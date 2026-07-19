/**
 * Pure XP → level curve. Shared by the ingest function and (mirrored) the
 * client so both agree on level math. Triangular curve: the XP floor to be AT
 * level L is 50 * (L-1) * L  →  L2=100, L3=300, L4=600, L5=1000, ...
 * (a chapter read ≈ 50 XP, so ~2 chapters to level 2, scaling up smoothly).
 */
export function levelFloor(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return 50 * (l - 1) * l;
}

export function xpToLevel(xp: number): number {
  const x = Math.max(0, Math.floor(xp));
  let level = 1;
  while (x >= levelFloor(level + 1)) level += 1;
  return level;
}

export function levelProgress(xp: number): {
  level: number;
  intoLevel: number;
  toNext: number;
} {
  const level = xpToLevel(xp);
  const floor = levelFloor(level);
  const next = levelFloor(level + 1);
  return { level, intoLevel: Math.max(0, xp - floor), toNext: Math.max(1, next - floor) };
}
