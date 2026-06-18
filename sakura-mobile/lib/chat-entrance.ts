/** Tracks bubble entrance animations across remounts (FlatList recycle, poll refresh). */
const played = new Set<string>();

export function hasPlayedEntrance(listKey: string): boolean {
  return played.has(listKey);
}

export function markEntrancePlayed(listKey: string): void {
  played.add(listKey);
}

export function resetEntranceAnimations(): void {
  played.clear();
}
