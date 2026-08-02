import { Share } from 'react-native';
import { showAlert } from '@/lib/confirm-alert';

/**
 * Public web-app origin for share links.
 *
 * Shares must be openable by people who do NOT have the native app — which a
 * `sakura://` custom scheme is not: most chat apps refuse to even linkify it,
 * and tapping it without the APK installed does nothing. The https PWA URL
 * opens for everyone; native remains reachable through it.
 */
export const WEB_APP_BASE = 'https://sakuraonseeker.com/app';

/**
 * Share `message` with an https link to `path` (app-relative, leading slash).
 *
 * Falls back to copying the link when no share sheet exists — react-native-web
 * rejects `Share.share` on browsers without `navigator.share` (most desktops),
 * which otherwise turns the share button into a silent no-op. A user dismissing
 * the share sheet (AbortError) is respected, not treated as a failure.
 */
export async function shareContentLink(message: string, path: string): Promise<void> {
  const text = `${message}\n${WEB_APP_BASE}${path}`;
  try {
    await Share.share({ message: text });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    try {
      await navigator.clipboard.writeText(text);
      showAlert('Link copied', 'Paste it anywhere to share.');
    } catch {
      showAlert('Share this link', text);
    }
  }
}
