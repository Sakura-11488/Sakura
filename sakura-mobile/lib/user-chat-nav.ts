import type { Keypair } from '@solana/web3.js';
import { useRouter } from 'expo-router';
import { startChatThread } from './chat';
import type { UserSearchResult } from './creator';

type ChatRouter = ReturnType<typeof useRouter>;

export function peerChatLabel(input: {
  displayName?: string | null;
  username?: string | null;
  walletAddress: string;
}): string {
  if (input.displayName?.trim()) return input.displayName.trim();
  if (input.username?.trim()) return `@${input.username.trim()}`;
  const w = input.walletAddress;
  if (w.length > 10) return `${w.slice(0, 4)}…${w.slice(-4)}`;
  return w;
}

export function chatThreadNavParams(input: {
  threadId: string;
  walletAddress: string;
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  avatarSeed?: string | null;
}) {
  return {
    threadId: input.threadId,
    peerName: peerChatLabel(input),
    peerAvatar: input.avatarUrl ?? '',
    peerSeed: input.avatarSeed ?? input.walletAddress.slice(0, 8),
    peerUsername: input.username ?? '',
  };
}

export function userDisplayLabel(user: UserSearchResult): string {
  return peerChatLabel({
    displayName: user.display_name,
    username: user.username,
    walletAddress: user.wallet_address,
  });
}

export function userAvatarSeed(user: UserSearchResult): string {
  return user.avatar_seed ?? user.wallet_address.slice(0, 8);
}

export async function navigateToUserChat(
  router: ChatRouter,
  keypair: Keypair,
  user: UserSearchResult,
): Promise<void> {
  const threadId = await startChatThread(keypair, user.wallet_address);
  router.push({
    pathname: '/messages/[threadId]',
    params: chatThreadNavParams({
      threadId,
      walletAddress: user.wallet_address,
      displayName: user.display_name,
      username: user.username,
      avatarUrl: user.avatar_url,
      avatarSeed: userAvatarSeed(user),
    }),
  } as never);
}

export async function navigateToWalletChat(
  router: ChatRouter,
  keypair: Keypair,
  input: {
    walletAddress: string;
    displayName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
    avatarSeed?: string | null;
  },
): Promise<void> {
  const threadId = await startChatThread(keypair, input.walletAddress);
  router.push({
    pathname: '/messages/[threadId]',
    params: chatThreadNavParams({ threadId, ...input }),
  } as never);
}
