import { invokeContentProxy } from '@/lib/content-proxy-client';
import {
  consumetCandidates,
  getActiveConsumetUrl,
  setActiveConsumetUrl,
} from '@/lib/consumet-client';

export { consumetCandidates, getActiveConsumetUrl, setActiveConsumetUrl };

export async function consuGet(
  path: string,
  _timeoutMs = 15000,
  retries = 2,
): Promise<Record<string, unknown>> {
  const bases = consumetCandidates();
  if (bases.length === 0) throw new Error('CONSUMET_URL not set');

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));
    try {
      const data = await invokeContentProxy<Record<string, unknown>>({
        source: 'consumet',
        path,
      });
      if (data?.code === 20) {
        lastErr = new Error('Consumet server aborted');
        continue;
      }
      if (data?.error) {
        const errMsg = String(data.error);
        const code = String(data.code || '');
        if (
          code === 'ANIME_ID_NOT_FOUND' ||
          errMsg.includes('HTTP 404') ||
          errMsg.includes('Could not resolve animeId')
        ) {
          throw new Error(errMsg);
        }
        lastErr = new Error(errMsg);
        continue;
      }
      const active = getActiveConsumetUrl() || bases[0];
      if (active) setActiveConsumetUrl(active);
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
