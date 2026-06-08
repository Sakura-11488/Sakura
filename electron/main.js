const { app, BrowserWindow, protocol, shell, session, nativeImage, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

let currentStreamReferer = '';

// Local-only AI key loader. The file is gitignored and read at runtime so the
// renderer bundle (and its DevTools) can never see the secret. Calls are
// proxied through ipcMain.handle('sakura-ai:chat'), so the only thing that
// touches the wire from the renderer is the messages payload.
function loadSakuraAiConfig() {
  const candidates = [
    path.join(__dirname, 'sakura-ai.config.json'),
    path.join(path.dirname(app.getAppPath()), 'app.asar.unpacked', 'electron', 'sakura-ai.config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const cfg = JSON.parse(raw);
        if (cfg && typeof cfg.groqKey === 'string' && cfg.groqKey.length > 0) {
          return { groqKey: cfg.groqKey };
        }
      }
    } catch (_) {}
  }
  return { groqKey: '' };
}

const SAKURA_AI_CONFIG = loadSakuraAiConfig();

// Register app:// as a privileged scheme BEFORE app is ready.
// This gives it a proper origin (not null), enabling localStorage,
// cookies, fetch, and correct CORS behavior.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    allowServiceWorkers: true,
  }
}]);

const OUT_DIR = path.join(__dirname, '..', 'out');
const HIANIME_PORT = 4789;

function getIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'app-icon.png'),
    path.join(__dirname, '..', 'build', 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

let mainWindow;
let phoenixWindow = null;
let phoenixConfig = { publicKey: null, autoConnect: false };
const phoenixPendingRequests = new Map();
let hianimeProcess = null;

function getHianimeServerPath() {
  // In a packaged app, prefer the asar.unpacked copy. The path inside app.asar
  // would also pass fs.existsSync via Electron's asar shim, but Windows cannot
  // spawn with a cwd that lives inside the archive — so the child would never
  // start and port 4789 would stay closed.
  if (app.isPackaged) {
    const unpackedPath = path.join(
      path.dirname(app.getAppPath()),
      'app.asar.unpacked',
      'hianime-node',
      'server.js'
    );
    if (fs.existsSync(unpackedPath)) return unpackedPath;
  }

  const devPath = path.join(__dirname, '..', 'hianime-node', 'server.js');
  if (fs.existsSync(devPath)) return devPath;

  const unpackedPath = path.join(
    path.dirname(app.getAppPath()),
    'app.asar.unpacked',
    'hianime-node',
    'server.js'
  );
  if (fs.existsSync(unpackedPath)) return unpackedPath;

  return devPath;
}

function startHianimeServer() {
  const serverPath = getHianimeServerPath();
  if (!fs.existsSync(serverPath)) {
    console.warn('[hianime] server.js not found at', serverPath);
    return;
  }

  const serverCwd = path.dirname(serverPath);
  hianimeProcess = spawn(process.execPath, ['--no-warnings', serverPath], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PORT: String(HIANIME_PORT),
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  hianimeProcess.on('error', (err) => {
    console.error('[hianime] process error', err);
  });

  hianimeProcess.stdout.on('data', (data) => {
    console.log('[hianime]', data.toString().trim());
  });

  hianimeProcess.stderr.on('data', (data) => {
    console.error('[hianime]', data.toString().trim());
  });

  hianimeProcess.on('exit', (code, signal) => {
    console.warn('[hianime] bridge process exited', { code, signal, serverPath, cwd: serverCwd });
    hianimeProcess = null;
  });

  console.log('[hianime] spawning bridge', { port: HIANIME_PORT, serverPath, cwd: serverCwd });
}

function stopHianimeServer() {
  if (hianimeProcess) {
    hianimeProcess.kill();
    hianimeProcess = null;
  }
}

/** Wait until the local bridge answers so the first /api/search does not race a slow Node child (otherwise episodes stay at 0 until manual refresh). */
function waitForHianimeReady(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function attempt() {
      const req = http.get(`http://127.0.0.1:${HIANIME_PORT}/`, (res) => {
        try {
          res.resume();
        } catch (_) {}
        resolve(true);
      });
      req.setTimeout(1500);
      req.on('timeout', () => {
        req.destroy();
        scheduleRetry();
      });
      req.on('error', scheduleRetry);
    }
    function scheduleRetry() {
      if (Date.now() - start > timeoutMs) {
        console.warn('[hianime] Local bridge did not become ready in time; episode lists may fail until reload');
        resolve(false);
        return;
      }
      setTimeout(attempt, 250);
    }
    attempt();
  });
}

const PHOENIX_URL = 'https://www.phoenix.trade/';
const PHOENIX_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function rejectAllPhoenixPending(reason) {
  for (const pending of phoenixPendingRequests.values()) {
    pending.reject(reason);
  }
  phoenixPendingRequests.clear();
}

function createPhoenixWindow() {
  if (phoenixWindow && !phoenixWindow.isDestroyed()) {
    phoenixWindow.focus();
    return phoenixWindow;
  }

  const iconPath = getIconPath();
  const phoenixSession = session.fromPartition('persist:phoenix');

  const windowOpts = {
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Phoenix — Sakura Perps',
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'phoenix-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: phoenixSession,
      webSecurity: true,
    },
    show: false,
  };

  if (iconPath) {
    windowOpts.icon = nativeImage.createFromPath(iconPath);
  }

  phoenixWindow = new BrowserWindow(windowOpts);
  phoenixWindow.removeMenu();
  phoenixWindow.webContents.setUserAgent(PHOENIX_USER_AGENT);

  phoenixWindow.once('ready-to-show', () => {
    if (phoenixWindow && !phoenixWindow.isDestroyed()) {
      phoenixWindow.show();
    }
  });

  phoenixWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      shell.openExternal(targetUrl);
    }
    return { action: 'deny' };
  });

  phoenixWindow.on('closed', () => {
    phoenixWindow = null;
    rejectAllPhoenixPending(new Error('Phoenix window closed'));
  });

  phoenixWindow.loadURL(PHOENIX_URL);
  return phoenixWindow;
}

function createWindow() {
  const iconPath = getIconPath();

  const windowOpts = {
    width: 1280,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Sakura',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: true,
      spellcheck: false,
    },
    show: false,
  };

  if (iconPath) {
    windowOpts.icon = nativeImage.createFromPath(iconPath);
  }

  mainWindow = new BrowserWindow(windowOpts);
  mainWindow.removeMenu();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadURL('app://sakura/index.html');

  mainWindow.webContents.once('did-finish-load', () => {
    if (!app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      shell.openExternal(targetUrl);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });
}

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('enable-features', 'BackForwardCache');

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    let requestPath = decodeURIComponent(new URL(request.url).pathname);

    if (requestPath === '/' || requestPath === '') {
      requestPath = '/index.html';
    }

    let filePath = path.join(OUT_DIR, requestPath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (!fs.existsSync(filePath)) {
      const withHtml = filePath + '.html';
      if (fs.existsSync(withHtml)) {
        filePath = withHtml;
      }
    }

    if (!fs.existsSync(filePath)) {
      filePath = path.join(OUT_DIR, 'index.html');
    }

    return new Response(fs.readFileSync(filePath), {
      headers: { 'Content-Type': getMimeType(filePath) },
    });
  });

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const url = new URL(details.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        const hostMatch = (
          url.hostname.includes('megacloud') ||
          url.hostname.includes('rapid-cloud') ||
          url.hostname.includes('vidcloud') ||
          url.hostname.includes('rabbitstream') ||
          url.hostname.includes('biananset') ||
          url.hostname.includes('uwucdn') ||
          url.hostname.includes('kwik') ||
          url.hostname.includes('cache') ||
          url.hostname.includes('vault')
        );
        const isMediaResource = details.resourceType === 'media';
        const isStreamingUrl = url.pathname.endsWith('.m3u8') || url.pathname.endsWith('.key') || /segment-\d+/i.test(url.pathname);
        const isStreaming = hostMatch || isMediaResource || isStreamingUrl;

        if (isStreaming && currentStreamReferer) {
          delete details.requestHeaders['Origin'];
          delete details.requestHeaders['origin'];
          details.requestHeaders['Referer'] = currentStreamReferer;
        } else if (isStreaming) {
          delete details.requestHeaders['Origin'];
          delete details.requestHeaders['origin'];
          details.requestHeaders['Referer'] = 'https://hianime.dk/';
        }
      }
    } catch (_) {}
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };

    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    headers['Content-Security-Policy'] = [
      "default-src 'self' app: https: http: data: blob:; " +
      "script-src 'self' app: 'unsafe-inline' 'unsafe-eval' https:; " +
      "style-src 'self' app: 'unsafe-inline' https:; " +
      "img-src 'self' app: https: http: data: blob:; " +
      "media-src 'self' app: https: http: data: blob:; " +
      "connect-src 'self' app: https: http: wss: ws:; " +
      "font-src 'self' app: https: data:;"
    ];

    try {
      const url = new URL(details.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        // Remove any existing CORS headers first to prevent duplication
        const keysToRemove = Object.keys(headers).filter(k =>
          k.toLowerCase() === 'access-control-allow-origin' ||
          k.toLowerCase() === 'access-control-allow-headers' ||
          k.toLowerCase() === 'access-control-allow-methods'
        );
        for (const k of keysToRemove) delete headers[k];

        headers['Access-Control-Allow-Origin'] = ['*'];
        headers['Access-Control-Allow-Headers'] = ['*'];
        headers['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
      }
    } catch (_) {}

    callback({ responseHeaders: headers });
  });

  ipcMain.handle('set-stream-referer', (_event, referer) => {
    currentStreamReferer = referer || '';
  });

  // Sakura AI chat proxy. Renderer ships {messages, tools, model?} only.
  // The provider key lives in this main process and is appended here, so it
  // never reaches the renderer bundle, DevTools, or shipped sourcemaps.
  ipcMain.handle('sakura-ai:chat', async (_event, payload) => {
    if (!SAKURA_AI_CONFIG.groqKey) {
      throw new Error('Sakura AI is not configured on this device.');
    }
    const body = JSON.stringify({
      model: payload?.model || 'llama-3.1-8b-instant',
      messages: Array.isArray(payload?.messages) ? payload.messages : [],
      tools: Array.isArray(payload?.tools) ? payload.tools : undefined,
      tool_choice: payload?.tools && payload.tools.length ? 'auto' : undefined,
      temperature: typeof payload?.temperature === 'number' ? payload.temperature : 0.4,
      max_tokens: typeof payload?.max_tokens === 'number' ? payload.max_tokens : 1500,
    });
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          method: 'POST',
          hostname: 'api.groq.com',
          path: '/openai/v1/chat/completions',
          headers: {
            Authorization: `Bearer ${SAKURA_AI_CONFIG.groqKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            // Groq returns retry hints for 429s. Forward the most useful ones
            // so the renderer can back off the right amount instead of
            // bursting again immediately.
            const headers = res.headers || {};
            const pickHeader = (name) => {
              const v = headers[name];
              return Array.isArray(v) ? v[0] : v;
            };
            const retryAfterRaw = pickHeader('retry-after');
            const resetReqRaw = pickHeader('x-ratelimit-reset-requests');
            const resetTokRaw = pickHeader('x-ratelimit-reset-tokens');
            const parseSecondsLike = (raw) => {
              if (!raw || typeof raw !== 'string') return null;
              const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h)?/i);
              if (!m) return null;
              const n = Number(m[1]);
              if (!Number.isFinite(n)) return null;
              const unit = (m[2] || 's').toLowerCase();
              if (unit === 'ms') return n / 1000;
              if (unit === 'm') return n * 60;
              if (unit === 'h') return n * 3600;
              return n;
            };
            const candidates = [retryAfterRaw, resetReqRaw, resetTokRaw]
              .map(parseSecondsLike)
              .filter((v) => typeof v === 'number' && v > 0);
            const retryAfterSec = candidates.length ? Math.min(...candidates) : null;
            resolve({
              status: res.statusCode || 0,
              body: text,
              retryAfterSec,
            });
          });
        },
      );
      req.on('error', (err) => reject(err));
      req.setTimeout(30_000, () => {
        req.destroy(new Error('Sakura AI request timed out'));
      });
      req.write(body);
      req.end();
    });
    return result;
  });

  ipcMain.handle('sakura-ai:configured', () => {
    return Boolean(SAKURA_AI_CONFIG.groqKey);
  });

  ipcMain.handle('phoenix:open', async (_event, options) => {
    phoenixConfig = {
      publicKey: options?.publicKey || null,
      autoConnect: Boolean(options?.autoConnect && options?.publicKey),
    };
    try {
      createPhoenixWindow();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'Failed to open Phoenix' };
    }
  });

  ipcMain.handle('phoenix:get-config', () => phoenixConfig);

  ipcMain.handle('phoenix:close', () => {
    if (phoenixWindow && !phoenixWindow.isDestroyed()) {
      phoenixWindow.close();
    }
    return { ok: true };
  });

  ipcMain.handle('phoenix:is-open', () => ({
    open: Boolean(phoenixWindow && !phoenixWindow.isDestroyed()),
  }));

  ipcMain.handle('phoenix:wallet', async (_event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error('Sakura app is not ready');
    }
    const method = payload?.method;
    const params = payload?.params || {};
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        phoenixPendingRequests.delete(requestId);
        reject(new Error('Wallet request timed out'));
      }, 120000);

      phoenixPendingRequests.set(requestId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      mainWindow.webContents.send('phoenix:wallet-request', {
        requestId,
        method,
        params,
      });
    });
  });

  ipcMain.handle('phoenix:wallet-response', async (_event, payload) => {
    const pending = phoenixPendingRequests.get(payload?.requestId);
    if (!pending) return { ok: false };
    phoenixPendingRequests.delete(payload.requestId);
    if (payload?.error) {
      pending.reject(new Error(payload.error));
    } else {
      pending.resolve(payload?.result);
    }
    return { ok: true };
  });

  // ── File system IPC for downloads ──
  ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

  ipcMain.handle('fs-write-file', async (_event, relativePath, base64Data) => {
    const fullPath = path.join(app.getPath('userData'), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
    return true;
  });

  ipcMain.handle('fs-read-file', async (_event, relativePath) => {
    const fullPath = path.join(app.getPath('userData'), relativePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath).toString('base64');
  });

  ipcMain.handle('fs-delete', async (_event, relativePath) => {
    const fullPath = path.join(app.getPath('userData'), relativePath);
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    return true;
  });

  ipcMain.handle('fs-exists', async (_event, relativePath) => {
    const fullPath = path.join(app.getPath('userData'), relativePath);
    return fs.existsSync(fullPath);
  });

  startHianimeServer();
  await waitForHianimeReady();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  stopHianimeServer();
});

app.on('window-all-closed', () => {
  stopHianimeServer();
  app.quit();
});

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.wasm': 'application/wasm',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
