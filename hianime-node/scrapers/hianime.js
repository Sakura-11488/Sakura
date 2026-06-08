var config = require("../config");
var http = require("../utils/http");
var cheerio = require("cheerio");

function decodeHtml(value) {
  return (value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function makeStageError(stage, code, message, details) {
  var error = new Error(message);
  error.stage = stage;
  error.code = code;
  error.details = details || {};
  return error;
}

async function search(keyword) {
  var url = config.HIANIME_BASE + "/search?keyword=" + encodeURIComponent(keyword);
  var html = await http.fetchText(url);
  var $ = cheerio.load(html);
  var results = [];
  $(".flw-item").each(function(_, element) {
    var $el = $(element);
    var link = $el.find("a.d-title, a.film-poster-ahref").first();
    var href = link.attr("href") || $el.find("a[href*='/watch/']").first().attr("href") || "";
    var slugMatch = href.match(/\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/);
    var title = $el.find("a.d-title").first().text().trim() || $el.find(".film-name a").first().text().trim();
    var poster = $el.find(".film-poster-img").first().attr("src") || "";
    var tip = $el.find(".film-poster").first().attr("data-tip");
    var animeIdFromSearch = tip && /^\d+$/.test(String(tip).trim()) ? String(tip).trim() : "";
    if (slugMatch && title) {
      results.push({
        slug: slugMatch[1],
        name: decodeHtml(title),
        poster: poster,
        animeId: animeIdFromSearch,
      });
    }
  });
  return results;
}

async function getInfo(slug) {
  var html = await http.fetchText(config.HIANIME_BASE + "/watch/" + slug);
  var id = html.match(/data-id="(\d+)"/);
  var nameMatch = html.match(/class="[^"]*d-title[^"]*"[^>]*>\s*([^<]+)/);
  var posterMatch = html.match(/class="film-poster-img"[^>]*src="([^"]+)"/);
  return {
    animeId: id ? id[1] : "",
    name: nameMatch ? decodeHtml(nameMatch[1].trim()) : "",
    poster: posterMatch ? posterMatch[1] : "",
  };
}

async function getEpisodes(animeId) {
  var data = await http.fetchJSON(config.HIANIME_BASE + "/ajax/episode/list/" + animeId, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });
  var html = data.result || data.html || "";
  var episodes = [];
  var re = /<a[^>]*(?:class="[^"]*ep-item[^"]*"|data-number="[^"]+"|data-num="[^"]+")/gi;
  var match;

  while ((match = re.exec(html)) !== null) {
    var end = html.indexOf("</a>", match.index);
    var tag = end > 0 ? html.substring(match.index, end + 4) : html.substring(match.index, match.index + 800);
    var num = tag.match(/data-number="(\d+)"/) || tag.match(/data-num="(\d+)"/);
    var slugMatch = tag.match(/data-slug="([^"]+)"/);
    var malMatch = tag.match(/data-mal="([^"]+)"/);
    var idsMatch = tag.match(/data-ids="([^"]+)"/);
    var subMatch = tag.match(/data-sub="(\d+)"/);
    var dubMatch = tag.match(/data-dub="(\d+)"/);
    var titleMatch = tag.match(/title="([^"]*)"/) || tag.match(/data-jp="([^"]*)"/) || tag.match(/<span[^>]*class="name"[^>]*>([^<]*)<\/span>/);

    if (!num) continue;
    episodes.push({
      number: parseInt(num[1], 10),
      slug: slugMatch ? slugMatch[1] : num[1],
      mal: malMatch ? malMatch[1] : "",
      ids: idsMatch ? idsMatch[1] : "",
      hasSub: subMatch ? subMatch[1] === "1" : true,
      hasDub: dubMatch ? dubMatch[1] === "1" : false,
      title: titleMatch ? decodeHtml(titleMatch[1].trim()) : "Episode " + num[1],
    });
  }

  // Fallback: site markup may change; scan for episode numbers in ep-item / ssl-item blocks
  if (episodes.length === 0 && html && html.length > 10) {
    var seen = Object.create(null);
    var numRe = /data-number="(\d+)"|data-num="(\d+)"/g;
    var nm;
    while ((nm = numRe.exec(html)) !== null) {
      var n = parseInt(nm[1] || nm[2], 10);
      if (n > 0 && !seen[n]) {
        seen[n] = true;
        episodes.push({
          number: n,
          slug: String(n),
          mal: "",
          ids: "",
          hasSub: true,
          hasDub: false,
          title: "Episode " + n,
        });
      }
    }
  }

  return episodes.sort(function(left, right) {
    return left.number - right.number;
  });
}

async function getServersFromList(dataIds) {
  var url = config.HIANIME_BASE + "/ajax/server/list?servers=" + encodeURIComponent(dataIds);
  console.log("[hianime] /ajax/server/list ids=" + dataIds.substring(0, 40) + "...");
  try {
    var data = await http.fetchJSON(url, {
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
    });
    var html = data.result || data.html || (typeof data === "string" ? data : "");
    if (!html) {
      console.warn("[hianime] server/list: empty HTML");
      return [];
    }

    var servers = [];
    var re = /<(a|div|button)[^>]*data-link-id="([^"]+)"[^>]*>/gi;
    var match;
    while ((match = re.exec(html)) !== null) {
      var end = html.indexOf("</" + match[1] + ">", match.index);
      var tag = end > 0 ? html.substring(match.index, end + match[1].length + 3) : html.substring(match.index, match.index + 500);
      var type = tag.match(/data-type="([^"]*)"/);
      var serverId = tag.match(/data-sv-id="([^"]*)"/);
      var name = tag.match(/>([^<]*)</);
      servers.push({
        type: type ? type[1] : "sub",
        linkId: match[2],
        svId: serverId ? serverId[1] : "",
        name: name ? name[1].trim().toLowerCase() : "server",
        source: "list",
      });
    }

    return servers;
  } catch (error) {
    console.warn("[hianime] server/list failed: " + error.message);
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
    var value = data[name];
    if (value && value.sub && value.sub.url) {
      servers.push({ name: name, type: "sub", linkId: value.sub.url, source: "mal" });
    }
    if (value && value.dub && value.dub.url) {
      servers.push({ name: name, type: "dub", linkId: value.dub.url, source: "mal" });
    }
  }
  return servers;
}

function qualityFromName(name) {
  var match = (name || "").match(/(\d{3,4})p/i);
  return match ? parseInt(match[1], 10) : 0;
}

function sortServersForPlayback(servers) {
  return servers.slice().sort(function(left, right) {
    var leftPreferred = config.PREFERRED_SERVERS.some(function(preferred) {
      return (left.name || "").indexOf(preferred) >= 0;
    });
    var rightPreferred = config.PREFERRED_SERVERS.some(function(preferred) {
      return (right.name || "").indexOf(preferred) >= 0;
    });
    if (leftPreferred !== rightPreferred) {
      return rightPreferred ? 1 : -1;
    }
    return qualityFromName(right.name || "") - qualityFromName(left.name || "");
  });
}

async function getEmbedFromServer(linkId) {
  if (!linkId) return null;
  if (/^https?:\/\//i.test(linkId)) {
    return { url: linkId, skipData: null };
  }

  var data = await http.fetchJSON(config.HIANIME_BASE + "/ajax/server?get=" + encodeURIComponent(linkId), {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: config.HIANIME_BASE + "/" },
  });

  var result = data && data.result ? data.result : data;
  if (result && typeof result === "string" && /^https?:\/\//i.test(result)) {
    return { url: result, skipData: null };
  }
  if (result && result.url) {
    return { url: result.url, skipData: result.skip_data || result.skipData || null };
  }
  if (result && result.link) {
    return { url: result.link, skipData: result.skip_data || result.skipData || null };
  }
  return null;
}

async function resolveEmbedForEpisode(slug, epNum, category) {
  category = category || "sub";

  var info = await getInfo(slug);
  if (!info.animeId) {
    throw makeStageError("info", "ANIME_ID_NOT_FOUND", "Could not resolve animeId for " + slug, { slug: slug });
  }

  var episodes = await getEpisodes(info.animeId);
  if (!episodes.length) {
    throw makeStageError("episodes", "EPISODE_LIST_EMPTY", "No episodes found for " + slug, {
      slug: slug,
      animeId: info.animeId,
    });
  }

  var episode = episodes.find(function(entry) {
    return entry.number === epNum;
  });
  if (!episode) {
    throw makeStageError("episodes", "EPISODE_NOT_FOUND", "Episode " + epNum + " not found", {
      slug: slug,
      animeId: info.animeId,
      requestedEpisode: epNum,
      episodeCount: episodes.length,
      firstEpisode: episodes[0] ? episodes[0].number : null,
      lastEpisode: episodes.length ? episodes[episodes.length - 1].number : null,
    });
  }

  var availableCategories = [];
  if (episode.hasSub) availableCategories.push("sub");
  if (episode.hasDub) availableCategories.push("dub");

  var allServers = [];
  if (episode.ids) {
    allServers = allServers.concat(await getServersFromList(episode.ids));
  }
  if (episode.mal) {
    allServers = allServers.concat(await getServersFromMal(episode.mal, episode.slug));
  }

  if (!allServers.length) {
    throw makeStageError("servers", "NO_SERVERS", "No playback servers found for episode " + epNum, {
      slug: slug,
      animeId: info.animeId,
      requestedEpisode: epNum,
      availableCategories: availableCategories,
      episodeMeta: {
        ids: episode.ids || "",
        mal: episode.mal || "",
      },
    });
  }

  var filtered = allServers.filter(function(server) {
    return server.type === category;
  });
  if (filtered.length === 0) {
    filtered = allServers;
  }

  var tryList = sortServersForPlayback(filtered);
  var serverErrors = [];

  for (var index = 0; index < tryList.length; index += 1) {
    var server = tryList[index];
    try {
      console.log("[hianime] Trying: " + server.name + " (" + server.type + ", " + server.source + ")");
      var embed = await getEmbedFromServer(server.linkId);
      if (embed && embed.url) {
        return {
          embedUrl: embed.url,
          serverName: server.name,
          type: server.type,
          skipData: embed.skipData,
          availableCategories: availableCategories,
          triedServers: tryList.map(function(item) {
            return { name: item.name, type: item.type, source: item.source };
          }),
        };
      }
      serverErrors.push({ server: server.name, error: "empty embed response" });
    } catch (error) {
      serverErrors.push({ server: server.name, error: error.message });
      console.warn("[hianime] " + server.name + " failed: " + error.message);
    }
  }

  throw makeStageError("embed", "EMBED_RESOLUTION_FAILED", "No embed URL found for category=" + category, {
    slug: slug,
    animeId: info.animeId,
    requestedEpisode: epNum,
    requestedCategory: category,
    availableCategories: availableCategories,
    triedServers: tryList.map(function(item) {
      return { name: item.name, type: item.type, source: item.source };
    }),
    serverErrors: serverErrors,
  });
}

async function resolveEmbedsForEpisode(slug, epNum, category) {
  category = category || "sub";

  var info = await getInfo(slug);
  if (!info.animeId) {
    throw makeStageError("info", "ANIME_ID_NOT_FOUND", "Could not resolve animeId for " + slug, { slug: slug });
  }

  var episodes = await getEpisodes(info.animeId);
  var episode = episodes.find(function(entry) {
    return entry.number === epNum;
  });
  if (!episode) {
    throw makeStageError("episodes", "EPISODE_NOT_FOUND", "Episode " + epNum + " not found", {
      slug: slug,
      animeId: info.animeId,
      requestedEpisode: epNum,
      episodeCount: episodes.length,
      firstEpisode: episodes[0] ? episodes[0].number : null,
      lastEpisode: episodes.length ? episodes[episodes.length - 1].number : null,
    });
  }

  var availableCategories = [];
  if (episode.hasSub) availableCategories.push("sub");
  if (episode.hasDub) availableCategories.push("dub");

  var allServers = [];
  if (episode.ids) {
    allServers = allServers.concat(await getServersFromList(episode.ids));
  }
  if (episode.mal) {
    allServers = allServers.concat(await getServersFromMal(episode.mal, episode.slug));
  }

  if (!allServers.length) {
    throw makeStageError("servers", "NO_SERVERS", "No playback servers found for episode " + epNum, {
      slug: slug,
      animeId: info.animeId,
      requestedEpisode: epNum,
      availableCategories: availableCategories,
      episodeMeta: {
        ids: episode.ids || "",
        mal: episode.mal || "",
      },
    });
  }

  var filtered = allServers.filter(function(server) {
    return server.type === category;
  });
  if (filtered.length === 0) {
    filtered = allServers;
  }

  var tryList = sortServersForPlayback(filtered);
  var embeds = [];
  var serverErrors = [];

  for (var index = 0; index < tryList.length; index += 1) {
    var server = tryList[index];
    try {
      var embed = await getEmbedFromServer(server.linkId);
      if (embed && embed.url) {
        embeds.push({
          embedUrl: embed.url,
          serverName: server.name,
          type: server.type,
          skipData: embed.skipData,
          availableCategories: availableCategories,
          triedServers: tryList.map(function(item) {
            return { name: item.name, type: item.type, source: item.source };
          }),
        });
      } else {
        serverErrors.push({ server: server.name, error: "empty embed response" });
      }
    } catch (error) {
      serverErrors.push({ server: server.name, error: error.message });
      console.warn("[hianime] " + server.name + " failed while collecting embeds: " + error.message);
    }
  }

  if (embeds.length) {
    return { embeds: embeds, serverErrors: serverErrors };
  }

  throw makeStageError("embed", "EMBED_RESOLUTION_FAILED", "No embed URL found for category=" + category, {
    slug: slug,
    animeId: info.animeId,
    requestedEpisode: epNum,
    requestedCategory: category,
    availableCategories: availableCategories,
    triedServers: tryList.map(function(item) {
      return { name: item.name, type: item.type, source: item.source };
    }),
    serverErrors: serverErrors,
  });
}

async function getHomePage() {
  var html = await http.fetchText(config.HIANIME_BASE + "/home");
  var $ = cheerio.load(html);
  var trending = [];
  $("#trending-home .swiper-slide, .deslide-item, .trending-list .flw-item").each(function(_, el) {
    var link = $(el).find("a[href*='/watch/'], a.d-title, a.film-poster-ahref").first();
    var href = link.attr("href") || "";
    var slugMatch = href.match(/\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/);
    var title = $(el).find(".d-title, .film-name a, .desi-head-title a").first().text().trim();
    var poster = $(el).find(".film-poster-img, .desi-head-poster img, img").first().attr("data-src") ||
                 $(el).find(".film-poster-img, .desi-head-poster img, img").first().attr("src") || "";
    if (slugMatch && title) {
      trending.push({ slug: slugMatch[1], name: decodeHtml(title), poster: poster });
    }
  });
  if (trending.length === 0) {
    $(".flw-item").each(function(_, el) {
      var link = $(el).find("a[href*='/watch/'], a.d-title").first();
      var href = link.attr("href") || "";
      var slugMatch = href.match(/\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/);
      var title = $(el).find("a.d-title").first().text().trim() || $(el).find(".film-name a").first().text().trim();
      var poster = $(el).find(".film-poster-img").first().attr("data-src") ||
                   $(el).find(".film-poster-img").first().attr("src") || "";
      if (slugMatch && title && trending.length < 24) {
        trending.push({ slug: slugMatch[1], name: decodeHtml(title), poster: poster });
      }
    });
  }
  return trending;
}

module.exports = {
  search: search,
  getInfo: getInfo,
  getEpisodes: getEpisodes,
  resolveEmbedForEpisode: resolveEmbedForEpisode,
  resolveEmbedsForEpisode: resolveEmbedsForEpisode,
  getHomePage: getHomePage,
  __getServersFromList: getServersFromList,
};
