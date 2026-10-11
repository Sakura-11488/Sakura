export type InstallState = Readonly<{
  canPrompt: boolean;
  installed: boolean;
  busy: boolean;
}>;

export type InstallResult = 'accepted' | 'dismissed' | 'unavailable' | 'busy' | 'installed';

type InstallChoice = { outcome: 'accepted' | 'dismissed' };
type InstallPromptEvent = Event & {
  prompt(): Promise<InstallChoice | void>;
  userChoice?: Promise<InstallChoice>;
};

const serverState: InstallState = Object.freeze({ canPrompt: false, installed: false, busy: false });
let state = serverState;
let initialized = false;
let installedEventReceived = false;
let deferredPrompt: InstallPromptEvent | null = null;
let requestVersion = 0;
const listeners = new Set<() => void>();
const capturedEvents = new WeakSet<InstallPromptEvent>();
const displayModes: MediaQueryList[] = [];

function publish(next: InstallState): void {
  if (state.canPrompt === next.canPrompt && state.installed === next.installed && state.busy === next.busy) return;
  state = Object.freeze(next);
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One subscriber must not prevent prompt handling. */ }
  }
}

function updateInstalledState(): void {
  if (typeof window === 'undefined') return;
  const standalone = (window.navigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone === true;
  const installed = installedEventReceived || standalone || displayModes.some(mode => mode.matches);
  if (installed) {
    // Invalidate any outstanding choice so it cannot restore a consumed prompt.
    if (!state.installed || state.busy || deferredPrompt) requestVersion++;
    deferredPrompt = null;
    publish({ canPrompt: false, installed: true, busy: false });
  } else {
    publish({ canPrompt: !!deferredPrompt && !state.busy, installed: false, busy: state.busy });
  }
}

function capturePrompt(event: Event): void {
  const promptEvent = event as InstallPromptEvent;
  if (typeof promptEvent.prompt !== 'function') return;
  event.preventDefault();
  updateInstalledState();
  if (capturedEvents.has(promptEvent)) return;
  capturedEvents.add(promptEvent);
  if (state.installed || state.busy || deferredPrompt) return;
  deferredPrompt = promptEvent;
  publish({ canPrompt: true, installed: false, busy: false });
}

/** Start once for the page lifetime, independently of any banner or modal. */
export function initializeInstallPrompt(): void {
  if (initialized || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  initialized = true;
  window.addEventListener('beforeinstallprompt', capturePrompt);
  window.addEventListener('appinstalled', () => {
    installedEventReceived = true;
    updateInstalledState();
  });
  for (const mode of ['standalone', 'fullscreen', 'minimal-ui']) {
    try {
      const query = window.matchMedia?.(`(display-mode: ${mode})`);
      if (!query) continue;
      displayModes.push(query);
      if (typeof query.addEventListener === 'function') query.addEventListener('change', updateInstalledState);
      else query.addListener?.(updateInstalledState);
    } catch { /* Older browsers can omit media-query support. */ }
  }
  // iOS exposes navigator.standalone without a dedicated change event.
  window.addEventListener('pageshow', updateInstalledState);
  window.addEventListener('focus', updateInstalledState);
  updateInstalledState();
}

export function getInstallState(): InstallState {
  return state;
}

export function getServerInstallState(): InstallState {
  return serverState;
}

export function subscribeInstallState(listener: () => void): () => void {
  initializeInstallPrompt();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function finishRequest(version: number, result: InstallResult): InstallResult {
  if (version !== requestVersion) return state.installed ? 'installed' : 'unavailable';
  publish({ canPrompt: false, installed: state.installed, busy: false });
  return state.installed ? 'installed' : result;
}

/** Call directly from a click/tap handler to retain browser user activation. */
export function requestInstall(): Promise<InstallResult> {
  initializeInstallPrompt();
  updateInstalledState();
  if (state.installed) return Promise.resolve('installed');
  if (state.busy) return Promise.resolve('busy');
  const event = deferredPrompt;
  if (!event) return Promise.resolve('unavailable');

  // Each browser event is single-use. Consume it before notifying subscribers.
  deferredPrompt = null;
  const version = ++requestVersion;
  publish({ canPrompt: false, installed: false, busy: true });
  let prompted: Promise<InstallChoice | void>;
  try {
    // Keep this synchronous: no await or microtask may precede prompt().
    prompted = event.prompt();
  } catch {
    return Promise.resolve(finishRequest(version, 'unavailable'));
  }

  return Promise.resolve(prompted)
    .then(choice => choice ?? event.userChoice)
    .then(choice => finishRequest(version, choice?.outcome === 'accepted' || choice?.outcome === 'dismissed' ? choice.outcome : 'unavailable'))
    .catch(() => finishRequest(version, 'unavailable'));
}

initializeInstallPrompt();
