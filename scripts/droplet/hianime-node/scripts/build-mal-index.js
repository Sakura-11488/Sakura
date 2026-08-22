#!/usr/bin/env node
/**
 * Build data/mal-index.json from anime-offline-database.
 *
 *     node scripts/build-mal-index.js
 *
 * Produces the title -> MAL id index that scrapers/mal-map.js reads, which is
 * what lets playback use megaplay.buzz (addressed by MAL id) instead of the
 * dead megacloud.help. See the header of mal-map.js for why this is a static
 * index rather than an API call.
 *
 * RUN IT OUT OF BAND, NOT FROM THE SERVER PROCESS. The source dump is ~60MB of
 * JSON and parsing it peaks around 265MB of heap. This droplet has 961MB total
 * and roughly 368MB available while serving, so doing this inside the live
 * service would put it one allocation away from the OOM killer. As a one-shot
 * process it is fine, and the memory is gone the moment it exits.
 *
 * Re-run it periodically — weekly is plenty, new shows are the only thing that
 * changes. The service does NOT need a restart afterwards on the next cold
 * start, but does pick up a new index only when it reloads, so restart if you
 * want it live immediately.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SOURCE_URL = process.env.AOD_URL
  || "https://github.com/manami-project/anime-offline-database/releases/download/latest/anime-offline-database-minified.json";
const OUT_PATH = process.env.MAL_INDEX_PATH
  || path.join(__dirname, "..", "data", "mal-index.json");
// Cap how many distinct shows may share one title key. Six is far above any
// real collision and stops a pathological generic string ("movie") from
// bloating the file.
const MAX_PER_KEY = 6;

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

async function main() {
  const tmp = path.join(os.tmpdir(), "aod-" + process.pid + ".json");

  process.stdout.write("[mal-index] downloading anime-offline-database... ");
  const res = await fetch(SOURCE_URL, { redirect: "follow" });
  if (!res.ok) throw new Error("HTTP " + res.status + " fetching " + SOURCE_URL);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  console.log((fs.statSync(tmp).size / 1048576).toFixed(0) + "MB");

  try {
    const db = JSON.parse(fs.readFileSync(tmp, "utf8"));
    const entries = db.data || [];
    const index = new Map();
    let withMal = 0;

    for (const entry of entries) {
      const source = (entry.sources || []).find(function(s) {
        return /myanimelist\.net\/anime\/\d+/.test(s);
      });
      if (!source) continue;

      withMal += 1;
      const value = {
        m: Number(source.match(/anime\/(\d+)/)[1]),
        e: entry.episodes || 0,
        t: entry.type || "",
      };

      // Index the canonical title and every synonym, under both the plain and
      // the season-canonicalised form, so the resolver's keys can hit directly.
      const titles = [entry.title].concat(entry.synonyms || []);
      for (const title of titles) {
        const base = normalizeTitle(title);
        if (!base || base.length < 2) continue;
        for (const key of new Set([base, canonicalSeason(base), base.replace(/ /g, "")])) {
          if (!key) continue;
          let bucket = index.get(key);
          if (!bucket) { bucket = []; index.set(key, bucket); }
          if (bucket.length < MAX_PER_KEY && !bucket.some(function(x) { return x.m === value.m; })) {
            bucket.push(value);
          }
        }
      }
    }

    // Sanity-check BEFORE writing. The dump has carried ~30k MAL-linked entries
    // for years; a collapse means the schema moved, and writing first would
    // replace a good index with a mostly-empty one — turning a build failure
    // into a silent playback outage.
    if (withMal < 20000) {
      throw new Error("only " + withMal + " entries had a MAL id — refusing to overwrite "
        + OUT_PATH + " with a build this small");
    }

    // Write via a temp file and rename, so a crash mid-write cannot leave the
    // service reading a truncated index. rename(2) is atomic within a
    // filesystem, and both paths are in the same directory.
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    const staging = OUT_PATH + ".new";
    fs.writeFileSync(staging, JSON.stringify([...index]));
    fs.renameSync(staging, OUT_PATH);

    console.log("[mal-index] " + withMal + " shows with a MAL id, "
      + index.size + " title keys, "
      + (fs.statSync(OUT_PATH).size / 1048576).toFixed(1) + "MB -> " + OUT_PATH);
    console.log("[mal-index] peak heap "
      + (process.memoryUsage().heapUsed / 1048576).toFixed(0) + "MB");
  } finally {
    fs.unlinkSync(tmp);
  }
}

main().catch(function(err) {
  console.error("[mal-index] FAILED: " + (err && err.message ? err.message : err));
  process.exit(1);
});
