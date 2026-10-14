import React, { useEffect, useState, useSyncExternalStore } from 'react';

type DeviceSave = typeof import('@/lib/anime-device-save');

/**
 * The video-save store is imported after the app has rendered, not with it.
 *
 * The root layout mounts this banner on every screen, and the store module
 * brings the MP4/MOV muxer (mux.js) with it: about 120KB that every cold start
 * downloaded and ran for a banner that only appears after someone asks for a
 * video file. Waiting cannot lose a save: saves are only started from screens
 * that import the same module themselves, and the store holds nothing across
 * reloads, so the snapshot read on subscribe is always complete.
 */
let deviceSave: Promise<DeviceSave> | null = null;
// An async wrapper rather than import(...).catch(): on web, Expo's import()
// returns a bare thenable (no .catch) and can throw synchronously.
const importDeviceSave = async (): Promise<DeviceSave> => import('@/lib/anime-device-save');
const loadDeviceSave = () => (deviceSave ??= importDeviceSave().catch((error) => {
  deviceSave = null;
  throw error;
}));

/** Upper bound on the wait for an idle moment; the banner is never urgent. */
const LOAD_TIMEOUT_MS = 4000;
const RETRY_MS = 15000;

const styles = `
.sakura-video-save{position:fixed;z-index:9999;right:max(16px,env(safe-area-inset-right));bottom:max(20px,env(safe-area-inset-bottom));width:min(430px,calc(100vw - 32px));max-height:calc(100dvh - 110px);overflow:auto;box-sizing:border-box;padding:18px;border:1px solid #ffffff26;border-radius:16px;background:#19171ff5;color:#f6f3f8;box-shadow:0 12px 50px #0008;font:13px/1.5 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;backdrop-filter:blur(16px)}
.sakura-video-save *{box-sizing:border-box}.sakura-video-save h2{margin:0 60px 4px 0;font-size:16px;line-height:1.4}.sakura-video-save p{margin:7px 0;color:#c4bdcd}.sakura-video-save .svs-title{margin:0;overflow-wrap:anywhere;color:#f6f3f8}.sakura-video-save .svs-dismiss{position:absolute;top:9px;right:10px;min-width:44px;min-height:44px;background:transparent;color:#c4bdcd;border:0;font:inherit;cursor:pointer}.sakura-video-save .svs-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.sakura-video-save .svs-actions button,.sakura-video-save .svs-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:9px 13px;border:1px solid #ffffff26;border-radius:8px;background:#ffffff09;color:inherit;text-decoration:none;font:inherit;font-weight:650;cursor:pointer}.sakura-video-save .svs-actions .svs-primary{background:#ff626b;border-color:#ff626b;color:#210b10}.sakura-video-save button:disabled{opacity:.6;cursor:wait}.sakura-video-save button:focus-visible,.sakura-video-save a:focus-visible{outline:2px solid #ffabb0;outline-offset:3px}.sakura-video-save progress{display:block;width:100%;height:8px;margin-top:12px;accent-color:#ff626b}.sakura-video-save .svs-error{color:#ffabb0}.sakura-video-save .svs-filename{font-size:11px;overflow-wrap:anywhere}.sakura-video-save .svs-queue{font-size:11px}
@media(max-width:600px){.sakura-video-save{left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));width:auto;padding:15px;max-height:calc(100dvh - 160px)}}
`;

const serverSnapshot = () => null;

export default function AnimeDeviceSaveBanner() {
  const [store, setStore] = useState<DeviceSave | null>(null);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      loadDeviceSave().then((mod) => {
        if (active) setStore(mod);
      }, () => {
        // Only possible offline with the chunk not cached yet. Keep trying:
        // a screen that starts a save may well load the module later.
        if (active) retry = setTimeout(load, RETRY_MS);
      });
    };
    const idle = typeof requestIdleCallback === 'function'
      ? requestIdleCallback(load, { timeout: LOAD_TIMEOUT_MS })
      : undefined;
    if (idle === undefined) retry = setTimeout(load, 0);
    return () => {
      active = false;
      if (idle !== undefined) cancelIdleCallback(idle);
      clearTimeout(retry);
    };
  }, []);

  return store ? <SaveBanner store={store} /> : null;
}

function SaveBanner({ store }: { store: DeviceSave }) {
  const {
    dismissAnimeDeviceSave,
    getAnimeDeviceSaveSnapshot,
    retryAnimeDeviceSave,
    shareAnimeDeviceVideo,
    startAnimeDeviceDownload,
    subscribeAnimeDeviceSave,
  } = store;
  const save = useSyncExternalStore(subscribeAnimeDeviceSave, getAnimeDeviceSaveSnapshot, serverSnapshot);
  const [sharingKey, setSharingKey] = useState<string | null>(null);
  const [shareError, setShareError] = useState<{ key: string; text: string } | null>(null);
  if (!save) return null;

  const preparing = save.status === 'preparing';
  const ready = save.status === 'ready';
  const videoFormat = /\.mov$/i.test(save.filename) ? 'MOV' : 'MP4';
  const progress = Math.round(Math.max(0, Math.min(1, save.progress || 0)) * 100);
  const heading = preparing ? 'Preparing video file' : ready ? save.downloadStarted ? 'Video download started' : 'Video file ready' : 'Could not prepare video';
  const share = () => {
    if (sharingKey === save.key) return;
    setSharingKey(save.key);
    setShareError(null);
    // Invoke directly from the click so the browser retains user activation.
    void shareAnimeDeviceVideo().catch(error => {
      if (error?.name !== 'AbortError') {
        setShareError({ key: save.key, text: error instanceof Error ? error.message : 'Could not open the save menu. Try Download MP4.' });
      }
    }).finally(() => setSharingKey(key => key === save.key ? null : key));
  };

  return <aside className="sakura-video-save" role="region" aria-label="Video file download">
    <style>{styles}</style>
    <button className="svs-dismiss" onClick={dismissAnimeDeviceSave} aria-label={preparing ? 'Cancel video preparation' : 'Dismiss video download'}>{preparing ? 'Cancel' : 'Close'}</button>
    <div role="status" aria-live="polite" aria-atomic="true"><h2>{heading}</h2></div>
    <p className="svs-title">{save.title}</p>
    {preparing ? <>
      <p>Keep Sakura open while your video is prepared. Your episode stays saved in Sakura.</p>
      <progress value={progress} max={100} aria-label="Video file preparation" />
      <p className="svs-filename">{progress}%</p>
    </> : ready ? <>
      <p>{save.downloadStarted ? `Check your browser’s downloads. If the file did not appear, tap Download ${videoFormat}.` : `Download the ${videoFormat} to keep a video file on your device.`}</p>
      <p className="svs-filename">{save.filename}</p>
      <div className="svs-actions">
        <button className="svs-primary" onClick={startAnimeDeviceDownload}>Download {videoFormat}</button>
        {save.canShare && <button onClick={share} disabled={sharingKey === save.key}>{sharingKey === save.key ? 'Opening…' : 'Save / share'}</button>}
        {save.subtitle && <a href={save.subtitle.url} download={save.subtitle.filename}>Download subtitles ({save.subtitle.label})</a>}
      </div>
      {save.canShare && <p>Use Save / share to choose a media app, or Save Video if your device offers it.</p>}
      {(save.error || shareError?.key === save.key) && <p className="svs-error" role="alert">{save.error || shareError?.text}</p>}
    </> : <>
      <p className="svs-error">{save.error || 'The video file could not be created.'}</p>
      <p>Preparing a video does not delete your saved episode.</p>
      <div className="svs-actions"><button className="svs-primary" onClick={retryAnimeDeviceSave}>Retry video save</button></div>
    </>}
    {save.queued > 0 && <p className="svs-queue">{save.queued} more video{save.queued === 1 ? '' : 's'} queued.{!preparing && ' Close this banner to prepare the next video.'}</p>}
  </aside>;
}
