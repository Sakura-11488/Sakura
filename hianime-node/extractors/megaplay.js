/**
 * megaplay.buzz extractor.
 *
 * As of late 2025/early 2026 HiAnime increasingly routes embeds through
 * `megaplay.buzz` instead of `megacloud.*`. Megaplay does NOT inline the
 * .m3u8 URL in its initial HTML — the player page renders an empty
 * <video> container with a `data-id` attribute, then the client JS calls
 * a `/stream/getSources?id=<dataId>` JSON endpoint to fetch the playlist.
 *
 * Two URL shapes show up in practice:
 *   1.  https://megaplay.buzz/stream/mal/<malId>/<ep>/<sub|dub>
 *       → server-side redirect / inline render that contains an iframe
 *         pointing at the s-2 player page below.
 *   2.  https://megaplay.buzz/stream/s-2/<dataId>/<sub|dub>
 *       → the actual player page where `data-id="<dataId>"` lives.
 *
 * The MAL-style URL is what HiAnime hands us via /ajax/mal, so the
 * extractor accepts either shape: if the entry-point HTML doesn't expose
 * the data-id directly, we look for the embedded s-2 iframe and follow it.
 */

var http = require("../utils/http");
var config = require("../config");

var MEGAPLAY_DOMAINS = [
  "megaplay.buzz",
  "megaplay.tv",
  "megaplay.club",
  "megaplay.live",
];

// HiAnime now serves its own /player/mal/<malId>/<ep>/<cat> page that
// wraps a megaplay iframe, in addition to handing out direct megaplay
// URLs. Both shapes resolve through the same data-id + /getSources
// flow, so we route them to the same extractor.
var HIANIME_PLAYER_PATTERNS = [/\/player\/mal\//i, /\/embed\//i, /\/stream\/(?:mal|s-\d+)\//i];

function isMegaplay(url) {
  if (!url) return false;
  for (var i = 0; i < MEGAPLAY_DOMAINS.length; i += 1) {
    if (url.indexOf(MEGAPLAY_DOMAINS[i]) >= 0) return true;
  }
  // hianime.dk player wrappers: e.g. https://hianime.dk/player/mal/9253/1/sub
  if (/hianime\./i.test(url)) {
    for (var p = 0; p < HIANIME_PLAYER_PATTERNS.length; p += 1) {
      if (HIANIME_PLAYER_PATTERNS[p].test(url)) return true;
    }
  }
  return false;
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (error) {
    return "https://megaplay.buzz";
  }
}

function findDataId(html) {
  if (!html) return null;
  // Try common patterns megaplay uses for the player container.
  var patterns = [
    /data-id\s*=\s*"(\d+)"/i,
    /data-id\s*=\s*'(\d+)'/i,
    /getSources\?id=(\d+)/i,
    /"id"\s*:\s*"?(\d+)"?\s*,\s*"sources"/i,
    /\\?"id\\?"\s*:\s*"?(\d+)"?/i,
    /\/stream\/getSources\?id=(\d+)/i,
  ];
  for (var index = 0; index < patterns.length; index += 1) {
    var match = html.match(patterns[index]);
    if (match && match[1]) return match[1];
  }
  return null;
}

function findSubPlayerUrl(html, baseUrl) {
  if (!html) return null;
  // Some pages (e.g. hianime.dk/player/mal/...) wrap the real player in
  // an iframe pointing at megaplay/megacloud or at /stream/s-2/<id>/<cat>.
  // Prefer iframes whose src actually looks like a player; only fall back
  // to "first iframe on the page" if nothing better matches, to avoid
  // following an ad/tracker iframe.
  var iframeMatches = html.match(/<iframe[^>]+src=["']([^"']+)["']/gi) || [];
  var srcs = iframeMatches
    .map(function (tag) {
      var m = tag.match(/src=["']([^"']+)["']/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  function normalizeSrc(src) {
    if (/^\/\//.test(src)) return "https:" + src;
    if (/^\//.test(src)) return baseUrl + src;
    return src;
  }

  var preferred = srcs.find(function (src) {
    return /megaplay|megacloud|rapid-cloud|rabbitstream|\/stream\/s-\d+\//i.test(src);
  });
  if (preferred) return normalizeSrc(preferred);
  if (srcs.length > 0) return normalizeSrc(srcs[0]);

  var s2Match = html.match(/(\/stream\/s-2\/\d+\/(?:sub|dub))/i);
  if (s2Match) return baseUrl + s2Match[1];
  return null;
}

function categoryFromUrl(url) {
  var match = (url || "").match(/\/(sub|dub)(?:[\/?#]|$)/i);
  return match ? match[1].toLowerCase() : "sub";
}

async function fetchHtml(url, referer) {
  var requestRef = referer || (config.HIANIME_BASE + "/");
  try {
    return await http.fetchText(url, {
      headers: { Referer: requestRef },
      timeout: 12000,
    });
  } catch (error) {
    console.warn("[megaplay] embed fetch failed, retrying with curl: " + error.message);
    return http.curlText(url, requestRef);
  }
}

async function fetchSourcesJson(baseUrl, dataId, embedUrl) {
  // Megaplay has cycled through a couple of paths. Try each until one
  // returns a usable payload — none should require auth, and a 404 is
  // cheap.
  var endpoints = [
    baseUrl + "/stream/getSources?id=" + dataId,
    baseUrl + "/getSources?id=" + dataId,
    baseUrl + "/ajax/getSources?id=" + dataId,
    baseUrl + "/stream/sources?id=" + dataId,
  ];

  var lastError = null;
  for (var index = 0; index < endpoints.length; index += 1) {
    var url = endpoints[index];
    try {
      var data = await http.fetchJSON(url, {
        headers: {
          Referer: embedUrl,
          Origin: baseUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 15000,
      });
      if (data) return { data: data, endpoint: url };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    "Megaplay getSources failed: " +
      (lastError ? lastError.message : "all endpoints returned no data")
  );
}

function pickFile(data) {
  // Megaplay payloads vary across versions. Confirmed via live probe on
  // 2026-05-27, the current shape on megaplay.buzz is:
  //   { sources: { file: "https://...m3u8" }, tracks, intro, outro, t, server }
  // i.e. `sources` is a single OBJECT, not an array. We still fall back
  // to the older array / `file` / `source` / `url` / `link` / `hls` shapes
  // because mirrors and forks ship variants, and this code is the only
  // thing standing between the app and "no streams" once megaplay rotates.
  if (!data || typeof data !== "object") return null;

  if (typeof data.file === "string" && data.file) return data.file;
  if (typeof data.url === "string" && data.url) return data.url;
  if (typeof data.link === "string" && data.link) return data.link;
  if (typeof data.hls === "string" && data.hls) return data.hls;

  if (Array.isArray(data.sources) && data.sources.length > 0) {
    var first = data.sources[0];
    if (first && typeof first.file === "string") return first.file;
    if (first && typeof first.url === "string") return first.url;
  }

  if (data.sources && typeof data.sources === "object" && !Array.isArray(data.sources)) {
    if (typeof data.sources.file === "string") return data.sources.file;
    if (typeof data.sources.url === "string") return data.sources.url;
  }

  if (data.source && typeof data.source === "object") {
    if (typeof data.source.file === "string") return data.source.file;
    if (typeof data.source.url === "string") return data.source.url;
  }

  // Some forks nest under `data` or `result`.
  if (data.data && typeof data.data === "object") {
    var nested = pickFile(data.data);
    if (nested) return nested;
  }
  if (data.result && typeof data.result === "object") {
    var resultNested = pickFile(data.result);
    if (resultNested) return resultNested;
  }

  return null;
}

function pickTracks(data) {
  if (!data) return [];
  var raw = Array.isArray(data.tracks)
    ? data.tracks
    : Array.isArray(data.subtitles)
      ? data.subtitles
      : [];
  return raw
    .filter(function (track) {
      if (!track) return false;
      var kind = (track.kind || "").toLowerCase();
      // Some payloads omit `kind` entirely and just give file+label.
      if (!kind) return Boolean(track.file || track.url);
      return kind === "captions" || kind === "subtitles";
    })
    .map(function (track) {
      return {
        file: track.file || track.url || "",
        url: track.file || track.url || "",
        lang: track.label || track.lang || "Unknown",
      };
    })
    .filter(function (track) {
      return Boolean(track.file);
    });
}

async function extractM3u8(embedUrl) {
  var entryOrigin = getOrigin(embedUrl);
  var sourcesOrigin = entryOrigin;
  var html = await fetchHtml(embedUrl);

  var dataId = findDataId(html);
  var resolvedEmbedUrl = embedUrl;

  // Wrapper entry pages (hianime.dk/player/..., megaplay/stream/mal/...) do
  // NOT expose data-id directly. Follow the player iframe one hop to land
  // on the real player page (usually megaplay.buzz/stream/s-2/<id>/<cat>),
  // and use THAT origin for the /getSources call — calling getSources on
  // hianime.dk would obviously 404.
  if (!dataId) {
    var subPlayerUrl = findSubPlayerUrl(html, entryOrigin);
    if (subPlayerUrl) {
      console.log("[megaplay] hop to player: " + subPlayerUrl);
      resolvedEmbedUrl = subPlayerUrl;
      sourcesOrigin = getOrigin(subPlayerUrl);
      var subHtml = await fetchHtml(subPlayerUrl, embedUrl);
      dataId = findDataId(subHtml);
      if (!dataId) {
        var inlineId = subPlayerUrl.match(/\/s-2\/(\d+)/);
        if (inlineId) dataId = inlineId[1];
      }
    }
  }

  if (!dataId) {
    // Last-ditch: the URL itself may already include the id (e.g. the
    // /s-2/<dataId>/<cat> shape).
    var inlinePathId = embedUrl.match(/\/s-2\/(\d+)/);
    if (inlinePathId) dataId = inlinePathId[1];
  }

  if (!dataId) {
    throw new Error("Megaplay: could not locate data-id for " + embedUrl);
  }

  console.log("[megaplay] data-id=" + dataId + " sourcesOrigin=" + sourcesOrigin);

  var resolved = await fetchSourcesJson(sourcesOrigin, dataId, resolvedEmbedUrl);
  var data = resolved.data;
  var file = pickFile(data);

  if (!file) {
    throw new Error(
      "Megaplay: getSources returned no file (endpoint " +
        resolved.endpoint +
        ")"
    );
  }

  var category = categoryFromUrl(resolvedEmbedUrl) || categoryFromUrl(embedUrl);

  var result = {
    sources: [
      {
        url: file,
        isM3U8: file.indexOf(".m3u8") >= 0,
        quality: "auto",
      },
    ],
    subtitles: pickTracks(data),
    headers: { Referer: resolvedEmbedUrl },
    category: category,
  };

  if (data && data.intro) result.intro = data.intro;
  if (data && data.outro) result.outro = data.outro;

  console.log(
    "[megaplay] SUCCESS via " +
      resolved.endpoint +
      ": " +
      file.substring(0, 80) +
      "..."
  );
  return result;
}

module.exports = {
  extractM3u8: extractM3u8,
  isMegaplay: isMegaplay,
};
