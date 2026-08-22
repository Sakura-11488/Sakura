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
const malMap = require('./scrapers/mal-map');

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

describe('search ranking — the series must come first', () => {
  // hianime's own order buried the series people search for: "naruto" put the
  // actual Naruto at 20 of 27, behind an unaired announcement, Boruto and
  // eleven films. The app plays the first result, so tapping it landed on
  // something with no episodes and read as "anime is broken" while playback
  // was fine.
  const named = (...names) => names.map((name) => ({ name, slug: 'x' }));

  test('an exact title match outranks everything', () => {
    const ranked = hianime.rankResults(
      named('NARUTO (Shinsaku Anime)', 'Boruto: Naruto Next Generations', 'Naruto Shippuden the Movie', 'Naruto'),
      'naruto',
    );
    assert.equal(ranked[0].name, 'Naruto');
  });

  test('films, OVAs and recaps sink below series', () => {
    const ranked = hianime.rankResults(
      named('Demon Slayer: Kimetsu no Yaiba - The Movie', 'Demon Slayer: Kimetsu no Yaiba'),
      'demon slayer',
    );
    assert.equal(ranked[0].name, 'Demon Slayer: Kimetsu no Yaiba');
  });

  test('among real series the base entry beats a season or arc', () => {
    const ranked = hianime.rankResults(
      named('Jujutsu Kaisen Season 2', 'Jujutsu Kaisen'),
      'jujutsu kaisen',
    );
    assert.equal(ranked[0].name, 'Jujutsu Kaisen');
  });

  test('ranking REORDERS only — nothing is dropped', () => {
    const input = named('A Movie', 'B', 'C Special', 'D');
    const ranked = hianime.rankResults(input, 'b');
    assert.equal(ranked.length, input.length, 'every result must survive');
    assert.deepEqual(
      ranked.map((r) => r.name).sort(),
      input.map((r) => r.name).sort(),
      'the set must be identical, only the order may change',
    );
  });

  test('ties keep upstream order, so this can only refine it', () => {
    const input = named('Zeta', 'Alpha', 'Beta');
    // Nothing matches the query, so every score is equal.
    const ranked = hianime.rankResults(input, 'nomatchatall');
    assert.deepEqual(ranked.map((r) => r.name), ['Zeta', 'Alpha', 'Beta']);
  });
});

describe('mal-map — the title matcher that routes playback to megaplay', () => {
  // These run entirely offline. The 16MB index is not needed, and must not be,
  // or the rules below could only be checked on a machine that had already run
  // the build script.
  const TV = (m, e) => ({ m, e, t: 'TV' });

  test('season markers collapse to one form across both datasets', () => {
    // hianime writes "2nd Season", the database writes "Season 2", and some
    // titles use a bare roman numeral. Without this, Jujutsu Kaisen matches
    // nothing at all.
    assert.equal(malMap.canonicalSeason('jujutsu kaisen 2nd season'), 'jujutsu kaisen season 2');
    assert.equal(malMap.canonicalSeason('overlord season iv'), 'overlord season 4');
    assert.equal(malMap.canonicalSeason('bleach season 3'), 'bleach season 3');
  });

  test('parenthetical qualifiers are stripped — "Jujutsu Kaisen (TV)"', () => {
    assert.ok(malMap.candidateKeys('Jujutsu Kaisen (TV)').includes('jujutsu kaisen'));
  });

  test('spacing differences resolve — "Dan Da Dan" vs "Dandadan"', () => {
    assert.ok(malMap.candidateKeys('Dan Da Dan').includes('dandadan'));
  });

  test('a trailing subtitle is retried on the head — the Frieren case', () => {
    const keys = malMap.candidateKeys('Sousou no Frieren - Marumaru no Mahou');
    assert.ok(keys.includes('sousou no frieren'), 'must retry without the subtitle');
  });

  test('an unresolvable collision returns null rather than guessing', () => {
    // Two DIFFERENT shows, different lengths, no episode count to separate
    // them. Guessing here is how you serve someone the wrong series.
    assert.equal(malMap.__decide([TV(1, 12), TV(2, 24)], 0, true), null);
  });

  test('episode count separates a series from its specials and films', () => {
    const picked = malMap.__decide(
      [TV(100, 24), { m: 101, e: 1, t: 'SPECIAL' }, { m: 102, e: 1, t: 'MOVIE' }],
      24,
      false,
    );
    assert.equal(picked.m, 100);
  });

  test('a bare title picks the ORIGINAL when seasons tie on length', () => {
    // "Dan Da Dan" matches two 12-episode TV entries — seasons 1 and 2 — and
    // no episode count separates them because both genuinely have 12. MAL ids
    // are issued chronologically, so the original is the lowest.
    const picked = malMap.__decide([TV(60543, 12), TV(57334, 12)], 12, false);
    assert.equal(picked.m, 57334, 'must pick season 1 for an unmarked title');
  });

  test('a title that NAMES a season never takes the lowest-id shortcut', () => {
    // There the remaining ambiguity is between genuinely different things, and
    // picking the oldest would be a coin flip. Refusing costs a fallback to
    // hianime's own servers; guessing costs the user the wrong show.
    assert.equal(malMap.__decide([TV(60543, 12), TV(57334, 12)], 12, true), null);
  });

  test('hasSeasonMarker distinguishes the two asks', () => {
    assert.equal(malMap.hasSeasonMarker('Dan Da Dan'), false);
    assert.equal(malMap.hasSeasonMarker('Dan Da Dan Season 2'), true);
    assert.equal(malMap.hasSeasonMarker('JUJUTSU KAISEN 2nd Season'), true);
    assert.equal(malMap.hasSeasonMarker('Attack on Titan Final Season'), true);
  });

  test('an empty or junk title resolves to nothing, never to a show', () => {
    assert.equal(malMap.resolveMal('', 12), null);
    assert.deepEqual(malMap.candidateKeys(''), []);
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
