import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const source = readFileSync(new URL('../lib/anime-episode-ids.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  // Type-only imports are erased; any runtime import would fail here.
  vm.runInNewContext(output, { module, exports: module.exports, require: (id) => { throw new Error(`unexpected import ${id}`); } });
  return module.exports;
}

const { sameCatalogEpisode, withDownloadIds } = load();
const malList = (count) => ({ id: '52991', episodes: Array.from({ length: count }, (_, i) => ({ id: `mal-52991-${i + 1}`, number: i + 1, title: `Episode ${i + 1}` })) });

test('a bookmark saved under a provider id still names the same MAL episode, and never another title kind', () => {
  const episode = { id: 'mal-52991-3', number: 3 };
  assert.equal(sameCatalogEpisode(episode, 'mal-52991-3', 3), true);
  assert.equal(sameCatalogEpisode(episode, 'hi-18542-3', 3), true, 'provider id, same number');
  assert.equal(sameCatalogEpisode(episode, 'hi-18542-4', 4), false);
  assert.equal(sameCatalogEpisode(episode, 'psyop-ep-3', 3), false, 'non-catalog ids match only exactly');
  assert.equal(sameCatalogEpisode(episode, undefined, 3), false);
  assert.equal(sameCatalogEpisode({ id: 'psyop-ep-3', number: 3 }, 'psyop-ep-3', 3), true);
});

test('downloads saved under the other catalog id keep that id in the listed episodes', () => {
  const info = malList(4);
  const offline = {
    'hi-18542-2': { episodeId: 'hi-18542-2', episodeNumber: 2, status: 'ready' },
    'mal-52991-3': { episodeId: 'mal-52991-3', episodeNumber: 3, status: 'downloading' },
  };
  const listed = withDownloadIds(info, offline);
  assert.notEqual(listed, info);
  assert.deepEqual(plain(listed.episodes.map((episode) => episode.id)), ['mal-52991-1', 'hi-18542-2', 'mal-52991-3', 'mal-52991-4']);
  assert.equal(listed.episodes[1].title, 'Episode 2', 'only the id changes');
  assert.equal(info.episodes[1].id, 'mal-52991-2', 'the loaded record is not mutated');
});

test('a finished copy wins over a partial one, and nothing changes without a cross-id download', () => {
  const info = malList(2);
  const both = {
    'hi-1-1': { episodeId: 'hi-1-1', episodeNumber: 1, status: 'paused' },
    'hi-2-1': { episodeId: 'hi-2-1', episodeNumber: 1, status: 'ready' },
  };
  assert.equal(withDownloadIds(info, both).episodes[0].id, 'hi-2-1');
  const same = { 'mal-52991-1': { episodeId: 'mal-52991-1', episodeNumber: 1, status: 'ready' } };
  assert.equal(withDownloadIds(info, same), info, 'same object when nothing is renamed');
  assert.equal(withDownloadIds(info, {}), info);
  assert.equal(withDownloadIds(null, both), null);
  const original = { episodes: [{ id: 'psyop-ep-1', number: 1, title: 'Pilot' }] };
  assert.equal(withDownloadIds(original, both), original, 'Originals ids are never renamed');
});
