import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const ts = require('typescript');
function load(path, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, URL, URLSearchParams, require: (name) => deps[name] || {} });
  return exports;
}
const { coverThumbnailUrl } = load('../lib/cover-thumbnail.ts');

test('uses the public poster CDN with a bounded thumbnail size', () => {
  const result = new URL(coverThumbnailUrl('https://atsu.moe/static/posters/test-small.avif', 512), 'https://sakuraonseeker.com');
  assert.equal(result.pathname, '/api/cover-image/');
  assert.equal(result.searchParams.get('url'), 'https://cdn.atsu.moe/static/posters/test-small.avif');
  assert.equal(result.searchParams.get('width'), '512');
});
test('unwraps existing manhwa cover URLs exactly once', () => {
  const cover = 'https://www.mangaread.org/wp-content/uploads/2026/cover.gif';
  const source = `/api/media-proxy/?path=${encodeURIComponent(`/manhwa/v1/img?u=${encodeURIComponent(cover)}`)}`;
  const result = new URL(coverThumbnailUrl(source), 'https://sakuraonseeker.com');
  assert.equal(result.searchParams.get('url'), cover);
  assert.equal(coverThumbnailUrl(result.pathname + result.search), result.pathname + result.search);
});
test('does not route arbitrary hosts, chapter paths, private URLs or local assets through thumbnails', () => {
  for (const url of ['https://evil.example/cover.jpg', 'http://127.0.0.1/test', '/app/assets/cover.webp', 'data:image/png;base64,abcd', 'https://atsu.moe/static/pages/chapter.jpg', 'https://user:password@cdn.atsu.moe/static/posters/a.jpg']) {
    assert.equal(coverThumbnailUrl(url), url);
  }
});
test('leaves other media sources and malformed wrappers unchanged', () => {
  for (const source of ['/api/media-proxy/?path=%2Fanime%2Ffile.mp4', '/api/media-proxy/?path=%2Fmanhwa%2Fv1%2Fimg%3Fu%3Dbroken']) {
    assert.equal(coverThumbnailUrl(source), source);
  }
});
test('catalogue uses smaller portraits, not cropped square thumbnails, while banners retain full size', () => {
  const manga = load('../lib/manga.ts');
  const item = { id: 'a', title: 'A', smallImage: 'posters/s.avif', mediumImage: 'posters/m.avif', largeImage: 'posters/l.avif' };
  assert.equal(manga.toContentItem(item).cover, 'https://atsu.moe/static/posters/m.avif');
  assert.equal(manga.toCarouselItem(item).cover, 'https://atsu.moe/static/posters/m.avif');
  assert.equal(manga.toBannerItem(item).cover, 'https://atsu.moe/static/posters/l.avif');
  assert.equal(manga.toContentItem({ id: 'b', title: 'B', image: 'https://example.com/cover.jpg' }).cover, 'https://example.com/cover.jpg');
});
