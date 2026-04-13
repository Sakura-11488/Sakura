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
    var sub = tag.match(/data-sub="(\d+)"/);
    var dub = tag.match(/data-dub="(\d+)"/);
    var ttl = tag.match(/title="([^"]*)"/) || tag.match(/data-jp="([^"]*)"/);
    if (num) episodes.push({
      number: parseInt(num[1], 10),
      slug: sl ? sl[1] : num[1],
      mal: mal ? mal[1] : "",
      ids: ids ? ids[1] : "",
      hasSub: sub ? sub[1] === "1" : true,
      hasDub: dub ? dub[1] === "1" : false,
      title: ttl ? decodeHtml(ttl[1]) : "Episode " + num[1],
    });
  }
  return episodes;
}

async function getServersFromList(dataIds) {
  var url = config.HIANIME_BASE + "/ajax/server/list?servers=" + encodeURIComponent(dataIds);
  console.log("[hianime] /ajax/server/list ids=" + dataIds.substring(0, 40) + "...");
  try {
    var data = await http.fetchJSON(url, {
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
    });
    var html = data.result || data.html || (typeof data === "string" ? data : "");
    if (!html) { console.warn("[hianime] server/list: empty HTML"); return []; }
    console.log("[hianime] server/list HTML length: " + html.length);

    var servers = [];
    var m;

    var btnRe = /<a[^>]*class="btn"[^>]*>/gi;
    while ((m = btnRe.exec(html)) !== null) {
      var end = html.indexOf("</a>", m.index);
      var tag = end > 0 ? html.substring(m.index, end + 4) : html.substring(m.index, m.index + 500);
      var type = tag.match(/data-type="([^"]*)"/);
      var linkId = tag.match(/data-link-id="([^"]*)"/);
      var svId = tag.match(/data-sv-id="([^"]*)"/);
      var name = tag.match(/>([^<]*)<\/a>/);
      if (linkId) {
        servers.push({
          type: type ? type[1] : "sub",
          linkId: linkId[1],
          svId: svId ? svId[1] : "",
          name: name ? name[1].trim().toLowerCase() : "server",
          source: "list",
        });
      }
    }

    if (servers.length === 0) {
      var linkRe = /data-link-id="([^"]+)"/g;
      while ((m = linkRe.exec(html)) !== null) {
        var ctx = html.substring(Math.max(0, m.index - 300), Math.min(html.length, m.index + 300));
        var typeM = ctx.match(/data-type="([^"]*)"/);
        var nameM = ctx.match(/>([A-Za-z][^<]{0,30})<\/a>/);
        servers.push({
          type: typeM ? typeM[1] : "sub",
          linkId: m[1],
          name: nameM ? nameM[1].trim().toLowerCase() : "server",
          source: "list",
        });
      }
    }

    console.log("[hianime] server/list: " + servers.length + " servers (" +
      servers.filter(function(s){return s.type==="sub"}).length + " sub, " +
      servers.filter(function(s){return s.type==="dub"}).length + " dub)");
    servers.forEach(function(s) {
      console.log("[hianime]   - " + s.name + " type=" + s.type + " linkId=" + s.linkId.substring(0, 30) + "...");
    });
    return servers;
  } catch (e) {
    console.warn("[hianime] server/list failed: " + e.message);
    return [];
  }
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
    if (sv && sv.sub && sv.sub.url) servers.push({ name: name, type: "sub", linkId: sv.sub.url, source: "mal" });
    if (sv && sv.dub && sv.dub.url) servers.push({ name: name, type: "dub", linkId: sv.dub.url, source: "mal" });
  }
  return servers;
}

function qualityFromName(name) {
  var m = name.match(/(\d{3,4})p/i);
  return m ? parseInt(m[1], 10) : 0;
}

function sortByQualityDesc(servers) {
  return servers.slice().sort(function(a, b) {
    return qualityFromName(b.name) - qualityFromName(a.name);
  });
}

async function getEmbedFromServer(linkId) {
  var data = await http.fetchJSON(config.HIANIME_BASE + "/ajax/server?get=" + linkId, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });
  if (data && data.status === 200 && data.result) return { url: data.result.url, skipData: data.result.skip_data || null };
  return null;
}

async function resolveEmbedForEpisode(slug, epNum, category) {
  category = category || "sub";

  var info = await getInfo(slug);
  if (!info.animeId) throw new Error("Could not resolve animeId for " + slug);
  console.log("[hianime] animeId=" + info.animeId);

  var episodes = await getEpisodes(info.animeId);
  if (!episodes.length) throw new Error("No episodes found for " + slug);
  console.log("[hianime] " + episodes.length + " episodes found");

  var ep = episodes.find(function(e) { return e.number === epNum; });
  if (!ep) throw new Error("Episode " + epNum + " not found");

  var availableCategories = [];
  if (ep.hasSub) availableCategories.push("sub");
  if (ep.hasDub) availableCategories.push("dub");

  console.log("[hianime] Episode " + epNum + ": sub=" + ep.hasSub + " dub=" + ep.hasDub + " requested=" + category);

  var allServers = [];

  if (ep.ids) {
    var listServers = await getServersFromList(ep.ids);
    allServers = allServers.concat(listServers);
  }

  if (ep.mal) {
    var malServers = await getServersFromMal(ep.mal, ep.slug);
    allServers = allServers.concat(sortByQualityDesc(malServers));
  }

  if (!allServers.length) throw new Error("No servers found for episode " + epNum);
  console.log("[hianime] Total servers: " + allServers.length + " (list: " +
    allServers.filter(function(s){return s.source==="list"}).length + ", mal: " +
    allServers.filter(function(s){return s.source==="mal"}).length + ")");

  var filtered = allServers.filter(function(s) { return s.type === category; });
  if (filtered.length === 0) {
    console.warn("[hianime] No " + category + " servers, trying all");
    filtered = allServers;
  }

  var listFirst = filtered.filter(function(s){return s.source==="list"});
  var malSecond = sortByQualityDesc(filtered.filter(function(s){return s.source==="mal"}));
  var tryList = listFirst.concat(malSecond);

  for (var i = 0; i < tryList.length; i++) {
    try {
      console.log("[hianime] Trying: " + tryList[i].name + " (" + tryList[i].type + ", " + tryList[i].source + ")");
      var embed = await getEmbedFromServer(tryList[i].linkId);
      if (embed && embed.url) {
        console.log("[hianime] Embed: " + embed.url);
        return {
          embedUrl: embed.url,
          serverName: tryList[i].name,
          type: tryList[i].type,
          skipData: embed.skipData,
          availableCategories: availableCategories,
        };
      }
    } catch (e) { console.warn("[hianime] " + tryList[i].name + " failed: " + e.message); }
  }
  throw new Error("No embed URL found for category=" + category);
}

module.exports = { search, getInfo, getEpisodes, resolveEmbedForEpisode, __getServersFromList: getServersFromList };
