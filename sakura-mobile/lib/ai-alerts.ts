import * as Notifications from 'expo-notifications';
import { getCachedValue, setCachedValue } from '@/lib/cache';
import { resolveTokenMint, fetchTokenPrices } from '@/lib/wallet/token-price';

export type AlertDirection = 'above' | 'below';

export interface PriceAlert {
  id: string;
  token: string;
  mint: string;
  direction: AlertDirection;
  target: number;
  createdAt: number;
  triggeredAt?: number;
  lastPrice?: number;
}

const STORE_KEY = 'sakura_price_alerts_v1';

async function readAll(): Promise<PriceAlert[]> {
  const list = await getCachedValue<PriceAlert[]>(STORE_KEY);
  return Array.isArray(list) ? list : [];
}

async function writeAll(alerts: PriceAlert[]): Promise<void> {
  // Persist indefinitely; alerts are user state, not transient cache.
  await setCachedValue(STORE_KEY, alerts, 1000 * 60 * 60 * 24 * 365);
}

export async function listPriceAlerts(): Promise<{ active: PriceAlert[]; triggered: PriceAlert[] }> {
  const all = await readAll();
  return {
    active: all.filter((a) => !a.triggeredAt),
    triggered: all.filter((a) => a.triggeredAt),
  };
}

export async function setPriceAlert(
  token: string,
  direction: AlertDirection,
  target: number,
): Promise<{ ok: boolean; alert?: PriceAlert; error?: string; summary?: string }> {
  const mint = resolveTokenMint(token);
  if (!mint) return { ok: false, error: `I don't recognise the token "${token}".` };
  if (!Number.isFinite(target) || target <= 0) return { ok: false, error: 'Target price must be positive.' };

  const all = await readAll();
  const alert: PriceAlert = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    token: token.toUpperCase(),
    mint,
    direction,
    target,
    createdAt: Date.now(),
  };
  all.push(alert);
  await writeAll(all);
  const summary = `${alert.token} ${direction} $${target}`;
  return { ok: true, alert, summary };
}

export async function cancelPriceAlert(
  match: string,
): Promise<{ ok: boolean; removed: number; error?: string }> {
  const all = await readAll();
  const needle = (match || '').toLowerCase();
  const remaining = all.filter(
    (a) => a.id !== match && !`${a.token} ${a.direction} ${a.target}`.toLowerCase().includes(needle),
  );
  const removed = all.length - remaining.length;
  if (removed === 0) return { ok: false, removed: 0, error: 'No matching alert found.' };
  await writeAll(remaining);
  return { ok: true, removed };
}

/**
 * Evaluate active alerts against live prices. Fires a local notification for
 * each newly-triggered alert and marks it triggered. Best-effort and safe to
 * call on an interval from a background bridge.
 */
export async function checkPriceAlerts(): Promise<PriceAlert[]> {
  const all = await readAll();
  const active = all.filter((a) => !a.triggeredAt);
  if (active.length === 0) return [];

  const prices = await fetchTokenPrices(active.map((a) => a.mint));
  const triggered: PriceAlert[] = [];

  for (const alert of active) {
    const price = prices[alert.mint];
    if (price == null) continue;
    alert.lastPrice = price;
    const hit =
      (alert.direction === 'above' && price >= alert.target) ||
      (alert.direction === 'below' && price <= alert.target);
    if (hit) {
      alert.triggeredAt = Date.now();
      triggered.push(alert);
    }
  }

  if (triggered.length > 0) {
    await writeAll(all);
    for (const alert of triggered) {
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Sakura price alert',
            body: `${alert.token} is ${alert.direction} $${alert.target} (now $${alert.lastPrice?.toFixed(
              alert.lastPrice && alert.lastPrice < 1 ? 6 : 2,
            )}).`,
          },
          trigger: null,
        });
      } catch {
        // notification best-effort
      }
    }
  } else {
    await writeAll(all);
  }

  return triggered;
}
