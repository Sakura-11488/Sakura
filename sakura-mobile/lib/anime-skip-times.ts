export interface AnimeSkipInterval { start: number; end: number }
export interface AnimeSkipMarkers { intro?: AnimeSkipInterval; outro?: AnimeSkipInterval }

const API_BASE = 'https://api.aniskip.com/v2';
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DURATION_DIFFERENCE = 2;
const CACHE_LIMIT = 100;
const cache = new Map<string, { markers: AnimeSkipMarkers; expiresAt: number }>();
const requests = new Map<string, number>();
let sequence = 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function clone(markers: AnimeSkipMarkers): AnimeSkipMarkers {
  return {
    ...(markers.intro ? { intro: { ...markers.intro } } : {}),
    ...(markers.outro ? { outro: { ...markers.outro } } : {}),
  };
}

export function validateAnimeSkipInterval(value: unknown, durationSeconds: number): AnimeSkipInterval | undefined {
  if (!value || typeof value !== 'object' || !finite(durationSeconds) || durationSeconds <= 0) return;
  const { start, end } = value as Partial<AnimeSkipInterval>;
  if (!finite(start) || !finite(end) || start < 0 || end <= start || end > durationSeconds) return;
  return { start, end };
}

/** Valid source timings win; fallback timings fill only missing/invalid markers. */
export function mergeAnimeSkipMarkers(
  primary: AnimeSkipMarkers | null | undefined,
  fallback: AnimeSkipMarkers | null | undefined,
  durationSeconds: number,
): AnimeSkipMarkers {
  const intro = validateAnimeSkipInterval(primary?.intro, durationSeconds)
    ?? validateAnimeSkipInterval(fallback?.intro, durationSeconds);
  const outro = validateAnimeSkipInterval(primary?.outro, durationSeconds)
    ?? validateAnimeSkipInterval(fallback?.outro, durationSeconds);
  return { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) };
}

/** Accept only a matching cut, not arbitrary timings from another episode duration. */
export function parseAnimeSkipTimes(payload: unknown, durationSeconds: number): AnimeSkipMarkers {
  if (!payload || typeof payload !== 'object' || !finite(durationSeconds) || durationSeconds <= 0) return {};
  const data = payload as { found?: unknown; results?: unknown };
  if (data.found !== true || !Array.isArray(data.results) || data.results.length > 20) return {};
  const markers: AnimeSkipMarkers = {};
  for (const value of data.results) {
    if (!value || typeof value !== 'object') continue;
    const row = value as { skipType?: unknown; episodeLength?: unknown; interval?: { startTime?: unknown; endTime?: unknown } };
    const kind = row.skipType === 'op' ? 'intro' : row.skipType === 'ed' ? 'outro' : null;
    if (!kind || markers[kind] || !finite(row.episodeLength) || row.episodeLength <= 0) continue;
    const offset = durationSeconds - row.episodeLength;
    if (Math.abs(offset) > MAX_DURATION_DIFFERENCE) continue;
    const start = row.interval?.startTime;
    const end = row.interval?.endTime;
    if (!finite(start) || !finite(end) || start < 0 || end > row.episodeLength) continue;
    // The official AniSkip extension uses this offset for playback alignment:
    // https://github.com/aniskip/aniskip-extension/blob/main/src/players/base-player.ts
    const interval = validateAnimeSkipInterval({ start: start + offset, end: end + offset }, durationSeconds);
    if (interval) markers[kind] = interval;
  }
  return markers;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Response too large');
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Aborted');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Response too large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

/**
 * Optional, public timing lookup. Requires measured duration; failures never block playback.
 * API contract: https://github.com/aniskip/aniskip-extension/blob/main/src/api/aniskip-http-client/aniskip-http-client.ts
 * Cancel on episode/category/source changes; force bypasses the short in-memory cache.
 */
export async function fetchAnimeSkipTimes(
  malId: string | number,
  episode: number,
  durationSeconds: number,
  options: { signal?: AbortSignal; force?: boolean; fetch?: typeof fetch } = {},
): Promise<AnimeSkipMarkers> {
  const id = String(malId);
  if (!/^[1-9]\d{0,8}$/.test(id) || !Number.isInteger(episode) || episode < 1 || episode > 50_000
    || !finite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86_400 || options.signal?.aborted) return {};
  const duration = durationSeconds.toFixed(3);
  const key = `${id}:${episode}:${duration}`;
  const existing = cache.get(key);
  if (!options.force && existing && existing.expiresAt > Date.now()) return clone(existing.markers);
  cache.delete(key);
  const request = ++sequence;
  requests.set(key, request);
  // Bound bookkeeping even when a transport ignores aborts and never settles.
  if (requests.size > CACHE_LIMIT) requests.delete(requests.keys().next().value!);

  const controller = new AbortController();
  let resolveAbort: (value: AnimeSkipMarkers) => void = () => {};
  const aborted = new Promise<AnimeSkipMarkers>((resolve) => { resolveAbort = resolve; });
  const abort = () => { controller.abort(); resolveAbort({}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, TIMEOUT_MS);
  const url = new URL(`${API_BASE}/skip-times/${id}/${episode}`);
  url.searchParams.append('types', 'op');
  url.searchParams.append('types', 'ed');
  url.searchParams.set('episodeLength', duration);
  const task = (async (): Promise<AnimeSkipMarkers> => {
    try {
      const response = await (options.fetch ?? fetch)(url.toString(), {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok && response.status !== 404) {
        await response.body?.cancel().catch(() => {});
        return {};
      }
      const payload = await readJson(response, controller.signal);
      if (controller.signal.aborted || requests.get(key) !== request) return {};
      const markers = parseAnimeSkipTimes(payload, durationSeconds);
      // Only an explicit valid API answer may be cached, never a network/format error.
      const answer = payload as { found?: unknown; results?: unknown } | null;
      if (answer && (answer.found === false || (answer.found === true && Array.isArray(answer.results)))) {
        cache.set(key, { markers, expiresAt: Date.now() + (markers.intro || markers.outro ? 300_000 : 30_000) });
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      return clone(markers);
    } catch { return {}; }
  })();
  try { return await Promise.race([task, aborted]); }
  finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    if (requests.get(key) === request) requests.delete(key);
  }
}
