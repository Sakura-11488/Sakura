import { Platform } from 'react-native';
import { supabase } from './supabase';
import { AppSettings } from './settings';
import { buildWalletAuthHeaders } from './wallet-auth';
import { getPassiveSessionKeypair } from './wallet/app-session';

export interface PushTokenPrefs {
  notifyEpisodes: boolean;
  notifyChapters: boolean;
  notifyPass: boolean;
  notifyMarketing: boolean;
  passExpiresAt?: string | null;
}

export interface PushRegistrationInput extends PushTokenPrefs {
  walletAddress: string;
  expoPushToken: string;
  enabled: boolean;
}

/**
 * Signed headers for upsert-push-token, which now derives the wallet from the
 * signature rather than trusting the body — otherwise anyone could bind their
 * device to any wallet and receive that wallet's DM previews.
 *
 * Passive only. Push registration runs at app start and from the settings
 * screen, so it must never raise a biometric prompt; getPassiveSessionKeypair
 * returns a warm session key or nothing. When there is no key we throw rather
 * than sending an unsigned request, so the failure is visible to the caller
 * instead of the server rejecting it as a mystery 401.
 *
 * The action string must stay 'push-token' — it is bound into the signed
 * message and the server checks it exactly.
 */
async function pushAuthHeaders(): Promise<Record<string, string>> {
  const kp = await getPassiveSessionKeypair();
  if (!kp) throw new Error("Unlock your wallet to change notification settings.");
  return buildWalletAuthHeaders(kp, 'push-token');
}

function platformLabel(): 'ios' | 'android' | 'web' | 'unknown' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  if (Platform.OS === 'web') return 'web';
  return 'unknown';
}

export async function loadPushPrefs(): Promise<PushTokenPrefs> {
  const [notifyEpisodes, notifyChapters, notifyPass, notifyMarketing] = await Promise.all([
    AppSettings.getPushEpisodes(),
    AppSettings.getPushChapters(),
    AppSettings.getPushPass(),
    AppSettings.getPushMarketing(),
  ]);
  return { notifyEpisodes, notifyChapters, notifyPass, notifyMarketing };
}

export async function upsertPushRegistration(input: PushRegistrationInput): Promise<void> {
  const row = {
    action: 'upsert',
    wallet_address: input.walletAddress,
    expo_push_token: input.expoPushToken,
    platform: platformLabel(),
    notify_episodes: input.notifyEpisodes,
    notify_chapters: input.notifyChapters,
    notify_pass: input.notifyPass,
    pass_expires_at: input.passExpiresAt ?? null,
    enabled: input.enabled,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.functions.invoke('upsert-push-token', {
    body: row,
    headers: await pushAuthHeaders(),
  });
  if (error) throw error;
}

export async function disablePushRegistration(expoPushToken: string): Promise<void> {
  if (!expoPushToken) return;
  const { error } = await supabase.functions.invoke('upsert-push-token', {
    body: { action: 'disable', expo_push_token: expoPushToken },
    headers: await pushAuthHeaders(),
  });
  if (error) throw error;
}

/** Sync local token + prefs to Supabase when push is enabled. */
export async function syncPushRegistration(walletAddress: string | null): Promise<void> {
  if (!walletAddress) return;

  const [enabled, token, prefs] = await Promise.all([
    AppSettings.getPushEnabled(),
    AppSettings.getPushToken(),
    loadPushPrefs(),
  ]);

  if (!enabled || !token) {
    if (token) await disablePushRegistration(token).catch(() => {});
    return;
  }

  await upsertPushRegistration({
    walletAddress,
    expoPushToken: token,
    enabled: true,
    ...prefs,
  });
}

/** Call when the user purchases or renews a pass (stores expiry for reminder cron). */
export async function setPassExpiresAtOnServer(
  walletAddress: string | null,
  passExpiresAt: string | null,
): Promise<void> {
  const token = await AppSettings.getPushToken();
  if (!walletAddress || !token) return;
  const prefs = await loadPushPrefs();
  await upsertPushRegistration({
    walletAddress,
    expoPushToken: token,
    enabled: true,
    ...prefs,
    passExpiresAt,
  });
}

export async function updatePushPrefsOnServer(
  walletAddress: string | null,
  prefs: Partial<PushTokenPrefs>,
): Promise<void> {
  const token = await AppSettings.getPushToken();
  if (!walletAddress || !token) return;

  const current = await loadPushPrefs();
  await upsertPushRegistration({
    walletAddress,
    expoPushToken: token,
    enabled: true,
    notifyEpisodes: prefs.notifyEpisodes ?? current.notifyEpisodes,
    notifyChapters: prefs.notifyChapters ?? current.notifyChapters,
    notifyPass: prefs.notifyPass ?? current.notifyPass,
    notifyMarketing: prefs.notifyMarketing ?? current.notifyMarketing,
    passExpiresAt: prefs.passExpiresAt ?? undefined,
  });
}

/** Heartbeat so re-engagement crons know when the user last opened Sakura. */
export async function pingPushActivity(walletAddress: string | null): Promise<void> {
  const token = await AppSettings.getPushToken();
  if (!walletAddress || !token) return;

  const { error } = await supabase.functions.invoke('upsert-push-token', {
    body: { action: 'ping', expo_push_token: token },
    headers: await pushAuthHeaders(),
  });

  if (error) throw error;
}
