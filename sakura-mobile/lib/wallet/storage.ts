import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const KEY_SECRET = 'sakura_wallet_secret';
const KEY_PUBKEY = 'sakura_wallet_pubkey';

const AUTH_PROMPT = 'Authenticate to access your Sakura Wallet';

function secretStoreOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    requireAuthentication: true,
    authenticationPrompt: AUTH_PROMPT,
  };
}

async function authenticateForLegacySecret(): Promise<void> {
  const biometricsAvailable = await LocalAuthentication.hasHardwareAsync();
  const enrolled = await LocalAuthentication.isEnrolledAsync();

  if (!biometricsAvailable || !enrolled) {
    throw new Error('Device biometrics or passcode are required to unlock this wallet.');
  }

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: AUTH_PROMPT,
    cancelLabel: 'Cancel',
    fallbackLabel: 'Use Passcode',
  });
  if (!result.success) {
    throw new Error('Authentication cancelled or failed');
  }
}

export function generateWallet(): Keypair {
  return Keypair.generate();
}

export async function storeWallet(keypair: Keypair): Promise<void> {
  const secret = bs58.encode(keypair.secretKey);
  await SecureStore.setItemAsync(KEY_SECRET, secret, secretStoreOptions());
  await SecureStore.setItemAsync(KEY_PUBKEY, keypair.publicKey.toBase58());
}

export async function getStoredPublicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_PUBKEY);
}

export async function getWalletWithBiometrics(): Promise<Keypair | null> {
  let secret = await SecureStore.getItemAsync(KEY_SECRET, secretStoreOptions());
  if (!secret) {
    // One-time migration for wallets saved before requireAuthentication was enabled.
    await authenticateForLegacySecret();
    secret = await SecureStore.getItemAsync(KEY_SECRET);
    if (secret) {
      await SecureStore.setItemAsync(KEY_SECRET, secret, secretStoreOptions());
    }
  }
  if (!secret) return null;

  const secretKey = bs58.decode(secret);
  return Keypair.fromSecretKey(secretKey);
}

export async function importWalletFromKey(privateKeyBase58: string): Promise<Keypair> {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  await storeWallet(keypair);
  return keypair;
}

export async function removeWallet(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_SECRET);
  await SecureStore.deleteItemAsync(KEY_PUBKEY);
}

export async function hasStoredWallet(): Promise<boolean> {
  const key = await SecureStore.getItemAsync(KEY_PUBKEY);
  return key !== null;
}
