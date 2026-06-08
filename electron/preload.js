const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  /** Authoritative URL for the bundled hianime-node bridge (see main.js HIANIME_PORT). Renderer env can be missing/wrong in packaged builds. */
  hianimeBridgeUrl: 'http://127.0.0.1:4789',

  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  writeFile: (relativePath, base64Data) => ipcRenderer.invoke('fs-write-file', relativePath, base64Data),
  readFile: (relativePath) => ipcRenderer.invoke('fs-read-file', relativePath),
  deleteFile: (relativePath) => ipcRenderer.invoke('fs-delete', relativePath),
  exists: (relativePath) => ipcRenderer.invoke('fs-exists', relativePath),
  setStreamReferer: (referer) => ipcRenderer.invoke('set-stream-referer', referer),

  /** Renderer never holds the AI provider key — it ships messages only and the main process attaches the secret. */
  sakuraAiChat: (payload) => ipcRenderer.invoke('sakura-ai:chat', payload),
  sakuraAiConfigured: () => ipcRenderer.invoke('sakura-ai:configured'),

  /** Phoenix Trade in-app browser + Sakura wallet bridge */
  openPhoenix: (options) => ipcRenderer.invoke('phoenix:open', options || {}),
  closePhoenix: () => ipcRenderer.invoke('phoenix:close'),
  isPhoenixOpen: () => ipcRenderer.invoke('phoenix:is-open').then((r) => Boolean(r?.open)),
  onPhoenixWalletRequest: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('phoenix:wallet-request', listener);
    return () => ipcRenderer.removeListener('phoenix:wallet-request', listener);
  },
  respondPhoenixWallet: (requestId, result, error) =>
    ipcRenderer.invoke('phoenix:wallet-response', { requestId, result, error }),
});
