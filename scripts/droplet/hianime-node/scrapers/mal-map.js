/**
 * Title -> MyAnimeList id, resolved entirely offline.
 *
 * WHY THIS EXISTS: on 2026-08-22 megacloud.help — the embed host behind every
 * hianime episode — started serving Cloudflare error 1027 ("the owner has
 * reached their plan limits"). That is a ZONE-level quota, served identically
 * to every visitor on earth, so no proxy and no header changes can get past it.
 * Playback died for the whole scraped catalogue.
 *
 * megaplay.buzz is alive and serves the same content, but it is addressed by
 * MAL id (/stream/mal/<malId>/<ep>/<sub|dub>), and hianime stopped emitting the
 * data-mal attribute the scraper used to read. So we have to supply the id.
 *
 * WHY NOT AN API: AniList answers 403 "temporarily disabled due to severe
 * stability issues", and Jikan 504s because MyAnimeList itself is down. Both
 * were checked on the day this was written. A playback path that depends on a
 * third-party lookup being up is a playback path that breaks again next week.
 *
 * So the mapping is a static index built from anime-offline-database (~30,500
 * entries carrying a MAL id, with synonyms). Built by scripts/build-mal-index.js
 * into data/mal-index.json (~8MB, ~56MB heap once loaded) and read from disk.
 * Nothing here touches the network.
 *
 * THE THING TO BE CAREFUL ABOUT: a wrong id serves a DIFFERENT SHOW while
 * reporting success — the failure mode this codebase keeps producing. megaplay
 * will happily return a valid file for a valid-but-wrong id. So every rule
 * below is exact-match-then-disambiguate, and anything still ambiguous returns
 * null rather than a guess. A null just falls back to hianime's own server
 * list, which is exactly today's behaviour — strictly no worse.
 */
const fs = require("fs");
const path = require("path");

var INDEX_PATH = process.env.MAL_INDEX_PATH
  || path.join(__dirname, "..", "data", "mal-index.json");

var index = null;
var loadError = null;

/** Lowercase, strip diacritics, reduce every run of punctuation to one space. */
function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Season markers are written three ways across these two datasets — "2nd
 * Season", "Season 2" and a bare roman "II" — and they must collapse to one
 * form or Jujutsu Kaisen matches nothing. Ordinals are handled up to 9, which
 * covers every series anyone searches for.
 */
var ORDINALS = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];
var ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };

function canonicalSeason(normalized) {
  var out = normalized;
  ORDINALS.forEach(function(word, i) {
    out = out.replace(new RegExp("\\b" + word + " season\\b", "g"), "season " + (i + 1));
  });
  Object.keys(ROMAN).forEach(function(numeral) {
    out = out.replace(new RegExp("\\bseason " + numeral + "\\b", "g"), "season " + ROMAN[numeral]);
  });
  return out.replace(/\s+/g, " ").trim();
}

/** Spacing disagrees constantly — "Dan Da Dan" vs "Dandadan". */
function compact(normalized) {
  return normalized.replace(/ /g, "");
}

/**
 * Progressively looser keys, most specific first. Order matters: the first key
 * that resolves unambiguously wins, so a looser key can never override an exact
 * hit. Every key is still an EXACT lookup — there is no fuzzy scoring anywhere
 * in this file, because a near-match is how you serve the wrong show.
 */
function candidateKeys(title) {
  var base = normalizeTitle(title);
  if (!base) return [];
  var keys = [base, canonicalSeason(base), compact(base), compact(canonicalSeason(base))];

  // hianime appends subtitles the database does not carry, e.g.
  // "Sousou no Frieren - Marumaru no Mahou". Retry on the head only, but never
  // shorten to something so generic it would collide (>= 3 chars).
  var head = base.split(/ (?:the movie|movie|part|cour) /)[0];
  var dashHead = title.split(/\s+[-–—:]\s+/)[0];

  // Parenthetical qualifiers — "Jujutsu Kaisen (TV)", "(Dub)", "(2011)" — are
  // hianime's disambiguation, not part of the name. Left in, they normalise to
  // "jujutsu kaisen tv", which is not a key, so the title resolves to nothing
  // and playback silently falls back to the dead host. Some of them ARE indexed
  // as synonyms ("Naruto (TV)" is), which is why this is an extra candidate
  // rather than a replacement: the fuller form still gets first refusal.
  var deparenthesised = normalizeTitle(title.replace(/\s*\([^)]*\)/g, ""));

  [head, normalizeTitle(dashHead), deparenthesised].forEach(function(candidate) {
    var trimmed = (candidate || "").trim();
    if (trimmed.length >= 3 && keys.indexOf(trimmed) === -1) {
      keys.push(trimmed, canonicalSeason(trimmed), compact(trimmed));
    }
  });

  return keys.filter(function(k, i) { return k && keys.indexOf(k) === i; });
}

function loadIndex() {
  if (index || loadError) return index;
  try {
    index = new Map(JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")));
  } catch (err) {
    loadError = err;
    index = null;
  }
  return index;
}

function isLoaded() {
  return Boolean(loadIndex());
}

function indexSize() {
  var map = loadIndex();
  return map ? map.size : 0;
}

/**
 * Resolve a title to a MAL entry, or null when not confident.
 *
 * episodeCount, when known, is the tie-breaker that makes a multi-candidate key
 * safe: "Attack on Titan" matches the TV run, several OVAs and a compilation
 * film, and only the episode count separates them.
 */
function resolveMal(title, episodeCount) {
  var map = loadIndex();
  if (!map) return null;

  var keys = candidateKeys(title);
  for (var i = 0; i < keys.length; i += 1) {
    var candidates = map.get(keys[i]);
    if (!candidates || !candidates.length) continue;

    var decided = decide(candidates, episodeCount, hasSeasonMarker(title));
    if (decided) {
      return { mal: decided.m, episodes: decided.e, type: decided.t, matchedKey: keys[i] };
    }
    // Ambiguous on this key. Keep trying looser keys rather than guessing —
    // but never fall through to a *weaker* signal for the same collision.
  }
  return null;
}

/**
 * Does the title name a specific season/part, or the show as a whole?
 *
 * "Dan Da Dan" and "Dan Da Dan Season 2" are different requests, and the
 * database holds both under the same base key. Which one was asked for decides
 * whether the ambiguity below is resolvable.
 */
function hasSeasonMarker(title) {
  var n = normalizeTitle(title);
  return /\b(season \d+|part \d+|cour \d+|final season|\d+(st|nd|rd|th) season)\b/.test(canonicalSeason(n))
    || /\b(ii|iii|iv|v|vi|vii|viii|ix)\b/.test(n);
}

function decide(candidates, episodeCount, titled) {
  if (candidates.length === 1) return candidates[0];

  // A series is what someone is trying to watch; specials and films share
  // titles with it constantly.
  var series = candidates.filter(function(c) { return c.t === "TV" || c.t === "ONA"; });
  var pool = series.length ? series : candidates;
  if (pool.length === 1) return pool[0];

  if (episodeCount) {
    // Exact first. hianime occasionally lists one extra recap episode, so a
    // window of 1 is allowed only when it leaves exactly one candidate.
    var exact = pool.filter(function(c) { return c.e === episodeCount; });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) pool = exact;
    else {
      var near = pool.filter(function(c) { return c.e && Math.abs(c.e - episodeCount) <= 1; });
      if (near.length === 1) return near[0];
      if (near.length > 1) pool = near;
    }
  }

  /**
   * Sequels are the last ambiguity worth resolving, and only in one direction.
   *
   * "Dan Da Dan" matches two 12-episode TV entries — seasons 1 and 2 — and no
   * amount of episode counting separates them, because both really do have 12.
   * But the ASK disambiguates: a title carrying no season marker means the
   * original, and MAL ids are issued chronologically, so the original is the
   * lowest id in the group. "Dan Da Dan Season 2" carries its own title and
   * never reaches this branch.
   *
   * Deliberately NOT applied when the title does name a season: there the
   * remaining ambiguity is between genuinely different things and picking the
   * oldest would be a coin flip. Those still return null.
   *
   * Worst case here is season 1 instead of season 2 of the SAME show — visible
   * and self-correcting for a viewer — not a different series entirely, which
   * is the failure this file exists to avoid.
   */
  if (!titled && pool.length > 1) {
    var sameShape = pool.every(function(c) { return c.e === pool[0].e; });
    if (sameShape) {
      return pool.reduce(function(lowest, c) { return c.m < lowest.m ? c : lowest; });
    }
  }

  return null;
}

module.exports = {
  resolveMal: resolveMal,
  isLoaded: isLoaded,
  indexSize: indexSize,
  // Exported for the offline suite, which must be able to test the matching
  // rules without an 8MB index on disk.
  normalizeTitle: normalizeTitle,
  canonicalSeason: canonicalSeason,
  candidateKeys: candidateKeys,
  __decide: decide,
  hasSeasonMarker: hasSeasonMarker,
};
