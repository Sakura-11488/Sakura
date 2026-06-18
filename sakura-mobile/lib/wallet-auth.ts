import type { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

export type WalletAuthHeaders = Record<string, string>;

export function generateWalletAuthMessage(action: string): string {
  const ts = Math.floor(Date.now() / 1000);
  return `sakura:${action}:ts:${ts}`;
}

export function buildWalletAuthHeaders(
  keypair: Keypair,
  action: string,
): WalletAuthHeaders {
  const message = generateWalletAuthMessage(action);
  const messageBytes = new TextEncoder().encode(message);
  const signature = bs58.encode(nacl.sign.detached(messageBytes, keypair.secretKey));

  return {
    'x-wallet-address': keypair.publicKey.toBase58(),
    'x-signature': signature,
    'x-message': message,
  };
}

/** Alias used by creator-api and upstream chat modules. */
export function signWalletAuthMessage(keypair: Keypair, action: string): {
  message: string;
  signature: string;
  headers: WalletAuthHeaders;
} {
  const message = generateWalletAuthMessage(action);
  const headers = buildWalletAuthHeaders(keypair, action);
  return {
    message,
    signature: headers['x-signature'],
    headers,
  };
}
