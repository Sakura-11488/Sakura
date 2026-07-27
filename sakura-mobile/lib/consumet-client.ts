import {
  consumetCandidates,
  getActiveConsumetUrl,
  setActiveConsumetUrl,
} from './consumet-config';

// Re-exported so callers keep importing everything Consumet-related from one
// place. The shared state itself lives in `consumet-config`, which has no
// platform sibling — see the note there for why that separation is load-bearing.
export { consumetCandidates, getActiveConsumetUrl, setActiveConsumetUrl };

export async function consuGet(
  path: string,
  timeoutMs = 15000,
  retries = 2,
): Promise<Record<string, unknown>> {
  const bases = consumetCandidates();
  if (bases.length === 0) throw new Error('CONSUMET_URL not set');

  const active = getActiveConsumetUrl();
  const orderedBases = [
    active,
    ...bases.filter((b) => b !== active),
  ].filter(Boolean) as string[];

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));

    for (const base of orderedBases) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${base}${path}`, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json', 'User-Agent': 'Sakura/1.0' },
        });
        if (!res.ok) throw new Error(`Consumet HTTP ${res.status}`);
        const data = await res.json() as Record<string, unknown>;
        if (data?.code === 20) {
          lastErr = new Error('Consumet server aborted');
          break;
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
          break;
        }
        setActiveConsumetUrl(base);
        return data;
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(t);
      }
    }
  }
  throw lastErr;
}
