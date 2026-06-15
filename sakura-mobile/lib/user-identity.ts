import type { UserSearchResult } from './user-search';

export function formatWalletShort(wallet: string): string {
  if (!wallet || wallet.length < 10) return wallet;
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/** Stable accent from wallet for fallback avatar borders. */
export function walletAccentColor(wallet: string): string {
  let hash = 0;
  for (let i = 0; i < wallet.length; i += 1) {
    hash = wallet.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}

export function formatUserSearchTitle(user: UserSearchResult): string {
  if (user.username) return `@${user.username}`;
  return user.display_name?.trim() || 'Sakura wanderer';
}

export function formatUserSearchMeta(
  user: UserSearchResult,
  options?: { isSelf?: boolean },
): string {
  const parts: string[] = [];
  if (options?.isSelf) parts.push('You');
  if (user.display_name?.trim()) {
    parts.push(user.display_name.trim());
  }
  parts.push(formatWalletShort(user.wallet_address));
  if (user.verified) parts.push('Verified');
  if (user.follower_count > 0) {
    parts.push(`${user.follower_count} follower${user.follower_count === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}
