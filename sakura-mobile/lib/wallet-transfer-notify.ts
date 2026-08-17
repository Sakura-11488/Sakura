import { supabase } from './supabase';
import { getOrRefreshWalletAuthSession } from './wallet-auth-session';
import { unlockForAppSession } from './wallet/app-session';

export type TransferAsset = 'sakura' | 'sol';

export async function notifyWalletTransfer(params: {
  asset: TransferAsset;
  senderWallet: string;
  receiverWallet: string;
  amount: number;
  txid: string;
}): Promise<void> {
  const body = {
    asset: params.asset,
    senderWallet: params.senderWallet.trim(),
    receiverWallet: params.receiverWallet.trim(),
    amount: params.amount,
    txid: params.txid.trim(),
  };

  try {
    // The wallet was just unlocked to sign the transfer itself, so this reuses a
    // warm session and raises no prompt.
    const headers = await getOrRefreshWalletAuthSession(unlockForAppSession, 'transfer-notify');
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
}): Promise<void> {
  return notifyWalletTransfer({ ...params, asset: 'sakura' });
}
