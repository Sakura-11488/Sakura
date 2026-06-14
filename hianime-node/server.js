var express = require("express");
var config = require("./config");
var hianime = require("./scrapers/hianime");
var extractor = require("./extractors/index");
var app = express();

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
    var eps = await hianime.getEpisodes(req.params.animeId);
    res.json({ totalEpisodes: eps.length, episodes: eps });
  } catch (error) {
    res.status(500).json(serializeError(error));
  }
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
