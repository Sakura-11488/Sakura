var kwik = require("./kwik");
var megacloud = require("./megacloud");
var config = require("../config");

async function extract(embedUrl, referer) {
  var errors = [];

  if (megacloud.isMegaCloud(embedUrl)) {
    try {
      console.log("[extract] Trying MegaCloud extractor for: " + embedUrl);
      var result = await megacloud.extractM3u8(embedUrl);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("MegaCloud: empty sources");
    } catch (e) {
      console.warn("[extract] MegaCloud failed: " + e.message);
      errors.push("MegaCloud: " + e.message);
    }
  }

  if (embedUrl.indexOf("kwik") >= 0) {
    try {
      console.log("[extract] Trying Kwik extractor for: " + embedUrl);
      var result = await kwik.extractM3u8(embedUrl, referer);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("Kwik: empty sources");
    } catch (e) {
      console.warn("[extract] Kwik failed: " + e.message);
      errors.push("Kwik: " + e.message);
    }
  }

  try {
    console.log("[extract] Trying generic extractor for: " + embedUrl);
    var http = require("../utils/http");
    var html = await http.fetchText(embedUrl, { headers: { Referer: referer || config.HIANIME_BASE + "/" } });
    var m = html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']*\.m3u8[^"']*)/i);
    if (m) return { sources: [{ url: m[1], isM3U8: true, quality: "auto" }], subtitles: [], headers: { Referer: embedUrl } };
    errors.push("Generic: no m3u8 in HTML");
  } catch (e) { errors.push("Generic: " + e.message); }

  throw new Error("All extractors failed: " + errors.join("; "));
}

module.exports = { extract: extract };
