export type EmbedBridgeMode = 'cookies' | 'fetch' | 'document';

export type EmbedBridgeJob = {
  id: string;
  embedUrl: string;
  targetUrl?: string;
  referer?: string;
  mode?: EmbedBridgeMode;
};

export type EmbedBridgeResult = {
  cookies: string;
  text?: string;
};

type Pending = {
  resolve: (r: EmbedBridgeResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();
const partialCookies = new Map<string, string>();

let activeJob: EmbedBridgeJob | null = null;
let setJob: ((job: EmbedBridgeJob | null) => void) | null = null;

const BRIDGE_TIMEOUT_MS = 120_000;

export function registerAnimeDownloadBridge(setter: (job: EmbedBridgeJob | null) => void) {
  setJob = setter;
  return () => {
    if (setJob === setter) setJob = null;
  };
}

export function getActiveEmbedBridgeJob(): EmbedBridgeJob | null {
  return activeJob;
}

function settleJob(id: string, result: EmbedBridgeResult) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  partialCookies.delete(id);
  p.resolve(result);
  if (pending.size === 0) {
    activeJob = null;
    setJob?.(null);
  }
}

function failJob(id: string, message: string) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  partialCookies.delete(id);
  p.reject(new Error(message));
  if (pending.size === 0) {
    activeJob = null;
    setJob?.(null);
  }
}

export function reportEmbedBridgeLoadError(id: string, description: string) {
  const lower = description.toLowerCase();
  const msg = lower.includes('load failed') || lower === 'load failed'
    ? 'Player could not connect. Stay on Wi‑Fi, keep the app open, and tap download again.'
    : lower.includes('load')
      ? `Player issue: ${description}. Stay on Wi‑Fi and try again.`
      : `Player page failed (${description}). Stay on Wi‑Fi and try again.`;
  failJob(id, msg);
}

export function onEmbedBridgeCookies(id: string, cookies: string) {
  partialCookies.set(id, cookies);
  const job = activeJob;
  if (!job || job.id !== id || job.mode !== 'cookies') return;
  settleJob(id, { cookies: cookies || '' });
}

export function onEmbedBridgeFetch(
  id: string,
  payload: { ok: boolean; text?: string; error?: string },
) {
  const cookies = partialCookies.get(id) || '';
  if (!payload.ok) {
    const err = (payload.error || '').toLowerCase();
    const msg =
      err.includes('playlist') && err.includes('webview')
        ? 'Playlist fetch via WebView failed.'
        : err.includes('no iframe') || err.includes('cross-origin')
          ? 'Stream blocked from player page.'
          : payload.error || 'Stream fetch failed (CDN blocked or offline).';
    failJob(id, msg);
    return;
  }
  if (payload.text == null) {
    failJob(id, 'Empty stream response from CDN.');
    return;
  }
  settleJob(id, { cookies, text: payload.text });
}

export function runEmbedBridge(job: Omit<EmbedBridgeJob, 'id'>): Promise<EmbedBridgeResult> {
  return new Promise((resolve, reject) => {
    // No native WebView bridge is registered on web (AnimeDownloadBridge.web
    // renders nothing), so a job would otherwise hang for the full 120s timeout.
    // Reject immediately with a clear, actionable message instead.
    if (!setJob) {
      reject(new Error('Video downloads are available in the Sakura mobile app.'));
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const full: EmbedBridgeJob = { ...job, id };
    const timer = setTimeout(() => {
      failJob(id, 'Download timed out. Check your connection and try again.');
    }, BRIDGE_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    activeJob = full;
    setJob?.(full);
  });
}

export function fetchTextViaEmbed(
  embedUrl: string,
  targetUrl: string,
  referer?: string,
): Promise<string> {
  return runEmbedBridge({ embedUrl, targetUrl, referer }).then((r) => {
    if (r.text == null) throw new Error('Fetch failed in player context');
    return r.text;
  });
}
