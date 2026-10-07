import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInternetArchive, parseArchiveManifest, ARCHIVE_CATALOG } from './internet-archive.js';
import { createResponseCache } from './response-cache.js';

const canvas = (n, overrides = {}) => ({ width: 1740, items: [{ items: [{ motivation: 'painting', body: {
    type: 'Image', format: 'image/jpeg', id: `https://iiif.archive.org/image/iiif/3/book%2Fpage${n}.jp2/full/max/0/default.jpg`, ...overrides,
} }] }] });
const manifest = { items: Array.from({ length: 49 }, (_, n) => canvas(n)) };
const id = `ia-${ARCHIVE_CATALOG[0].identifier}`;

test('IIIF parser preserves page order, limits image size and rejects foreign image hosts', () => {
    const pages = parseArchiveManifest({ items: [canvas(1), canvas(2), canvas(1), canvas(3, { id: 'http://127.0.0.1/private' }), canvas(4, { type: 'Text' })] });
    assert.deepEqual(pages, [1, 2].map((n) => `https://iiif.archive.org/image/iiif/3/book%2Fpage${n}.jp2/full/1200,/0/default.jpg`));
});

test('source follows the shared catalogue/details/chapters/pages contract', async () => {
    let calls = 0;
    const source = createInternetArchive({ fetchJson: async () => { calls += 1; return manifest; } });
    const popular = await source.popular(2);
    assert.equal(popular.length, 2);
    assert.equal(popular[0].id, id);
    assert.equal((await source.details(id)).url, `https://archive.org/details/${ARCHIVE_CATALOG[0].identifier}`);
    assert.equal((await source.search('buster brown', 24, 0)).length, 2);
    assert.equal((await source.search('not in catalogue', 24, 0)).length, 0);
    const chapters = await source.chapters(id);
    assert.deepEqual(chapters.map((row) => row.number), [3, 2, 1]);
    assert.equal(chapters[0].pages, 1);
    assert.equal((await source.pages(id, `${id}-part-1`)).length, 24);
    assert.equal((await source.pages(id, `${id}-part-3`)).length, 1);
    assert.equal(calls, 1);
});

test('unknown IDs and mismatched chapter IDs cannot become arbitrary upstream requests', async () => {
    const source = createInternetArchive({ fetchJson: async () => { throw new Error('must not fetch'); } });
    assert.equal(await source.details('ia-private-book'), null);
    assert.deepEqual(await source.chapters('ia-private-book'), []);
    assert.deepEqual(await source.pages(id, 'ia-other-part-1'), []);
    assert.deepEqual(await source.pages(id, `${id}-part-0`), []);
    assert.deepEqual(await source.pages(id, `${id}-part-1/../../secret`), []);
});

test('unavailable or malformed manifests fail honestly and do not poison later requests', async () => {
    let calls = 0;
    const source = createInternetArchive({ fetchJson: async () => { calls += 1; return calls === 1 ? { items: [] } : manifest; } });
    await assert.rejects(source.chapters(id), (error) => error.code === 'INVALID');
    assert.equal((await source.chapters(id)).length, 3);
    assert.equal(source.stats().consecutiveFailures, 0);
});

test('concurrent chapter requests share one public API fetch', async () => {
    let calls = 0;
    const source = createInternetArchive({ fetchJson: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return manifest; } });
    await Promise.all([source.chapters(id), source.chapters(id), source.pages(id, `${id}-part-1`)]);
    assert.equal(calls, 1);
});

test('successful responses survive a restart and expire after the retention limit', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sakura-comics-cache-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let time = Date.now();
    const options = { directory, now: () => time, maxAgeMs: 60_000 };
    const cache = createResponseCache(options);
    const value = { pages: ['https://iiif.archive.org/page.jpg'], verified: true };
    await cache.set('pages:book:one', value);
    assert.deepEqual(await createResponseCache(options).get('pages:book:one'), value);
    assert.equal(await cache.get('pages:book:two'), undefined);
    time += 60_001;
    assert.equal(await cache.get('pages:book:one'), undefined);
});

test('response cache is best effort and rejects oversized values', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sakura-comics-cache-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cache = createResponseCache({ directory });
    await cache.set('oversized', 'a'.repeat(1024 * 1024 + 1));
    assert.equal(await cache.get('oversized'), undefined);
    const unwritable = createResponseCache({ directory: '/dev/null/cache' });
    await unwritable.set('test', { ok: true });
    assert.equal(await unwritable.get('test'), undefined);
});
