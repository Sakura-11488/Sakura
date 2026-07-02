import * as SecureStore from 'expo-secure-store';

export type PendingAvatarPayment = {
  walletAddress: string;
  paymentTxSignature: string;
  mode: 'tastes' | 'general';
  createdAt: string;
};

function keyForWallet(walletAddress: string): string {
  return `avatar_forge_payment_${walletAddress}`;
}

export async function getPendingAvatarPayment(walletAddress: string): Promise<PendingAvatarPayment | null> {
  try {
    const raw = await SecureStore.getItemAsync(keyForWallet(walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingAvatarPayment;
    if (parsed.walletAddress !== walletAddress || !parsed.paymentTxSignature) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function savePendingAvatarPayment(payment: PendingAvatarPayment): Promise<void> {
  await SecureStore.setItemAsync(keyForWallet(payment.walletAddress), JSON.stringify(payment));
}

export async function clearPendingAvatarPayment(walletAddress: string): Promise<void> {
  await SecureStore.deleteItemAsync(keyForWallet(walletAddress));
}
