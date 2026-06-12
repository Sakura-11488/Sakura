import { useEffect } from 'react';
import { AppState } from 'react-native';
import { checkPriceAlerts } from '@/lib/ai-alerts';

/**
 * Polls active Sakura AI price alerts and fires a local notification when one
 * crosses its target. Lightweight and best-effort: runs while the app is in the
 * foreground and re-checks on resume.
 */
export default function PriceAlertBridge() {
  useEffect(() => {
    let mounted = true;
    const run = () => {
      if (mounted) checkPriceAlerts().catch(() => {});
    };

    run();
    const interval = setInterval(run, 60_000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });

    return () => {
      mounted = false;
      clearInterval(interval);
      sub.remove();
    };
  }, []);

  return null;
}
