var kwik = require("./kwik");
var config = require("../config");

async function extract(embedUrl, referer) {
  var errors = [];
  if (embedUrl.indexOf("kwik") >= 0) {
    try {
      var result = await kwik.extractM3u8(embedUrl, referer);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("Kwik: empty sources");
    } catch (e) { errors.push("Kwik: " + e.message); }
  }
  try {
    var http = require("../utils/http");
    var html = await http.fetchText(embedUrl, { headers: { Referer: referer || config.HIANIME_BASE + "/" } });
    var m = html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']*\.m3u8[^"']*)/i);
    if (m) return { sources: [{ url: m[1], isM3U8: true, quality: "auto" }], subtitles: [], headers: { Referer: embedUrl } };
  } catch (e) { errors.push("Generic: " + e.message); }
  throw new Error("All extractors failed: " + errors.join("; "));
}

module.exports = { extract: extract };
