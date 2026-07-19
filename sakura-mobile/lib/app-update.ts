import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

// Native-only "new version available" check. The web build is always served
// fresh, so there is nothing to prompt there — every entry point here is a no-op
// on web. The manifest is a small JSON hosted on the Sakura site describing the
// latest shipped APK; bump it whenever a new Seeker release goes out.
const MANIFEST_URL = 'https://sakuraonseeker.com/app-update.json';
const DISMISSED_KEY = 'sakura_dismissed_update_version';

export interface AppUpdateInfo {
  /** Latest available semver, e.g. "2.0.2". */
  version: string;
  /** Where "Update Now" sends the user (release page or direct APK). */
  apkUrl: string;
  releaseNotes: string;
  /** When true, the "Later" affordance is hidden. */
  forceUpdate: boolean;
}

export const CURRENT_APP_VERSION = Constants.expoConfig?.version ?? '0.0.0';

function parseSemver(v: string): number[] {
  return String(v).trim().split('.').map((n) => parseInt(n, 10) || 0);
}

/** >0 when a is newer than b, <0 when older, 0 when equal. */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Fetch the release manifest and decide whether to prompt. Returns null when the
 * app is current, on any network/parse error, on web, or when the user already
 * tapped "Later" on this exact version (unless the release is a forced update).
 */
export async function checkForAppUpdate(): Promise<AppUpdateInfo | null> {
  if (Platform.OS === 'web') return null;
  try {
    const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const m = (await res.json()) as Record<string, unknown>;
    const version = typeof m.version === 'string' ? m.version : '';
    const apkUrl = typeof m.apkUrl === 'string' ? m.apkUrl : '';
    if (!version || !apkUrl) return null;
    if (compareSemver(version, CURRENT_APP_VERSION) <= 0) return null; // already current

    const forceUpdate = m.forceUpdate === true;
    if (!forceUpdate) {
      const dismissed = await SecureStore.getItemAsync(DISMISSED_KEY);
      if (dismissed === version) return null; // user chose "Later" for this exact version
    }

    return {
      version,
      apkUrl,
      releaseNotes: typeof m.releaseNotes === 'string' ? m.releaseNotes : '',
      forceUpdate,
    };
  } catch {
    return null;
  }
}

/** Remember that the user dismissed this version so we don't nag on every launch. */
export async function dismissAppUpdate(version: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(DISMISSED_KEY, version);
  } catch {
    // non-fatal — worst case the prompt shows again next launch
  }
}
