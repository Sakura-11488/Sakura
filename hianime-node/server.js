var express = require("express");
var config = require("./config");
var hianime = require("./scrapers/hianime");
var extractor = require("./extractors/index");
var app = express();

app.get("/", function(req, res) {
  res.json({ status: "ok", version: "2.0.0", domain: config.HIANIME_BASE });
});

app.get("/api/search", async function(req, res) {
  var kw = req.query.keyword || req.query.q || "";
  if (!kw) return res.status(400).json({ error: "Missing keyword" });
  try { res.json({ results: await hianime.search(kw) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/info/:slug", async function(req, res) {
  try { res.json(await hianime.getInfo(req.params.slug)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/episodes/:animeId", async function(req, res) {
  try {
    var eps = await hianime.getEpisodes(req.params.animeId);
    res.json({ totalEpisodes: eps.length, episodes: eps });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/m3u8/:slug/:epNum", async function(req, res) {
  var slug = req.params.slug, epNum = req.params.epNum;
  console.log("\n[m3u8] Request: " + slug + " ep " + epNum);
  try {
    var embed = await hianime.resolveEmbedForEpisode(slug, parseInt(epNum, 10));
    console.log("[m3u8] Embed: " + embed.embedUrl + " (" + embed.serverName + ")");
    var result = await extractor.extract(embed.embedUrl, config.HIANIME_BASE + "/");
    if (embed.skipData) { result.intro = embed.skipData.intro; result.outro = embed.skipData.outro; }
    console.log("[m3u8] SUCCESS: " + result.sources[0].url.substring(0, 80) + "...");
    res.json(result);
  } catch (e) {
    console.error("[m3u8] FAILED: " + e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(config.PORT, function() {
  console.log("[server] hianime-node v2.0.0 on port " + config.PORT);
  console.log("[server] Domain: " + config.HIANIME_BASE);
});
