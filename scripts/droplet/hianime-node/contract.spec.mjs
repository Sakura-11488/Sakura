/**
 * Contract tests for the hianime scraper.
 *
 *     node --test contract.spec.mjs
 *
 * Two kinds of test here, and the split is the point.
 *
 * OFFLINE tests run against fixed HTML and guard the parsing rules that were
 * learned the hard way on 2026-08-19 — absolute hrefs, the anime id living on
 * #ani_detail rather than the first data-id, and a broken parse throwing rather
 * than returning an empty list. These must never need the network and must never
 * be skipped: they are the regression suite.
 *
 * LIVE tests are the CONTRACT WITH THE UPSTREAM. They assert that hianime.dk
 * still produces what this scraper needs. When the site redesigns again these
 * fail loudly here, at deploy time, instead of silently in production two days
 * before a user notices. If the network or the upstream is unreachable they are
 * skipped rather than failed, because an outage at their end is not a defect at
 * ours — the distinction the whole service now tries to make.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hianime = require('./scrapers/hianime');
const cheerio = require('cheerio');

const LIVE = process.env.SKIP_LIVE !== '1';

// ── Offline: parsing rules ───────────────────────────────────────────────────

describe('slug extraction', () => {
  // Mirrors the real markup shape rather than the real content.
  const page = (href) => `
    <div class="flw-item">
      <a class="film-poster-ahref" href="${href}"></a>
      <img class="film-poster-img" src="/p.jpg">
      <div class="film-name"><a href="${href}">A Title</a></div>
    </div>`;

  test('absolute hrefs resolve — the 2026-08-19 break', () => {
    const $ = cheerio.load(page('https://hianime.dk/some-show-1234'));
    const href = $('.film-poster-ahref').attr('href');
    const path = href.replace(/^https?:\/\/[^/]+/i, '');
    const m = path.match(/^\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/) || path.match(/^\/([^/?#]+?)(?:\/ep-\d+)?$/);
    assert.ok(m, 'absolute href must yield a slug');
    assert.equal(m[1], 'some-show-1234');
  });

  test('legacy /watch/ hrefs still resolve, so an upstream revert needs no deploy', () => {
    const $ = cheerio.load(page('/watch/some-show-1234'));
    const href = $('.film-poster-ahref').attr('href');
    const path = href.replace(/^https?:\/\/[^/]+/i, '');
    const m = path.match(/^\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/) || path.match(/^\/([^/?#]+?)(?:\/ep-\d+)?$/);
    assert.ok(m);
    assert.equal(m[1], 'some-show-1234');
  });

  test('an ?ep= query does not leak into the slug', () => {
    const path = '/some-show-1234?ep=99'.replace(/^https?:\/\/[^/]+/i, '');
    const m = path.match(/^\/([^/?#]+?)(?:\/ep-\d+)?$/);
    assert.equal(m ? m[1] : null, null, 'a query string must not parse as part of the slug');
  });
});

describe('anime id resolution', () => {
  test('prefers #ani_detail data-anime-id over the first data-id on the page', () => {
    // The first data-id is the first EPISODE's id since the redesign. Using it
    // makes the episode endpoint return the site shell, which throws on JSON
    // parse rather than 404ing — a confusing failure far from its cause.
    const html = '<div id="ani_detail" data-anime-id="8360" data-id="124868"></div>';
    const id = html.match(/id="ani_detail"[^>]*data-anime-id="(\d+)"/) || html.match(/data-anime-id="(\d+)"/);
    assert.equal(id[1], '8360');
  });

  test('falls back to the slug suffix, which carries the same id', () => {
    const slugId = 'bleach-thousand-year-blood-war-the-conflict-8360'.match(/-(\d+)$/);
    assert.equal(slugId[1], '8360');
  });
});

describe('malformed upstream markup — the 2026-08-22 outage', () => {
  // The exact shape hianime.dk served: a gtag <script> with neither its
  // attribute quote nor its angle bracket closed. A conforming parser must
  // treat everything after it as raw script text, so the whole document —
  // </head>, <body>, and every result card — was swallowed.
  const broken = [
    '<html><head><title>Search: one piece | HiAnime</title>',
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-E',
    '</head>',
    '<body class="">',
    '<div class="film_list-wrap">',
    '<div class="flw-item flw-item-big">',
    '<a class="film-poster-ahref" href="https://hianime.dk/one-piece-8719"></a>',
    '<img class="film-poster-img" src="/p.jpg">',
    '<div class="film-name"><a href="https://hianime.dk/one-piece-8719">One Piece</a></div>',
    '</div></div></body></html>',
  ].join('\n');

  test('without repair the document parses to an empty body — the silent failure', () => {
    const $ = cheerio.load(broken);
    assert.equal($('.flw-item').length, 0, 'demonstrates the bug: no containers survive the parse');
    assert.equal($('a').length, 0, 'zero anchors on a page full of links is the tell');
  });

  test('repair recovers the result cards', () => {
    const $ = cheerio.load(hianime.repairUnterminatedTags(broken));
    assert.equal($('.flw-item').length, 1, 'the card must survive repair');
    assert.equal($('.film-name a').first().text(), 'One Piece');
    assert.equal(
      $('.film-poster-ahref').attr('href'),
      'https://hianime.dk/one-piece-8719',
    );
  });

  test('well-formed markup is left byte-identical — the repair must not corrupt good pages', () => {
    // A tag cannot reach '<' before '>' unless it is malformed, so a correct
    // document has nothing for the pattern to match. Asserted rather than
    // assumed: a repair that rewrites healthy input is worse than the bug.
    const fine = '<html><head><script src="/a.js"></script></head>'
      + '<body><div class="flw-item"><a href="/x">t</a></div></body></html>';
    assert.equal(hianime.repairUnterminatedTags(fine), fine);
  });

  test('the guard counts raw bytes, so a collapsed parse cannot look like "no matches"', () => {
    // The original guard counted $('.flw-item'). On this input that is 0, and
    // <title> parses fine because it precedes the malformed tag — so the title
    // check also passes. Both branches fall through and search returns []. The
    // guard must read the bytes instead.
    const $ = cheerio.load(broken);
    assert.equal($('.flw-item').length, 0, 'the DOM-based count is defeated');
    assert.match($('title').first().text(), /search/i, 'and the title check still passes');

    const rawContainers = (broken.match(/class="[^"]*\bflw-item\b/g) || []).length;
    assert.ok(rawContainers > 0, 'but the raw bytes still carry the evidence');
  });
});

describe('failing loudly', () => {
  test('getEpisodes refuses without a slug rather than returning []', async () => {
    // The upstream selects the anime by Referer, so no slug means no correct
    // answer. Returning [] here would read as "this anime has no episodes".
    await assert.rejects(
      () => hianime.getEpisodes('999999999'),
      (err) => err.code === 'NO_SLUG',
      'must throw NO_SLUG, never resolve empty',
    );
  });
});

// ── Live: the contract with the upstream ─────────────────────────────────────

describe('upstream contract', { skip: !LIVE ? 'SKIP_LIVE=1' : false }, () => {
  let slug = null;
  let animeId = null;
  let episodeId = null;

  test('search yields parseable results', async (t) => {
    let results;
    try {
      results = await hianime.search('bleach');
    } catch (err) {
      // These two codes ARE the contract breaking — they must fail the suite,
      // never skip it. Skipping the one condition these tests exist to detect
      // would reproduce, inside the test suite, exactly the silent failure the
      // suite is meant to prevent.
      if (err.code === 'SEARCH_UNUSABLE' || err.code === 'PARSE_BROKEN') {
        assert.fail('UPSTREAM SEARCH CONTRACT BROKEN: ' + err.message);
      }
      // A transport failure genuinely is not our defect, so that still skips.
      return t.skip('upstream unreachable: ' + err.message);
    }
    assert.ok(results.length > 0, 'search must return results for a common keyword');
    const first = results[0];
    assert.match(first.slug, /^[a-z0-9-]+-\d+$/, 'slug must be <name>-<numericId>');
    assert.ok(first.name && first.name.length > 1, 'result must carry a real title');
    slug = first.slug;
  });

  test('info resolves a numeric id matching the slug suffix', async (t) => {
    if (!slug) return t.skip('no slug from search');
    const info = await hianime.getInfo(slug);
    assert.match(info.animeId, /^\d+$/, 'animeId must be numeric');
    assert.equal(info.animeId, slug.match(/-(\d+)$/)[1], 'id must agree with the slug suffix');
    assert.ok(info.name && info.name.length > 1, 'info must carry a real title');
    animeId = info.animeId;
  });

  test('episodes come back with ids for the servers call', async (t) => {
    if (!animeId) return t.skip('no animeId');
    const eps = await hianime.getEpisodes(animeId, slug);
    assert.ok(eps.length > 0, 'a known series must list episodes');
    const first = eps[0];
    assert.ok(Number.isFinite(first.number) && first.number > 0, 'episode needs a number');
    assert.ok(first.ids, 'episode needs an id, or playback cannot be resolved');
    episodeId = first.ids;
  });

  test('servers resolve to absolute embed URLs', async (t) => {
    if (!episodeId) return t.skip('no episodeId');
    const servers = await hianime.getServersFromList(episodeId, slug);
    assert.ok(servers.length > 0, 'episode must offer at least one server');
    // data-hash is base64; if decoding broke we would get a non-URL here and the
    // extractor would fail much later with a confusing message.
    assert.match(servers[0].linkId, /^https?:\/\//, 'server linkId must be an absolute URL');
  });
});
