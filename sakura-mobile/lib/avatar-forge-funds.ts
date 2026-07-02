import {
  AVATAR_MINT_PRICE_SAKURA,
  formatAvatarMintPrice,
  SOL_SEND_FEE_RESERVE,
} from '@/lib/wallet/config';

export type ForgeFundsStatus = {
  ok: boolean;
  needsSkr: boolean;
  needsSol: boolean;
};

export function getForgeFundsStatus(
  solBalance: number | null,
  sakuraBalance: number | null,
): ForgeFundsStatus {
  const needsSkr = sakuraBalance === null || sakuraBalance < AVATAR_MINT_PRICE_SAKURA;
  const needsSol = solBalance === null || solBalance < SOL_SEND_FEE_RESERVE;
  return {
    ok: !needsSkr && !needsSol,
    needsSkr,
    needsSol,
  };
}

export function getForgeFundsMessage(): string {
  return `Forging costs ${formatAvatarMintPrice()} plus ~${SOL_SEND_FEE_RESERVE} SOL for network fees. Buy SAKURA in your wallet and send SOL to your Sakura wallet for transactions.`;
}
