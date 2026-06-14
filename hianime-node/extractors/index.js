var kwik = require("./kwik");
var megacloud = require("./megacloud");
var megaplay = require("./megaplay");
var config = require("../config");

function makeExtractorError(code, message, details) {
  var error = new Error(message);
  error.stage = "extractor";
  error.code = code;
  error.details = details || {};
  return error;
}

async function extract(embedUrl, referer) {
  var errors = [];

  if (/\.m3u8(\?|$)/i.test(embedUrl)) {
    return {
      sources: [{ url: embedUrl, isM3U8: true, quality: "auto" }],
      subtitles: [],
      headers: { Referer: referer || config.HIANIME_BASE + "/" },
    };
  }

  if (megacloud.isMegaCloud(embedUrl)) {
    try {
      console.log("[extract] Trying MegaCloud extractor for: " + embedUrl);
      var result = await megacloud.extractM3u8(embedUrl);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("MegaCloud: empty sources");
    } catch (error) {
      console.warn("[extract] MegaCloud failed: " + error.message);
      errors.push("MegaCloud: " + error.message);
    }
  }

  if (megaplay.isMegaplay(embedUrl)) {
    try {
      console.log("[extract] Trying Megaplay extractor for: " + embedUrl);
      var result = await megaplay.extractM3u8(embedUrl);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("Megaplay: empty sources");
    } catch (error) {
      console.warn("[extract] Megaplay failed: " + error.message);
      errors.push("Megaplay: " + error.message);
    }
  }

  if (embedUrl.indexOf("kwik") >= 0) {
    try {
      console.log("[extract] Trying Kwik extractor for: " + embedUrl);
      var result = await kwik.extractM3u8(embedUrl, referer);
      if (result && result.sources && result.sources.length > 0) return result;
      errors.push("Kwik: empty sources");
    } catch (error) {
      console.warn("[extract] Kwik failed: " + error.message);
      errors.push("Kwik: " + error.message);
    }
  }

  try {
    console.log("[extract] Trying generic extractor for: " + embedUrl);
    var http = require("../utils/http");
    var html = await http.fetchText(embedUrl, { headers: { Referer: referer || config.HIANIME_BASE + "/" } });
    var m = html.match(/(?:file|source|src)\s*[:=]\s*["']([^"']*\.m3u8[^"']*)/i);
    if (m) return { sources: [{ url: m[1], isM3U8: true, quality: "auto" }], subtitles: [], headers: { Referer: embedUrl } };
    var playlistMatch = html.match(/https?:\/\/[^"'\\]+\.m3u8[^"'\\]*/i);
    if (playlistMatch) {
      return {
        sources: [{ url: playlistMatch[0], isM3U8: true, quality: "auto" }],
        subtitles: [],
        headers: { Referer: embedUrl },
      };
    }
    errors.push("Generic: no m3u8 in HTML");
  } catch (error) {
    errors.push("Generic: " + error.message);
  }

  throw makeExtractorError("EMBED_EXTRACTION_FAILED", "All extractors failed: " + errors.join("; "), {
    embedUrl: embedUrl,
    referer: referer || config.HIANIME_BASE + "/",
    attempts: errors,
  });
}

module.exports = { extract: extract };
