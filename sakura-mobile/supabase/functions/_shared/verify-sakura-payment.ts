import { fetchConfirmedTransaction } from './solana-rpc.ts';

const DEFAULT_SAKURA_MINT = 'EWiVNxCqNatzV2paBHyfKUwGLnk7WKs9uZTA5jkTpump';
const DEFAULT_PAYMENT_WALLET = 'G8tc69u9PVjAjaL4h8iD3t845dJrvnTKusrLrjv89EZ1';

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
    uiAmount?: number | null;
    uiAmountString?: string;
  };
};

function sakuraMint(): string {
  return Deno.env.get('SAKURA_MINT')?.trim() || DEFAULT_SAKURA_MINT;
}

export function avatarPaymentWallet(): string {
  return Deno.env.get('AVATAR_PAYMENT_WALLET')?.trim() || DEFAULT_PAYMENT_WALLET;
}

export function avatarMintPriceSakura(): number {
  const raw = Deno.env.get('AVATAR_MINT_PRICE_SAKURA')?.trim();
  const parsed = raw ? Number(raw) : 100_000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000;
}

function accountKeyAt(tx: Record<string, unknown>, index: number): string | null {
  const message = tx.transaction as { message?: { accountKeys?: Array<{ pubkey?: string } | string> } } | undefined;
  const keys = message?.message?.accountKeys ?? [];
  const entry = keys[index];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.pubkey ?? null;
}

function tokenAmount(balance?: TokenBalance): number {
  if (!balance?.uiTokenAmount) return 0;
  if (typeof balance.uiTokenAmount.uiAmount === 'number') return balance.uiTokenAmount.uiAmount;
  if (balance.uiTokenAmount.uiAmountString) return Number(balance.uiTokenAmount.uiAmountString);
  const raw = balance.uiTokenAmount.amount;
  const decimals = balance.uiTokenAmount.decimals ?? 6;
  if (!raw) return 0;
  return Number(raw) / 10 ** decimals;
}

export async function verifyAvatarSakuraPayment(input: {
  signature: string;
  expectedPayer: string;
  minAmountSakura?: number;
  recipientWallet?: string;
}): Promise<{ amount: number; recipient: string }> {
  const minAmount = input.minAmountSakura ?? avatarMintPriceSakura();
  const recipient = input.recipientWallet ?? avatarPaymentWallet();
  const mint = sakuraMint();
  const tx = await fetchConfirmedTransaction(input.signature);

  const feePayer = accountKeyAt(tx, 0);
  if (feePayer !== input.expectedPayer) {
    throw new Error('Payment signer does not match your wallet.');
  }

  const meta = tx.meta as {
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | undefined;

  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];

  let credited = 0;
  for (const postEntry of post) {
    if (postEntry.mint !== mint) continue;
    if (postEntry.owner !== recipient) continue;
    const preEntry = pre.find(
      (entry) => entry.accountIndex === postEntry.accountIndex && entry.mint === mint,
    );
    credited = tokenAmount(postEntry) - tokenAmount(preEntry);
    if (credited >= minAmount) break;
  }

  if (credited < minAmount) {
    throw new Error(
      `Payment must include at least ${minAmount.toLocaleString()} SAKURA to ${recipient}.`,
    );
  }

  const raw = JSON.stringify(tx);
  if (!raw.includes(input.expectedPayer)) {
    throw new Error('Payment transaction does not include your wallet.');
  }
  if (!raw.includes(recipient) && !raw.includes(mint)) {
    throw new Error('Payment transaction does not include the Sakura treasury wallet.');
  }

  return { amount: credited, recipient };
}
