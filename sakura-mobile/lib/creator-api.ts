import type { Keypair } from '@solana/web3.js';
import Constants from 'expo-constants';
import { supabase } from './supabase';
import { signWalletAuthMessage } from './wallet-auth';

const anonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  Constants.expoConfig?.extra?.supabaseAnonKey ??
  '';

export class CreatorApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreatorApiError';
  }
}

export async function invokeCreatorFunction<T>(
  functionName: string,
  authAction: string,
  keypair: Keypair,
  body: Record<string, unknown>,
): Promise<T> {
  const { headers } = signWalletAuthMessage(keypair, authAction);
  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    headers: {
      ...headers,
      apikey: anonKey,
    },
  });

  if (error) {
    throw new CreatorApiError(error.message ?? `${functionName} failed`);
  }

  const payload = data as T & { error?: string };
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new CreatorApiError(String(payload.error));
  }

  return payload as T;
}

export async function invokeCreatorFunctionPublic<T>(
  functionName: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(functionName, { body });
  if (error) throw new CreatorApiError(error.message ?? `${functionName} failed`);
  const payload = data as T & { error?: string };
  if (payload && typeof payload === 'object' && 'error' in payload && payload.error) {
    throw new CreatorApiError(String(payload.error));
  }
  return payload as T;
}
