var config = require("../config");
var http = require("../utils/http");

async function extractM3u8(embedUrl, referer) {
  console.log("[kwik] Extracting: " + embedUrl);
  var html;
  try {
    html = await http.fetchText(embedUrl, { headers: { Referer: referer || config.HIANIME_BASE + "/" } });
  } catch (e) {
    console.warn("[kwik] fetch failed, trying curl");
    html = http.curlText(embedUrl, referer || config.HIANIME_BASE + "/");
  }

  var blocks = [];
  var re = /\}\('((?:\\.|[^'])*)',\s*(\d+),\s*(\d+),\s*'([^']*)'\s*\.\s*split/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    blocks.push({ code: m[1], base: parseInt(m[2],10), count: parseInt(m[3],10), words: m[4].split("|") });
  }
  if (!blocks.length) throw new Error("No packed JS on kwik page");

  var b = blocks[blocks.length - 1];
  console.log("[kwik] Unpacking block: base=" + b.base + " count=" + b.count + " words=" + b.words.length);

  function e62(c) {
    var s = c >= b.base ? e62(Math.floor(c / b.base)) : "";
    var r = c % b.base;
    return s + (r > 35 ? String.fromCharCode(r + 29) : r.toString(36));
  }
  var dict = {};
  for (var i = 0; i < b.count; i++) {
    var k = e62(i);
    dict[k] = (i < b.words.length && b.words[i]) ? b.words[i] : k;
  }
  var unpacked = b.code.replace(/\b(\w+)\b/g, function(match) { return dict[match] || match; });

  var m3u8 = unpacked.match(/https?:\/\/[^\s;'"\\]+\.m3u8[^\s;'"\\]*/);
  if (!m3u8) throw new Error("No m3u8 URL in unpacked kwik JS");

  console.log("[kwik] m3u8: " + m3u8[0]);
  return {
    sources: [{ url: m3u8[0], isM3U8: true, quality: "auto" }],
    subtitles: [],
    headers: { Referer: embedUrl },
  };
}

module.exports = { extractM3u8: extractM3u8 };
