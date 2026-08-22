#!/usr/bin/env node
/**
 * Build the offline MAL data files from anime-offline-database.
 *
 *     node scripts/build-mal-index.js            # both passes, one download
 *     PHASE=index node scripts/build-mal-index.js
 *     PHASE=meta  AOD_FILE=/tmp/aod.json node scripts/build-mal-index.js
 *
 * Produces two files:
 *
 *   data/mal-index.json  title -> MAL id, read by scrapers/mal-map.js. This is
 *                        what routes playback to megaplay.buzz instead of the
 *                        dead megacloud.help. See mal-map.js for why it is a
 *                        static index and not an API call.
 *
 *   data/mal-meta.json   MAL id -> the metadata an anime detail page needs.
 *                        The app fetches that from Jikan DIRECTLY, with no
 *                        proxy, and renders "Could not load anime" when it
 *                        fails. Jikan fails PER ID: on 2026-08-22, MAL 38883
 *                        (Haikyuu!! To the Top — finished, 13 episodes, and
 *                        playable) returned 504 while MAL 60636 returned 200 in
 *                        the same second. No retry or health check catches that.
 *
 * WHY TWO PASSES. This box is 961MB with ~330MB free while serving. Parsing the
 * 60MB dump costs ~170MB on its own, and building BOTH structures in one process
 * was OOM-killed outright (exit 137, twice). Each pass now parses the dump, emits
 * one file and exits, so peak heap is one structure's worth. The download is
 * shared between them rather than fetched twice.
 *
 * RUN IT OUT OF BAND, never from the server process. As a one-shot the memory is
 * gone the moment it exits. Installed as a weekly cron; re-run it whenever new
 * shows need to resolve.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const SOURCE_URL = process.env.AOD_URL
  || "https://github.com/manami-project/anime-offline-database/releases/download/latest/anime-offline-database-minified.json";
const OUT_PATH = process.env.MAL_INDEX_PATH
  || path.join(__dirname, "..", "data", "mal-index.json");
const META_PATH = process.env.MAL_META_PATH
  || path.join(__dirname, "..", "data", "mal-meta.json");
// Cap how many distinct shows may share one title key. Six is far above any real
// collision and stops a generic string ("movie") from bloating the file.
const MAX_PER_KEY = 6;
// A collapse below this means the schema moved. Guarded so a bad build can never
// replace a good file — the failure stays a failure instead of becoming a
// silent outage.
const MIN_EXPECTED = 20000;

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

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

/**
 * Collapse long-vowel romanisation to a single canonical spelling.
 *
 * The two databases disagree constantly: MAL writes "Haikyuu!! To the Top",
 * hianime writes "Haikyu!! To The Top". Lookups here are exact, so without a
 * shared form the hianime title misses entirely — no MAL id, no megaplay, and
 * playback silently falls back to the dead host on a show with 25 episodes
 * sitting right there. Indexing the collapsed form ALONGSIDE the original makes
 * either spelling resolve.
 *
 * Same shape for Juujutsu/Jujutsu, Ryuu/Ryu, Touhou/Tohou, Shounen/Shonen.
 */
function collapseLongVowels(normalized) {
  return normalized.replace(/([aiueo])\1+/g, "$1").replace(/ou/g, "o");
}

function malIdOf(entry) {
  const source = (entry.sources || []).find(function(s) {
    return /myanimelist\.net\/anime\/\d+/.test(s);
  });
  return source ? Number(source.match(/anime\/(\d+)/)[1]) : null;
}

/**
 * Commit a staging file only after its contents have been vetted.
 *
 * Both checks earned their place. The count guard catches an upstream schema
 * change. The PARSE guard catches us: the first streamed writer emitted commas
 * within each 500-entry chunk but none between chunks, producing a 9.6MB file
 * that looked right, passed the count check, committed cleanly — and then threw
 * at position 165623 on every read. The endpoint reported the index as MISSING
 * rather than corrupt, which sent me looking in entirely the wrong place.
 *
 * Anything written by hand rather than by JSON.stringify must be read back
 * before it is trusted.
 */
function commit(staging, target, count, label) {
  if (count < MIN_EXPECTED) {
    try { fs.unlinkSync(staging); } catch (_) { /* nothing to clean up */ }
    throw new Error("only " + count + " " + label + " — refusing to overwrite " + target);
  }
  try {
    JSON.parse(fs.readFileSync(staging, "utf8"));
  } catch (err) {
    try { fs.unlinkSync(staging); } catch (_) { /* nothing to clean up */ }
    throw new Error("built " + target + " but it does not parse (" + err.message.slice(0, 80)
      + ") — refusing to commit a corrupt file");
  }
  fs.renameSync(staging, target);
  console.log("[mal-index] " + count + " " + label + ", "
    + (fs.statSync(target).size / 1048576).toFixed(1) + "MB -> " + target);
}

async function buildIndex(entries) {
  const index = new Map();
  let n = 0;
  for (const entry of entries) {
    const malId = malIdOf(entry);
    if (!malId) continue;
    n += 1;
    const value = { m: malId, e: entry.episodes || 0, t: entry.type || "" };
    for (const title of [entry.title].concat(entry.synonyms || [])) {
      const base = normalizeTitle(title);
      if (!base || base.length < 2) continue;
      // Four key forms at most, and the collapsed one only when it actually
      // differs. Emitting all six unconditionally OOM-killed the build: `ou`->`o`
      // touches a large share of romanised titles, so it was adding keys for
      // most of the 41,500 entries rather than the handful with long vowels.
      const collapsed = collapseLongVowels(base);
      const forms = [base, canonicalSeason(base), base.replace(/ /g, "")];
      if (collapsed !== base) forms.push(collapsed);
      for (const key of new Set(forms)) {
        if (!key) continue;
        let bucket = index.get(key);
        if (!bucket) { bucket = []; index.set(key, bucket); }
        if (bucket.length < MAX_PER_KEY && !bucket.some(function(x) { return x.m === value.m; })) {
          bucket.push(value);
        }
      }
    }
  }

  // Release the parsed dump before serialising. Emptying the array drops the
  // caller's references to ~41,500 entry objects, which is the single largest
  // thing still resident at this point.
  entries.length = 0;

  /**
   * Streamed, not JSON.stringify'd in one go.
   *
   * `JSON.stringify([...index])` is what actually OOM-killed this build — the
   * stack trace pinned it inside JsonStringify, building a single ~17MB string
   * while the parsed dump was still live. Emitting pair by pair keeps peak
   * allocation to one bucket at a time.
   */
  const staging = OUT_PATH + ".new";
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const out = fs.createWriteStream(staging);
  out.write("[");
  let first = true;
  let pending = [];
  for (const [key, bucket] of index) {
    pending.push((first ? "" : ",") + JSON.stringify([key, bucket]));
    first = false;
    if (pending.length >= 1000) { out.write(pending.join("")); pending = []; }
  }
  if (pending.length) out.write(pending.join(""));
  out.write("]");
  const keyCount = index.size;
  await new Promise(function(resolve, reject) { out.end(resolve); out.on("error", reject); });

  commit(staging, OUT_PATH, n, "shows indexed by title (" + keyCount + " keys)");
}

async function buildMeta(entries) {
  const staging = META_PATH + ".new";
  fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
  const out = fs.createWriteStream(staging);
  out.write("{");

  let n = 0;
  let first = true;
  let pending = [];
  // The separator belongs on each ENTRY, not on the join. Joining a chunk with
  // commas emits none BETWEEN chunks, which produced `...}"51243":{...` at every
  // 500-entry boundary — valid-looking output that JSON.parse rejects, and the
  // endpoint then reported the index as missing rather than as corrupt.
  const flush = () => { if (pending.length) { out.write(pending.join("")); pending = []; } };

  for (const entry of entries) {
    const malId = malIdOf(entry);
    if (!malId) continue;
    // Lean on purpose — this is loaded beside a 17MB title index on a 961MB
    // box. Tags are capped, and no synopsis is carried because the dump has
    // none; the client keeps whatever description it already had rather than
    // inventing one.
    pending.push((first ? "" : ",") + JSON.stringify(String(malId)) + ":" + JSON.stringify({
      malId: malId,
      title: entry.title || "",
      type: entry.type || "",
      episodes: entry.episodes || 0,
      status: entry.status || "",
      year: (entry.animeSeason && entry.animeSeason.year) || null,
      season: (entry.animeSeason && entry.animeSeason.season) || null,
      image: entry.picture || entry.thumbnail || "",
      score: entry.score && typeof entry.score === "object"
        ? (entry.score.arithmeticMean || null)
        : (entry.score || null),
      genres: (entry.tags || []).slice(0, 6),
      studios: (entry.studios || []).slice(0, 3),
    }));
    first = false;
    n += 1;
    if (pending.length >= 500) flush();
  }

  flush();
  out.write("}");
  await new Promise(function(resolve, reject) { out.end(resolve); out.on("error", reject); });
  commit(staging, META_PATH, n, "shows with metadata");
}

async function download(to) {
  process.stdout.write("[mal-index] downloading anime-offline-database... ");
  const res = await fetch(SOURCE_URL, { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + SOURCE_URL);

  // Streamed to disk rather than buffered. `Buffer.from(await res.arrayBuffer())`
  // held the whole 59MB dump in the PARENT for the entire run — the parent
  // outlives both child passes, so that buffer was still resident while each
  // child needed ~200MB of its own. On a box with ~300MB free that is the
  // difference between finishing and being OOM-killed.
  const { Readable } = require("stream");
  const { pipeline } = require("stream/promises");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(to));
  console.log((fs.statSync(to).size / 1048576).toFixed(0) + "MB");
}

async function main() {
  const phase = process.env.PHASE || "";

  if (phase === "index" || phase === "meta") {
    const file = process.env.AOD_FILE;
    if (!file || !fs.existsSync(file)) throw new Error("AOD_FILE must point at a downloaded dump");
    const entries = JSON.parse(fs.readFileSync(file, "utf8")).data || [];
    if (phase === "index") await buildIndex(entries);
    else await buildMeta(entries);
    console.log("[mal-index] peak heap " + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + "MB");
    return;
  }

  // Orchestrator: download once, then run each pass in its OWN process so the
  // parsed dump is released between them. Doing both in one process is what
  // got this OOM-killed.
  const tmp = path.join(os.tmpdir(), "aod-" + process.pid + ".json");
  await download(tmp);
  try {
    for (const p of ["index", "meta"]) {
      const r = spawnSync(process.execPath, ["--max-old-space-size=340", __filename], {
        stdio: "inherit",
        env: Object.assign({}, process.env, { PHASE: p, AOD_FILE: tmp }),
      });
      if (r.status !== 0) throw new Error("phase " + p + " failed (exit " + r.status + ")");
    }
  } finally {
    fs.unlinkSync(tmp);
  }
}

main().catch(function(err) {
  console.error("[mal-index] FAILED: " + (err && err.message ? err.message : err));
  process.exit(1);
});
