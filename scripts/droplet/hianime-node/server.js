var express = require("express");
var config = require("./config");
var hianime = require("./scrapers/hianime");
var extractor = require("./extractors/index");
var malMap = require("./scrapers/mal-map");
var app = express();

// ─── Readiness ───────────────────────────────────────────────────────────────
// Ported from the comics scraper, which learned this the hard way: a health
// check that only proves the process is up will report green through a total
// outage. This WALKS the real read path and asserts real content at every step.
var READY_TTL_MS = 60000;
var READY_FAIL_TTL_MS = 15000;
var readyCache = { at: 0, payload: null };
var readyInFlight = null;

/**
 * Walk the real read path for SEVERAL titles, not one.
 *
 * This probed a single keyword until 2026-08-22, and that made it actively
 * misleading. It sampled "bleach", which happened to sit on megacloud.help
 * while that host was Cloudflare-1027'd, and reported PLAYBACK DOWN for the
 * whole service — while One Piece, on a different embed host, was playing
 * perfectly the entire time. One title's luck decided the verdict for the
 * catalogue.
 *
 * Different titles resolve through genuinely different hosts, so a health check
 * that samples one of them is measuring a coin flip. This samples several and
 * reports the FRACTION, which is the only honest summary of a catalogue whose
 * backends differ per title.
 */
var READY_TITLES = (process.env.ANIME_READY_KEYWORDS || "one piece,jujutsu kaisen,dandadan")
  .split(",").map(function(s) { return s.trim(); }).filter(Boolean);

async function probeTitle(keyword) {
  var probe = { keyword: keyword, slug: null, name: null, episodes: 0, server: null, playable: false, reason: null };

  var results = await hianime.search(keyword);
  if (!results.length) { probe.reason = "search returned 0 results"; return probe; }
  probe.slug = results[0].slug;
  probe.name = results[0].name;

  var info = await hianime.getInfo(probe.slug);
  if (!info.animeId) { probe.reason = "no animeId from info"; return probe; }
  // An empty name is not cosmetic: mal-map matches on it, so playback silently
  // never reaches megaplay. Worth surfacing separately from a hard failure.
  if (!info.name) probe.reason = "info produced an empty name";

  var eps = await hianime.getEpisodes(info.animeId, probe.slug);
  probe.episodes = eps.length;
  if (!eps.length) { probe.reason = "0 episodes"; return probe; }

  // Go through resolveEmbedForEpisode rather than a hand-rolled chain, so this
  // exercises the same server selection and megaplay/mal-map path that real
  // playback uses. A check that walks its own route can pass while the route
  // users take is broken.
  try {
    var embed = await hianime.resolveEmbedForEpisode(probe.slug, eps[0].number, "sub");
    probe.server = embed.serverName;
    var out = await extractor.extract(embed.embedUrl, config.HIANIME_BASE + "/");
    probe.playable = Boolean(out && out.sources && out.sources.length);
    if (!probe.playable) probe.reason = "extractor returned no sources";
  } catch (err) {
    probe.reason = String(err && err.message ? err.message : err).slice(0, 140);
  }
  return probe;
}

async function runReadiness() {
  var probes = [];
  for (var i = 0; i < READY_TITLES.length; i += 1) {
    try {
      probes.push(await probeTitle(READY_TITLES[i]));
    } catch (err) {
      probes.push({
        keyword: READY_TITLES[i],
        playable: false,
        reason: (err && err.code ? err.code + ": " : "") + String(err && err.message ? err.message : err).slice(0, 140),
      });
    }
  }

  var playable = probes.filter(function(p) { return p.playable; }).length;
  var browsable = probes.filter(function(p) { return p.episodes > 0; }).length;
  var checks = {
    sampled: probes.length,
    playable: playable,
    browsable: browsable,
    malIndexLoaded: malMap.isLoaded(),
    malIndexKeys: malMap.indexSize(),
    probes: probes,
  };

  // Browsing broken everywhere is a real outage; the parser or the upstream has
  // moved and nothing works.
  if (!browsable) {
    return { ok: false, reason: "no sampled title produced an episode list", checks: checks };
  }

  // mal-map is what routes playback to megaplay. Without the index every title
  // falls back to hianime's own servers, which is where the dead host lives —
  // so a missing index looks like "playback is down" unless it is called out.
  if (!malMap.isLoaded()) {
    return {
      ok: true, degraded: true,
      reason: "MAL INDEX MISSING — playback will fall back to hianime's own servers. "
        + "Run: node scripts/build-mal-index.js",
      checks: checks,
    };
  }

  if (!playable) {
    if (String(process.env.ANIME_READY_REQUIRE_PLAYBACK || "0") === "1") {
      return { ok: false, reason: "no sampled title was playable", checks: checks };
    }
    return { ok: true, degraded: true, reason: "BROWSE OK, PLAYBACK DOWN for all " + probes.length + " sampled titles", checks: checks };
  }

  if (playable < probes.length) {
    return {
      ok: true, degraded: true,
      reason: "playback works for " + playable + " of " + probes.length + " sampled titles",
      checks: checks,
    };
  }

  return { ok: true, degraded: false, checks: checks };
}

app.get("/readyz", async function(_req, res) {
  var now = Date.now();
  var ttl = readyCache.payload && readyCache.payload.ok ? READY_TTL_MS : READY_FAIL_TTL_MS;
  if (readyCache.payload && now - readyCache.at < ttl) {
    return res.status(readyCache.payload.ok ? 200 : 503).json(
      Object.assign({}, readyCache.payload, { cached: true })
    );
  }
  // Single-flight: without it, N concurrent probes each run a full walk against
  // the upstream. A deploy script polling in a loop is the most likely offender.
  if (!readyInFlight) {
    readyInFlight = (async function() {
      var payload;
      try {
        payload = await runReadiness();
      } catch (err) {
        payload = {
          ok: false,
          reason: (err && err.code ? err.code + ": " : "") + String(err && err.message ? err.message : err).slice(0, 200),
          checks: null,
        };
      }
      readyCache = { at: Date.now(), payload: payload };
      return payload;
    })().finally(function() { readyInFlight = null; });
  }
  var payload = await readyInFlight;
  res.status(payload.ok ? 200 : 503).json(payload);
});

function serializeError(error) {
  return {
    error: error && error.message ? error.message : "Unknown error",
    code: error && error.code ? error.code : undefined,
    stage: error && error.stage ? error.stage : undefined,
    details: error && error.details ? error.details : undefined,
  };
}

// HiAnime's wrapper /ajax/mal endpoint sometimes returns skip data in
// `[start, end]` array form, sometimes `{start, end}` object form, and
// sometimes a meaningless `[0,0]`/`{start:0,end:0}` placeholder. Treat
// anything where `end <= start` as no skip data so we don't clobber the
// real values resolved further down by the actual extractor.
function readSkipPair(value) {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 2) {
    return { start: Number(value[0]) || 0, end: Number(value[1]) || 0 };
  }
  if (typeof value === "object") {
    return { start: Number(value.start) || 0, end: Number(value.end) || 0 };
  }
  return null;
}

function hasRealSkipData(value) {
  var pair = readSkipPair(value);
  return Boolean(pair && pair.end > pair.start);
}

function normalizeSkipBlock(value) {
  return readSkipPair(value);
}

app.get("/", function(req, res) {
  res.json({ status: "ok", version: "2.4.3", domain: config.HIANIME_BASE });
});

app.get("/api/search", async function(req, res) {
  var kw = req.query.keyword || req.query.q || "";
  if (!kw) return res.status(400).json({ error: "Missing keyword" });
  try {
    res.json({ results: await hianime.search(kw) });
  } catch (error) {
    res.status(500).json(serializeError(error));
  }
});

app.get("/api/info/:slug", async function(req, res) {
  try {
    res.json(await hianime.getInfo(req.params.slug));
  } catch (error) {
    res.status(500).json(serializeError(error));
  }
});

app.get("/api/episodes/:animeId", async function(req, res) {
  try {
    // The upstream episode endpoint selects the anime by Referer, not by the id
    // in its path, so a slug is required to build that Referer. It normally
    // comes from the scraper's cache (populated by /api/info), but that cache is
    // empty after a restart — and a client holding a cached animeId would then
    // get NO_SLUG. Accept the slug explicitly as well: either as ?slug=, or by
    // passing the slug itself as the path param, since a slug is never numeric.
    var param = String(req.params.animeId || "");
    var slugHint = String(req.query.slug || "") || (/^\d+$/.test(param) ? "" : param);
    var animeId = /^\d+$/.test(param)
      ? param
      : (param.match(/-(\d+)$/) || [, param])[1];
    var eps = await hianime.getEpisodes(animeId, slugHint);
    res.json({ totalEpisodes: eps.length, episodes: eps });
  } catch (error) {
    res.status(500).json(serializeError(error));
  }
});

/**
 * Anime metadata by MAL id, served from the offline index.
 *
 * The app gets this from Jikan directly, with no proxy in between, and renders
 * "Could not load anime — No data returned for this title" when the call fails.
 * Jikan fails PER ID rather than wholesale: on 2026-08-22, MAL 38883 (Haikyuu!!
 * To the Top — finished, 13 episodes, and playable through megaplay) returned
 * 504 on every attempt while MAL 60636 returned 200 in the same second. Nothing
 * about that is visible to a retry or a health check, and the show is perfectly
 * available — only the metadata lookup is missing.
 *
 * So this is the fallback: the same 30,561 shows, already on disk for the title
 * index, answered from a file that cannot go down. It carries no synopsis
 * because the dump has none — the client keeps whatever description it already
 * had rather than inventing one.
 */
app.get("/api/meta/:malId", function(req, res) {
  var malId = String(req.params.malId || "").trim();
  if (!/^\d+$/.test(malId)) {
    return res.status(400).json({ error: "malId must be numeric", code: "BAD_MAL_ID" });
  }
  if (!malMap.metaLoaded()) {
    // Distinguished from "not found" on purpose: one is a deployment problem
    // this box can fix, the other is a show the database has never heard of.
    return res.status(503).json({
      error: "metadata index not built — run scripts/build-mal-index.js",
      code: "META_INDEX_MISSING",
    });
  }
  var found = malMap.metaFor(malId);
  if (!found) {
    return res.status(404).json({ error: "no metadata for MAL " + malId, code: "META_NOT_FOUND" });
  }
  res.json(found);
});

app.get("/api/m3u8/:slug/:epNum", async function(req, res) {
  var slug = req.params.slug, epNum = req.params.epNum;
  var category = req.query.category || "sub";
  if (category !== "sub" && category !== "dub") category = "sub";
  console.log("\n[m3u8] Request: " + slug + " ep " + epNum + " category=" + category);
  try {
    var embed = await hianime.resolveEmbedForEpisode(slug, parseInt(epNum, 10), category);
    console.log("[m3u8] Embed: " + embed.embedUrl + " (" + embed.serverName + ", " + embed.type + ")");
    var result = await extractor.extract(embed.embedUrl, config.HIANIME_BASE + "/");
    // Only override intro/outro from wrapper skip_data if it carries real
    // values. hianime.dk's /ajax/mal often returns [0,0] / {start:0,end:0}
    // for titles where Megaplay has the actual markers — clobbering the
    // extractor's real values with zeros disables the Skip Intro / Outro
    // buttons in the player for no reason.
    if (embed.skipData && hasRealSkipData(embed.skipData.intro)) {
      result.intro = normalizeSkipBlock(embed.skipData.intro);
    }
    if (embed.skipData && hasRealSkipData(embed.skipData.outro)) {
      result.outro = normalizeSkipBlock(embed.skipData.outro);
    }
    result.category = embed.type;
    result.availableCategories = embed.availableCategories || ["sub"];
    result.debug = { serverName: embed.serverName, triedServers: embed.triedServers || [] };
    console.log("[m3u8] SUCCESS: " + result.sources[0].url.substring(0, 80) + "...");
    res.json(result);
  } catch (error) {
    console.error("[m3u8] FAILED: " + error.message);
    res.status(500).json(serializeError(error));
  }
});

app.get("/api/debug/:slug/:epNum", async function(req, res) {
  var slug = req.params.slug, epNum = parseInt(req.params.epNum, 10);
  var category = req.query.category || "sub";
  var debug = { slug: slug, epNum: epNum, category: category, steps: [] };
  try {
    var info = await hianime.getInfo(slug);
    debug.steps.push({ step: "getInfo", animeId: info.animeId, name: info.name });
    if (!info.animeId) { debug.error = "No animeId"; return res.json(debug); }

    var episodes = await hianime.getEpisodes(info.animeId);
    var ep = episodes.find(function(e) { return e.number === epNum; });
    debug.steps.push({ step: "getEpisodes", total: episodes.length, episode: ep || null });
    if (!ep) { debug.error = "Episode not found"; return res.json(debug); }

    var listServers = [];
    if (ep.ids) {
      try {
        var http = require("./utils/http");
        var rawUrl = config.HIANIME_BASE + "/ajax/server/list?servers=" + encodeURIComponent(ep.ids);
        var rawData = await http.fetchJSON(rawUrl, {
          headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
        });
        var rawHtml = rawData.result || rawData.html || "";
        debug.steps.push({ step: "serverListRaw", htmlLength: rawHtml.length, htmlPreview: rawHtml.substring(0, 500) });
        listServers = await require("./scrapers/hianime").__getServersFromList
          ? await require("./scrapers/hianime").__getServersFromList(ep.ids)
          : [];
      } catch (e) {
        debug.steps.push({ step: "serverListRaw", error: e.message });
      }
    }
    debug.steps.push({ step: "listServers", count: listServers.length, servers: listServers });

    var malServers = [];
    if (ep.mal) {
      try {
        var ts = Math.floor(Date.now() / 1000);
        var malUrl = config.HIANIME_BASE + "/ajax/mal?mal=" + encodeURIComponent(ep.mal) + "&ep=" + ep.slug + "&ts=" + ts;
        var malRaw = await require("./utils/http").fetchJSON(malUrl, {
          headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
        });
        debug.steps.push({ step: "malRaw", data: malRaw });
      } catch (e) {
        debug.steps.push({ step: "malRaw", error: e.message });
      }
    }

    var embedResults = [];
    try {
      var embed = await hianime.resolveEmbedForEpisode(slug, epNum, category);
      debug.steps.push({ step: "resolveEmbed", embed: embed });

      try {
        var result = await extractor.extract(embed.embedUrl, config.HIANIME_BASE + "/");
        debug.steps.push({
          step: "extract",
          sourcesCount: result.sources ? result.sources.length : 0,
          firstSource: result.sources && result.sources[0] ? result.sources[0].url.substring(0, 100) : null,
          subtitlesCount: result.subtitles ? result.subtitles.length : 0,
        });
      } catch (error) {
        debug.steps.push({
          step: "extract",
          error: error.message,
          code: error.code,
          stage: error.stage,
          details: error.details,
        });
      }
    } catch (error) {
      debug.steps.push({
        step: "resolveEmbed",
        error: error.message,
        code: error.code,
        stage: error.stage,
        details: error.details,
      });
    }

    res.json(debug);
  } catch (error) {
    debug.error = error.message;
    debug.code = error.code;
    debug.stage = error.stage;
    debug.details = error.details;
    res.json(debug);
  }
});

app.listen(config.PORT, function() {
  console.log("[server] hianime-node v2.4.3 on port " + config.PORT);
  console.log("[server] Domain: " + config.HIANIME_BASE);
});
