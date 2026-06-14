import bs58 from 'https://esm.sh/bs58@6.0.0';
import nacl from 'https://esm.sh/tweetnacl@1.0.3';

export interface VerifiedWallet {
  walletAddress: string;
  message: string;
}

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isWallet(value: unknown): value is string {
  return typeof value === 'string' && WALLET_RE.test(value);
}

export function jsonResponse(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  });
}

export function verifyWalletHeaders(
  headers: Headers,
  expectedAction: string,
  maxAgeSeconds = 300,
): VerifiedWallet {
  const walletAddress = headers.get('x-wallet-address')?.trim() ?? '';
  const signature = headers.get('x-signature')?.trim() ?? '';
  const message = headers.get('x-message')?.trim() ?? '';

  if (!isWallet(walletAddress) || !signature || !message) {
    throw new Error('Missing or invalid wallet auth headers.');
  }

  const parts = message.split(':');
  if (parts.length !== 4 || parts[0] !== 'sakura' || parts[1] !== expectedAction || parts[2] !== 'ts') {
    throw new Error('Invalid wallet auth action.');
  }

  const ts = Number(parts[3]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxAgeSeconds) {
    throw new Error('Wallet auth message expired.');
  }

  const publicKeyBytes = bs58.decode(walletAddress);
  const signatureBytes = bs58.decode(signature);
  const messageBytes = new TextEncoder().encode(message);
  const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  if (!valid) throw new Error('Invalid wallet signature.');

  return { walletAddress, message };
}

export function corsHeaders(methods = 'POST, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wallet-address, x-signature, x-message, x-avatar-admin-test',
    'Access-Control-Allow-Methods': methods,
  };
}
