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

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Map(Object.entries(init.headers || {}));
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
    request: { url, method: 'GET', mode },
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

const other = await doFetch('https://sakuraonseeker.com/api/media-proxy/?path=%2Fx', 'cors');
check('unrelated requests are not intercepted', other === null,
  'the handler must fall through for everything else');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
