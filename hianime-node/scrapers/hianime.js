var config = require("../config");
var http = require("../utils/http");

function decodeHtml(s) {
  return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x27;/g,"'").replace(/&#x2F;/g,"/");
}

async function search(keyword) {
  var url = config.HIANIME_BASE + "/search?keyword=" + encodeURIComponent(keyword);
  var html = await http.fetchText(url);
  var results = [];
  var re = /<div class="flw-item"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, m;
  while ((m = re.exec(html)) !== null) {
    var b = m[0];
    var sl = b.match(/href="\/watch\/([^"?#]+?)(?:\/ep-\d+)?"/);
    var nm = b.match(/class="d-title"[^>]*>\s*([^<]+)/);
    if (!nm) nm = b.match(/class="film-name"[\s\S]*?<a[^>]*>\s*([^<]+)/);
    var po = b.match(/class="film-poster-img"[^>]*src="([^"]+)"/);
    if (sl && nm) results.push({ slug: sl[1], name: decodeHtml(nm[1].trim()), poster: po ? po[1] : "" });
  }
  return results;
}

async function getInfo(slug) {
  var html = await http.fetchText(config.HIANIME_BASE + "/watch/" + slug);
  var id = html.match(/data-id="(\d+)"/);
  var nm = html.match(/class="[^"]*d-title[^"]*"[^>]*>\s*([^<]+)/);
  var po = html.match(/class="film-poster-img"[^>]*src="([^"]+)"/);
  return { animeId: id ? id[1] : "", name: nm ? decodeHtml(nm[1].trim()) : "", poster: po ? po[1] : "" };
}

async function getEpisodes(animeId) {
  var data = await http.fetchJSON(config.HIANIME_BASE + "/ajax/episode/list/" + animeId, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });
  var html = data.result || data.html || "";
  var episodes = [], re = /<a[^>]*class="ssl-item ep-item[^"]*"[^>]*>/g, m;
  while ((m = re.exec(html)) !== null) {
    var end = html.indexOf("</a>", m.index);
    var tag = end > 0 ? html.substring(m.index, end) : m[0];
    var num = tag.match(/data-num="(\d+)"/);
    var sl = tag.match(/data-slug="([^"]+)"/);
    var mal = tag.match(/data-mal="([^"]+)"/);
    var ids = tag.match(/data-ids="([^"]+)"/);
    var ttl = tag.match(/title="([^"]*)"/) || tag.match(/data-jp="([^"]*)"/);
    if (num) episodes.push({
      number: parseInt(num[1], 10),
      slug: sl ? sl[1] : num[1],
      mal: mal ? mal[1] : "",
      ids: ids ? ids[1] : "",
      title: ttl ? decodeHtml(ttl[1]) : "Episode " + num[1],
    });
  }
  return episodes;
}

async function getServersFromMal(malValue, epSlug) {
  var ts = Math.floor(Date.now() / 1000);
  var url = config.HIANIME_BASE + "/ajax/mal?mal=" + encodeURIComponent(malValue) + "&ep=" + epSlug + "&ts=" + ts;
  console.log("[hianime] /ajax/mal ep=" + epSlug);
  var data = await http.fetchJSON(url, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });
  var servers = [];
  for (var name in data) {
    if (name === "status") continue;
    var sv = data[name];
    if (sv && sv.sub && sv.sub.url) servers.push({ name: name, type: "sub", linkId: sv.sub.url });
    if (sv && sv.dub && sv.dub.url) servers.push({ name: name, type: "dub", linkId: sv.dub.url });
  }
  return servers;
}

async function getEmbedFromServer(linkId) {
  var data = await http.fetchJSON(config.HIANIME_BASE + "/ajax/server?get=" + linkId, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });
  if (data && data.status === 200 && data.result) return { url: data.result.url, skipData: data.result.skip_data || null };
  return null;
}

async function resolveEmbedForEpisode(slug, epNum) {
  var info = await getInfo(slug);
  if (!info.animeId) throw new Error("Could not resolve animeId for " + slug);
  console.log("[hianime] animeId=" + info.animeId);

  var episodes = await getEpisodes(info.animeId);
  if (!episodes.length) throw new Error("No episodes found for " + slug);
  console.log("[hianime] " + episodes.length + " episodes found");

  var ep = episodes.find(function(e) { return e.number === epNum; });
  if (!ep) throw new Error("Episode " + epNum + " not found");
  if (!ep.mal) throw new Error("Episode " + epNum + " has no mal data");

  var servers = await getServersFromMal(ep.mal, ep.slug);
  if (!servers.length) throw new Error("No servers from /ajax/mal");
  console.log("[hianime] " + servers.length + " servers found");

  var subs = servers.filter(function(s) { return s.type === "sub"; });
  var tryList = subs.length > 0 ? subs : servers;
  for (var i = 0; i < tryList.length; i++) {
    try {
      console.log("[hianime] Trying: " + tryList[i].name);
      var embed = await getEmbedFromServer(tryList[i].linkId);
      if (embed && embed.url) {
        console.log("[hianime] Embed: " + embed.url);
        return { embedUrl: embed.url, serverName: tryList[i].name, type: tryList[i].type, skipData: embed.skipData };
      }
    } catch (e) { console.warn("[hianime] " + tryList[i].name + " failed: " + e.message); }
  }
  throw new Error("No embed URL found");
}

module.exports = { search, getInfo, getEpisodes, resolveEmbedForEpisode };
