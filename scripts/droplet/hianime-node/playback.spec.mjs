import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const fixture = (payload, html = '<div data-id="104103"></div>') => ({
  fetchText: async () => html,
  fetchJSON: async () => payload,
});
function loadExtractor(base, http) {
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(new URL(`${base}/extractors/megaplay.js`, import.meta.url), 'utf8'), {
    module, exports: module.exports, URL, console,
    require: (id) => id === '../utils/http' ? http : { HIANIME_BASE: 'https://hianime.dk' },
  });
  return module.exports;
}
for (const base of ['.', '../../../hianime-node']) {
  test(`${base}: new encoded sources hand off to the existing public player`, async () => {
    const extractor = loadExtractor(base, fixture({ enc: 'opaque-player-data', tracks: [], outro: { start: 1280, end: 1369 } }));
    const result = await extractor.extractM3u8('https://megaplay.buzz/stream/mal/20/1/sub');
    assert.equal(result.embedUrl, 'https://megaplay.buzz/stream/mal/20/1/sub');
    assert.equal(result.requiresEmbed, true);
    assert.equal(result.sources.length, 0);
    assert.equal(result.outro.end, 1369);
  });
  test(`${base}: direct file responses keep native HLS playback`, async () => {
    const extractor = loadExtractor(base, fixture({ sources: { file: 'https://cdn.example.test/video.m3u8' } }));
    const result = await extractor.extractM3u8('https://megaplay.buzz/stream/mal/20/1/sub');
    assert.equal(result.sources[0].url, 'https://cdn.example.test/video.m3u8');
    assert.equal(result.sources[0].isM3U8, true);
    assert.equal(result.embedUrl, undefined);
  });
  test(`${base}: removed player pages do not become successful fallback sources`, async () => {
    const extractor = loadExtractor(base, fixture({ enc: 'not-used' }, '<title>Error 410</title>'));
    await assert.rejects(extractor.extractM3u8('https://megaplay.buzz/stream/mal/20/1/sub'), /could not locate data-id/);
  });
}

test('a dead guessed MAL embed advances to a working server instead of ending resolution', async () => {
  const source = readFileSync(new URL('./scrapers/hianime.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function resolveEmbedForEpisode('), source.indexOf('\nmodule.exports'));
  const attempted = [];
  const resolve = vm.runInNewContext(`${body}\nresolveEmbedForEpisode`, {
    console,
    getInfo: async () => ({ animeId: '2728', name: 'Naruto' }),
    getEpisodes: async () => [{ number: 1, ids: '104103', hasSub: true }],
    getServersFromList: async () => [{ name: 'actual-player', type: 'sub', linkId: 'https://player.example.test/episode', source: 'list' }],
    sortServersForPlayback: (servers) => servers,
    malMap: { resolveMal: () => ({ mal: 20 }) },
    config: { MEGAPLAY_BASE: 'https://megaplay.buzz' },
    getEmbedFromServer: async (url) => ({ url }),
  });
  const result = await resolve('naruto-2728', 1, 'sub', async (url) => {
    attempted.push(url);
    if (url.includes('megaplay')) throw new Error('Removed episode');
    return { sources: [{ url: 'https://cdn.example.test/video.m3u8' }] };
  });
  assert.equal(attempted.length, 2);
  assert.equal(result.serverName, 'actual-player');
  assert.equal(result.playback.sources.length, 1);
});
