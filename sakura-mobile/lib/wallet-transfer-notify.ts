import type { Keypair } from '@solana/web3.js';
import { supabase } from './supabase';
import { buildWalletAuthHeaders } from './wallet-auth';
import { getPassiveSessionKeypair } from './wallet/app-session';

export type TransferAsset = 'sakura' | 'sol';

/**
 * Tell both sides a transfer happened.
 *
 * The function now requires the sender's signature — anyone could previously
 * push "you received 50,000 SAKURA" to any wallet. That means this needs a
 * keypair, and getting one must never cost the user a prompt: the payment paths
 * unlock through `getWalletWithBiometrics`, which deliberately does NOT warm
 * the app-session cache, so asking for a session here would raise a SECOND
 * biometric immediately after the one that authorised the transfer.
 *
 * So callers pass the keypair they already hold. Without one this falls back to
 * a warm session and otherwise gives up quietly — the notification has always
 * been best-effort, and the transfer has already settled on-chain either way.
 */
export async function notifyWalletTransfer(params: {
  asset: TransferAsset;
  senderWallet: string;
  receiverWallet: string;
  amount: number;
  txid: string;
  /** The keypair that signed the transfer. Pass it to avoid a second prompt. */
  keypair?: Keypair | null;
}): Promise<void> {
  const body = {
    asset: params.asset,
    senderWallet: params.senderWallet.trim(),
    receiverWallet: params.receiverWallet.trim(),
    amount: params.amount,
    txid: params.txid.trim(),
  };

  try {
    const kp = params.keypair ?? (await getPassiveSessionKeypair());
    if (!kp) {
      // No key without prompting. Skip rather than interrupt: this is a
      // notification, and the money already moved.
      if (__DEV__) console.warn('[push] no warm key; skipping transfer notification');
      return;
    }
    const headers = buildWalletAuthHeaders(kp, 'transfer-notify');
    const { data, error } = await supabase.functions.invoke('notify-sakura-transfer', { body, headers });
    if (error) {
      if (__DEV__) console.warn('[push] notify transfer failed', error);
      return;
    }
    if (__DEV__ && data && typeof data === 'object' && 'sent' in data && (data as { sent?: number }).sent === 0) {
      console.warn('[push] no devices registered for sender/receiver wallets', body);
    }
  } catch (e) {
    if (__DEV__) console.warn('[push] notify transfer failed', e);
    // Non-blocking — transfer already succeeded on-chain.
  }
}

/** @deprecated Use notifyWalletTransfer */
export async function notifySakuraTransfer(params: {
  senderWallet: string;
  receiverWallet: string;
  amount: number;
  txid: string;
  keypair?: Keypair | null;
}): Promise<void> {
  return notifyWalletTransfer({ ...params, asset: 'sakura' });
}
