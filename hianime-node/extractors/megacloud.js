var crypto = require("crypto");
var config = require("../config");
var http = require("../utils/http");

var EMBED_DOMAINS = ["megacloud.tv", "megacloud.club", "megacloud.blog"];

function getBaseUrl(embedUrl) {
  try {
    var u = new URL(embedUrl);
    return u.origin;
  } catch (e) {
    return "https://megacloud.tv";
  }
}

function getVideoId(embedUrl) {
  var m = embedUrl.match(/\/(?:embed-\d+|e-\d+)\/(?:e-\d+\/)?([^?#/]+)/);
  return m ? m[1] : null;
}

function isMegaCloud(url) {
  for (var i = 0; i < EMBED_DOMAINS.length; i++) {
    if (url.indexOf(EMBED_DOMAINS[i]) >= 0) return true;
  }
  if (url.indexOf("rapid-cloud") >= 0) return true;
  if (url.indexOf("rabbitstream") >= 0) return true;
  return false;
}

function evpKDF(password, salt, keyLen, ivLen) {
  var pass = Buffer.from(password, "utf8");
  var derived = Buffer.alloc(0);
  var block = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    block = crypto.createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  return { key: derived.slice(0, keyLen), iv: derived.slice(keyLen, keyLen + ivLen) };
}

function decryptAES(encData, password) {
  var buf = Buffer.from(encData, "base64");
  if (buf.slice(0, 8).toString("utf8") !== "Salted__") {
    throw new Error("Missing Salted__ prefix");
  }
  var salt = buf.slice(8, 16);
  var ct = buf.slice(16);
  var kdf = evpKDF(password, salt, 32, 16);
  var decipher = crypto.createDecipheriv("aes-256-cbc", kdf.key, kdf.iv);
  var out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return out.toString("utf8");
}

async function extractIndexPairs(baseUrl) {
  var embedHtml = "";
  try {
    embedHtml = await http.fetchText(baseUrl + "/embed-2/e-1/test", {
      headers: { Referer: config.HIANIME_BASE + "/" },
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[megacloud] Could not fetch embed page: " + e.message);
  }

  var scriptUrl = "";
  var scriptMatch = embedHtml.match(/src="(\/js\/player\/a\/prod\/e1-player\.min\.js\?v=[^"]+)"/);
  if (!scriptMatch) scriptMatch = embedHtml.match(/src="(\/js\/player\/[^"]*\.js[^"]*)"/);
  if (scriptMatch) {
    scriptUrl = baseUrl + scriptMatch[1];
  }

  if (!scriptUrl) {
    console.warn("[megacloud] No player script found, trying known path");
    scriptUrl = baseUrl + "/js/player/a/prod/e1-player.min.js";
  }

  var scriptText = "";
  try {
    scriptText = await http.fetchText(scriptUrl, {
      headers: { Referer: baseUrl + "/" },
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[megacloud] Could not fetch player script: " + e.message);
    return null;
  }

  var patterns = [
    /case\s*0x\d+:\s*\w+\s*=\s*(\[\s*(?:0x[0-9a-f]+\s*,\s*0x[0-9a-f]+\s*,?\s*)+\])/gi,
    /\[\s*(\d+)\s*,\s*(\d+)\s*\]/g,
  ];

  var pairs = [];
  var hexArrayMatch = scriptText.match(/\[\s*(?:0x[0-9a-f]+\s*,\s*0x[0-9a-f]+\s*,?\s*){2,}\]/gi);
  if (hexArrayMatch) {
    for (var i = 0; i < hexArrayMatch.length; i++) {
      var nums = hexArrayMatch[i].match(/0x([0-9a-f]+)/gi);
      if (nums && nums.length >= 2 && nums.length % 2 === 0) {
        var tempPairs = [];
        for (var j = 0; j < nums.length; j += 2) {
          tempPairs.push([parseInt(nums[j], 16), parseInt(nums[j + 1], 16)]);
        }
        if (tempPairs.length >= 2 && tempPairs.length <= 20) {
          if (tempPairs.every(function(p) { return p[0] >= 0 && p[0] < 500 && p[1] >= 0 && p[1] < 100; })) {
            pairs = tempPairs;
            break;
          }
        }
      }
    }
  }

  if (pairs.length === 0) {
    console.warn("[megacloud] Could not extract index pairs from player script");
    return null;
  }

  console.log("[megacloud] Extracted " + pairs.length + " index pairs");
  return pairs;
}

function extractKeyFromSources(encSources, indexPairs) {
  var keyChars = [];
  var dataChars = [];
  var sourceChars = encSources.split("");

  var indexSet = {};
  for (var i = 0; i < indexPairs.length; i++) {
    var start = indexPairs[i][0];
    var len = indexPairs[i][1];
    for (var j = start; j < start + len && j < sourceChars.length; j++) {
      indexSet[j] = true;
      keyChars.push(sourceChars[j]);
    }
  }

  for (var k = 0; k < sourceChars.length; k++) {
    if (!indexSet[k]) dataChars.push(sourceChars[k]);
  }

  return { key: keyChars.join(""), data: dataChars.join("") };
}

async function extractM3u8(embedUrl) {
  var baseUrl = getBaseUrl(embedUrl);
  var videoId = getVideoId(embedUrl);
  if (!videoId) throw new Error("Could not extract video ID from " + embedUrl);

  console.log("[megacloud] Video ID: " + videoId + " from " + baseUrl);

  var sourcesUrl = baseUrl + "/embed-2/ajax/e-1/getSources?id=" + videoId;
  var data;
  try {
    data = await http.fetchJSON(sourcesUrl, {
      headers: {
        Referer: embedUrl,
        "X-Requested-With": "XMLHttpRequest",
      },
      timeout: 15000,
    });
  } catch (e) {
    throw new Error("getSources failed: " + e.message);
  }

  if (!data) throw new Error("Empty getSources response");

  var sources = data.sources;
  var tracks = data.tracks || [];
  var intro = data.intro || null;
  var outro = data.outro || null;

  if (Array.isArray(sources)) {
    console.log("[megacloud] Sources are unencrypted (array)");
  } else if (typeof sources === "string" && sources.length > 0) {
    console.log("[megacloud] Sources are encrypted, attempting decryption...");

    var indexPairs = await extractIndexPairs(baseUrl);
    if (indexPairs) {
      try {
        var extracted = extractKeyFromSources(sources, indexPairs);
        console.log("[megacloud] Key length: " + extracted.key.length + ", Data length: " + extracted.data.length);
        var decrypted = decryptAES(extracted.data, extracted.key);
        sources = JSON.parse(decrypted);
        console.log("[megacloud] Decryption successful, got " + sources.length + " sources");
      } catch (e) {
        console.error("[megacloud] Decryption failed: " + e.message);
        throw new Error("MegaCloud decryption failed: " + e.message);
      }
    } else {
      throw new Error("Could not extract decryption keys from player script");
    }
  } else {
    throw new Error("Unexpected sources format");
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("No sources after decryption");
  }

  var result = {
    sources: sources.map(function(s) {
      return {
        url: s.file || s.url || "",
        isM3U8: (s.file || s.url || "").indexOf(".m3u8") >= 0 || s.type === "hls",
        quality: "auto",
      };
    }).filter(function(s) { return s.url; }),
    subtitles: tracks.filter(function(t) { return t.kind === "captions" || t.kind === "subtitles"; }).map(function(t) {
      return { url: t.file, lang: t.label || "Unknown" };
    }),
    headers: { Referer: embedUrl },
  };

  if (intro) result.intro = intro;
  if (outro) result.outro = outro;

  if (result.sources.length === 0) throw new Error("No valid sources found");

  console.log("[megacloud] SUCCESS: " + result.sources[0].url.substring(0, 80) + "...");
  return result;
}

module.exports = { extractM3u8: extractM3u8, isMegaCloud: isMegaCloud };
