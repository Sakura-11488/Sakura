/**
 * Tests the two service-worker rules that can destroy user data or brick the
 * app, by loading the REAL dist/sw.js under mocked globals.
 *
 *   1. activate must never delete the offline library
 *   2. /app/__offline/* must be answered from the library, and a miss must be
 *      an honest 404 rather than a network request that 200s with HTML
 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = 'C:/Users/1/Documents/milla projects/Sakura/web/dist/sw.js';
const code = fs.readFileSync(SRC, 'utf8');

let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) fail++;
};

// ── Mock Cache Storage ──────────────────────────────────────────────────────
const store = new Map(); // cacheName -> Map(url -> Response-ish)
const deleted = [];

// Minimal Blob stand-in: the worker slices cached bodies to serve Range
// requests, so the mock has to support the same two operations the real one
// does — .size and .slice(start, end, type).
class FakeBlob {
  constructor(text, type) { this.text = text; this.type = type || ''; }
  get size() { return this.text.length; }
  slice(start, end, type) { return new FakeBlob(this.text.slice(start, end), type); }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Map(Object.entries(init.headers || {}));
    // Header lookup is case-insensitive in the real thing.
    const raw = this.headers;
    this.headers = {
      get: (k) => {
        for (const [hk, hv] of raw) if (hk.toLowerCase() === String(k).toLowerCase()) return hv;
        return null;
      },
    };
  }
  async blob() {
    return new FakeBlob(
      typeof this.body === 'string' ? this.body : String(this.body ?? ''),
      this.headers.get('Content-Type') || '',
    );
  }
  clone() { return new FakeResponse(this.body, { status: this.status, statusText: this.statusText }); }
}

// The real Cache API resolves relative URLs against the origin before using
// them as keys — verified in a browser: put('/app/x') stores
// 'https://origin/app/x', and match() by either form hits. The mock must do the
// same or it fails the service worker for a difference that does not exist.
const norm = (u) => new URL(typeof u === 'string' ? u : u.url, self.location.origin).href;
const caches = {
  async keys() { return [...store.keys()]; },
  async delete(k) { deleted.push(k); return store.delete(k); },
  async open(name) {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      async match(req) { return m.get(norm(req)) || undefined; },
      async put(req, res) { m.set(norm(req), res); },
    };
  },
  async match(url) {
    for (const m of store.values()) if (m.has(norm(url))) return m.get(norm(url));
    return undefined;
  },
};

// Seed: a stale shell, the current shell, and the precious library.
store.set('sakura-shell-v1', new Map());
store.set('sakura-shell-v2', new Map());
store.set('sakura-offline-v1', new Map([
  ['https://sakuraonseeker.com/app/__offline/manhwa/s1/c1/0000', new FakeResponse('JPEGBYTES', { headers: { 'content-type': 'image/jpeg' } })],
]));
// And something we did not create, which must be left alone.
store.set('some-other-app-cache', new Map());

const handlers = {};
const self = {
  location: { origin: 'https://sakuraonseeker.com' },
  addEventListener: (type, fn) => { handlers[type] = fn; },
  skipWaiting: () => {},
  clients: { claim: async () => {} },
};

let networkCalls = 0;
const fetchMock = async () => { networkCalls++; return new FakeResponse('<html>fallback</html>', { headers: { 'content-type': 'text/html' } }); };

vm.createContext(Object.assign(globalThis, { self, caches, fetch: fetchMock, Response: FakeResponse, URL }));
vm.runInThisContext(code, { filename: 'sw.js' });

// ── Rule 1: activate ────────────────────────────────────────────────────────
const waits = [];
await handlers.activate({ waitUntil: (p) => waits.push(p) });
await Promise.all(waits);

check('the offline library survives activate', store.has('sakura-offline-v1'),
  'deleted: ' + JSON.stringify(deleted));
check('a stale shell cache IS swept', !store.has('sakura-shell-v1'));
check('the current shell cache is kept', store.has('sakura-shell-v2'));
check('an unrecognised cache is left alone', store.has('some-other-app-cache'),
  'deleting caches we did not create is how user data disappears');

// ── Rule 2: fetch routing ───────────────────────────────────────────────────
async function doFetch(url, mode = 'no-cors') {
  let responded;
  const event = {
    // A real Request always has headers; the worker reads Range off it.
    request: { url, method: 'GET', mode, headers: { get: () => null } },
    respondWith: (p) => { responded = p; },
  };
  await handlers.fetch(event);
  return responded ? await responded : null;
}

const before = networkCalls;
const hit = await doFetch('https://sakuraonseeker.com/app/__offline/manhwa/s1/c1/0000');
check('a downloaded page is served from the library', hit && hit.status === 200 && hit.body === 'JPEGBYTES');
check('serving a downloaded page makes no network request', networkCalls === before,
  'a cache-only route must not fall through');

const miss = await doFetch('https://sakuraonseeker.com/app/__offline/manhwa/nope/nope/9999');
check('a missing page is an honest 404', miss && miss.status === 404,
  'a network fallback here would 200 with the SPA shell and render as a broken image');
check('a missing page makes no network request', networkCalls === before);

// ── Rule 3: Range, for downloaded video ─────────────────────────────────────
// A <video> seeks by asking for byte ranges. Returning the stored 200 verbatim
// let it play from the start but never seek.
const VID = "https://sakuraonseeker.com/app/__offline/anime/show/ep1";
store.get('sakura-offline-v1').set(VID, new FakeResponse('0123456789', {
  headers: { 'Content-Type': 'video/mp4' },
}));

async function rangeFetch(url, range) {
  let responded;
  const headers = new Map(range ? [['range', range]] : []);
  const event = {
    request: { url, method: 'GET', mode: 'no-cors', headers: { get: (k) => headers.get(k.toLowerCase()) ?? null } },
    respondWith: (p) => { responded = p; },
  };
  await handlers.fetch(event);
  return responded ? await responded : null;
}

const noRange = await rangeFetch(VID, null);
check('no Range header still returns the whole 200', noRange && noRange.status === 200,
  'images take this path and must be untouched');

const partial = await rangeFetch(VID, 'bytes=2-5');
check('a Range request gets 206', partial && partial.status === 206, 'got ' + (partial && partial.status));
check('206 carries a correct Content-Range',
  partial && partial.headers.get('Content-Range') === 'bytes 2-5/10',
  partial && partial.headers.get('Content-Range'));
check('206 preserves the stored Content-Type',
  partial && partial.headers.get('Content-Type') === 'video/mp4');

const suffix = await rangeFetch(VID, 'bytes=-3');
check('suffix ranges resolve from the end',
  suffix && suffix.headers.get('Content-Range') === 'bytes 7-9/10',
  suffix && suffix.headers.get('Content-Range'));

const past = await rangeFetch(VID, 'bytes=99-200');
check('a range past the end is 416, not a lie', past && past.status === 416,
  'a 206 with no bytes would look like a corrupt file to the player');

const openEnded = await rangeFetch(VID, 'bytes=8-');
check('an open-ended range runs to the last byte',
  openEnded && openEnded.headers.get('Content-Range') === 'bytes 8-9/10',
  openEnded && openEnded.headers.get('Content-Range'));

const other = await doFetch('https://sakuraonseeker.com/api/media-proxy/?path=%2Fx', 'cors');
check('unrelated requests are not intercepted', other === null,
  'the handler must fall through for everything else');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
