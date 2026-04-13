var crypto = require("crypto");
var config = require("../config");
var http = require("../utils/http");

var EMBED_DOMAINS = (config.MEGACLOUD_BASES || []).map(function(base) {
  return base.replace(/^https?:\/\//, "");
}).concat([
  "rapid-cloud.co",
  "rapid-cloud.ru",
  "rabbitstream.net",
  "rabbitstream.xyz",
]);

function getBaseUrl(embedUrl) {
  try {
    return new URL(embedUrl).origin;
  } catch (error) {
    return config.MEGACLOUD_BASES && config.MEGACLOUD_BASES[0] ? config.MEGACLOUD_BASES[0] : "https://megacloud.tv";
  }
}

function getVideoId(embedUrl) {
  var match = embedUrl.match(/\/(?:embed(?:-\d+)?|e-\d+|v)\/(?:e-\d+\/)?([^?#/]+)/);
  return match ? match[1] : null;
}

function isMegaCloud(url) {
  for (var index = 0; index < EMBED_DOMAINS.length; index += 1) {
    if (url.indexOf(EMBED_DOMAINS[index]) >= 0) return true;
  }
  return false;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
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
  var ciphertext = buf.slice(16);
  var kdf = evpKDF(password, salt, 32, 16);
  var decipher = crypto.createDecipheriv("aes-256-cbc", kdf.key, kdf.iv);
  var out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString("utf8");
}

function toAbsoluteUrl(baseUrl, maybeRelative) {
  if (!maybeRelative) return "";
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  if (maybeRelative.charAt(0) === "/") return baseUrl + maybeRelative;
  return baseUrl + "/" + maybeRelative;
}

async function fetchEmbedHtml(embedUrl) {
  try {
    return await http.fetchText(embedUrl, {
      headers: { Referer: config.HIANIME_BASE + "/" },
      timeout: 10000,
    });
  } catch (error) {
    console.warn("[megacloud] embed fetch failed, retrying with curl: " + error.message);
    return http.curlText(embedUrl, config.HIANIME_BASE + "/");
  }
}

async function fetchPlayerScript(scriptUrl, baseUrl) {
  try {
    return await http.fetchText(scriptUrl, {
      headers: { Referer: baseUrl + "/" },
      timeout: 10000,
    });
  } catch (error) {
    console.warn("[megacloud] script fetch failed, retrying with curl: " + error.message);
    return http.curlText(scriptUrl, baseUrl + "/");
  }
}

async function extractIndexPairs(embedUrl, baseUrl) {
  var embedHtml = await fetchEmbedHtml(embedUrl);
  var scriptMatches = embedHtml.match(/src="([^"]+player[^"]+\.js[^"]*)"/gi) || [];
  var candidateScripts = [];

  for (var index = 0; index < scriptMatches.length; index += 1) {
    var pathMatch = scriptMatches[index].match(/src="([^"]+)"/i);
    if (pathMatch) {
      candidateScripts.push(toAbsoluteUrl(baseUrl, pathMatch[1]));
    }
  }

  candidateScripts.push(baseUrl + "/js/player/a/prod/e1-player.min.js");

  for (var scriptIndex = 0; scriptIndex < candidateScripts.length; scriptIndex += 1) {
    var scriptUrl = candidateScripts[scriptIndex];
    var scriptText = "";
    try {
      scriptText = await fetchPlayerScript(scriptUrl, baseUrl);
    } catch (error) {
      continue;
    }

    var hexArrays = scriptText.match(/\[\s*(?:0x[0-9a-f]+\s*,\s*0x[0-9a-f]+\s*,?\s*){2,}\]/gi);
    if (!hexArrays) continue;

    for (var arrayIndex = 0; arrayIndex < hexArrays.length; arrayIndex += 1) {
      var nums = hexArrays[arrayIndex].match(/0x([0-9a-f]+)/gi);
      if (!nums || nums.length < 2 || nums.length % 2 !== 0) continue;

      var pairs = [];
      for (var pairIndex = 0; pairIndex < nums.length; pairIndex += 2) {
        pairs.push([parseInt(nums[pairIndex], 16), parseInt(nums[pairIndex + 1], 16)]);
      }

      if (pairs.length >= 2 && pairs.length <= 20 && pairs.every(function(pair) {
        return pair[0] >= 0 && pair[0] < 500 && pair[1] > 0 && pair[1] < 100;
      })) {
        console.log("[megacloud] Extracted " + pairs.length + " index pairs from " + scriptUrl);
        return pairs;
      }
    }
  }

  return null;
}

function extractKeyFromSources(encSources, indexPairs) {
  var keyChars = [];
  var dataChars = [];
  var sourceChars = encSources.split("");
  var indexSet = {};

  for (var pairIndex = 0; pairIndex < indexPairs.length; pairIndex += 1) {
    var start = indexPairs[pairIndex][0];
    var len = indexPairs[pairIndex][1];
    for (var index = start; index < start + len && index < sourceChars.length; index += 1) {
      indexSet[index] = true;
      keyChars.push(sourceChars[index]);
    }
  }

  for (var charIndex = 0; charIndex < sourceChars.length; charIndex += 1) {
    if (!indexSet[charIndex]) dataChars.push(sourceChars[charIndex]);
  }

  return { key: keyChars.join(""), data: dataChars.join("") };
}

async function fetchSourcesPayload(baseUrl, videoId, embedUrl) {
  var endpoints = [
    baseUrl + "/embed-2/ajax/e-1/getSources?id=" + videoId,
    baseUrl + "/ajax/embed-6-v2/getSources?id=" + videoId,
    baseUrl + "/ajax/embed-6/getSources?id=" + videoId,
  ];
  var lastError = null;

  for (var index = 0; index < endpoints.length; index += 1) {
    try {
      var data = await http.fetchJSON(endpoints[index], {
        headers: {
          Referer: embedUrl,
          Origin: baseUrl,
          "X-Requested-With": "XMLHttpRequest",
        },
        timeout: 15000,
      });
      if (data && (data.sources || data.sourcesBackup)) {
        return data;
      }
      lastError = new Error("Empty getSources response from " + endpoints[index]);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error("getSources failed: " + (lastError ? lastError.message : "no endpoints succeeded"));
}

function normalizeSourceEntries(rawSources) {
  if (Array.isArray(rawSources)) return rawSources;
  if (typeof rawSources === "string") {
    var parsed = safeJsonParse(rawSources);
    if (Array.isArray(parsed)) return parsed;
  }
  return null;
}

async function extractEncryptedSources(sources, embedUrl, baseUrl) {
  var indexPairs = await extractIndexPairs(embedUrl, baseUrl);
  if (!indexPairs) {
    throw new Error("Could not extract decryption keys from player script");
  }

  var extracted = extractKeyFromSources(sources, indexPairs);
  var decrypted = decryptAES(extracted.data, extracted.key);
  var parsed = safeJsonParse(decrypted);
  if (!Array.isArray(parsed)) {
    throw new Error("MegaCloud decrypted payload was not a source array");
  }
  return parsed;
}

async function extractM3u8(embedUrl) {
  var baseUrl = getBaseUrl(embedUrl);
  var videoId = getVideoId(embedUrl);
  if (!videoId) throw new Error("Could not extract video ID from " + embedUrl);

  console.log("[megacloud] Video ID: " + videoId + " from " + baseUrl);

  var data = await fetchSourcesPayload(baseUrl, videoId, embedUrl);
  var tracks = data.tracks || [];
  var intro = data.intro || null;
  var outro = data.outro || null;
  var sources = normalizeSourceEntries(data.sources);

  if (!sources && typeof data.sources === "string" && data.sources.length > 0) {
    sources = await extractEncryptedSources(data.sources, embedUrl, baseUrl);
  }

  if ((!sources || sources.length === 0) && data.sourcesBackup) {
    sources = normalizeSourceEntries(data.sourcesBackup) || [];
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("No sources after MegaCloud resolution");
  }

  var result = {
    sources: sources.map(function(source) {
      var url = source.file || source.url || "";
      return {
        url: url,
        isM3U8: url.indexOf(".m3u8") >= 0 || source.type === "hls",
        quality: source.label || source.quality || "auto",
      };
    }).filter(function(source) {
      return source.url;
    }),
    subtitles: tracks.filter(function(track) {
      return track.kind === "captions" || track.kind === "subtitles";
    }).map(function(track) {
      return { url: track.file, lang: track.label || "Unknown" };
    }),
    headers: { Referer: embedUrl },
  };

  if (intro) result.intro = intro;
  if (outro) result.outro = outro;

  if (result.sources.length === 0) {
    throw new Error("No valid MegaCloud sources found");
  }

  console.log("[megacloud] SUCCESS: " + result.sources[0].url.substring(0, 80) + "...");
  return result;
}

module.exports = {
  extractM3u8: extractM3u8,
  isMegaCloud: isMegaCloud,
};
