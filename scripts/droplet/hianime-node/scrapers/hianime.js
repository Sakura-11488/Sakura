var config = require("../config");
var http = require("../utils/http");
var cheerio = require("cheerio");
var malMap = require("./mal-map");

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

/**
 * animeId -> slug, so getEpisodes can build the Referer the upstream requires.
 *
 * Since the 2026-08-19 redesign, /api/theme/episode/list/<id> IGNORES the id in
 * its path and returns whatever anime the Referer points at. Proven: requesting
 * list/8360 with a Referer for witch-hat-atelier-8928 returns witch-hat's 10
 * episodes, not Bleach's 14. A wrong or missing Referer yields a 16-byte body
 * and zero episodes — with HTTP 200, so it fails silently.
 *
 * getInfo() already fetches the watch page for a slug, and every caller resolves
 * info before episodes, so recording the pair there is enough. Bounded so a long
 * -running process cannot grow this without limit.
 */
var slugByAnimeId = new Map();
var SLUG_CACHE_MAX = 500;

function rememberSlug(animeId, slug) {
  if (!animeId || !slug) return;
  if (slugByAnimeId.size >= SLUG_CACHE_MAX) {
    slugByAnimeId.delete(slugByAnimeId.keys().next().value);
  }
  slugByAnimeId.set(String(animeId), slug);
}

function watchRefererFor(animeId, slugHint) {
  var slug = slugHint || slugByAnimeId.get(String(animeId)) || "";
  return slug ? config.HIANIME_BASE + "/watch/" + slug : "";
}

function makeStageError(stage, code, message, details) {
  var error = new Error(message);
  error.stage = stage;
  error.code = code;
  error.details = details || {};
  return error;
}

// Elements whose content is raw text to a parser, so an unclosed one swallows
// the rest of the document rather than just breaking its own subtree.
var SWALLOWING_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };

/**
 * Repair opening tags that never terminate.
 *
 * On 2026-08-22 hianime.dk began serving a Google Analytics tag with neither
 * its attribute quote nor its angle bracket closed:
 *
 *     <script async src="https://www.googletagmanager.com/gtag/js?id=G-E
 *     </head>
 *     <body class="">   ...the 30 result cards...
 *
 * A conforming parser MUST treat everything after an unclosed <script> as raw
 * script text, so cheerio produced a 213KB <head> and an empty <body> —
 * $("a").length was 0 on a page with hundreds of links. Nothing threw; search
 * just returned [] with HTTP 200, which the app cannot tell from "no matches".
 *
 * An opening tag that reaches the next '<' without ever closing is malformed by
 * definition: a well-formed tag ends at '>' before any '<' can appear. So the
 * match itself is the detector, and well-formed markup cannot match.
 */
function repairUnterminatedTags(html) {
  return String(html).replace(
    /<([a-zA-Z][\w-]*)\b[^>]*?(?=<[a-zA-Z/])/g,
    function(match, tag) {
      var fixed = match;
      // Close a dangling attribute value first. Without this the '>' we append
      // lands INSIDE the open quote and terminates nothing.
      if ((fixed.match(/"/g) || []).length % 2) fixed += '"';
      if ((fixed.match(/'/g) || []).length % 2) fixed += "'";
      fixed += ">";
      if (SWALLOWING_TAGS[tag.toLowerCase()]) fixed += "</" + tag + ">";
      return fixed;
    }
  );
}

/**
 * Re-rank search results so the SERIES someone asked for comes first.
 *
 * hianime's own ordering buries it. Searching "naruto" returns 27 results with
 * the actual Naruto at position 20, behind an unaired announcement, Boruto and
 * eleven movies; "demon slayer" puts the series at 7 of 13, behind four films
 * and two arc compilations. Since the app plays the first result, tapping it
 * lands on something with no episodes — which reads as "anime is broken" even
 * though playback is fine, and that is exactly what it looked like.
 *
 * This only ever REORDERS. Nothing is dropped and nothing is invented, so the
 * worst a bad score can do is put a title lower than someone wanted — never
 * hide it, and never substitute a different show.
 */
var SIDE_CONTENT = /\b(movie|ova|ona|special|specials|spin[- ]?off|recap|compilation|picture drama|summary)\b/i;

function scoreResult(result, normalizedQuery) {
  var name = normalizeTitleForRank(result.name || "");
  var score = 0;

  if (name === normalizedQuery) score += 1000;                 // "Naruto" for "naruto"
  else if (name.indexOf(normalizedQuery + " ") === 0) score += 400;  // begins with the query
  else if (name.indexOf(normalizedQuery) !== -1) score += 100;       // mentions it

  // Films, OVAs and recap compilations share the franchise name and are almost
  // never what a bare franchise search means.
  if (SIDE_CONTENT.test(result.name || "")) score -= 500;

  // Among genuine series, the base entry has the shortest name; every extra
  // word is a season, arc or subtitle qualifier the user did not ask for.
  var extraWords = name.split(" ").length - normalizedQuery.split(" ").length;
  if (extraWords > 0) score -= Math.min(extraWords, 12) * 12;

  return score;
}

function normalizeTitleForRank(value) {
  return String(value).toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function rankResults(results, keyword) {
  var q = normalizeTitleForRank(keyword);
  if (!q) return results;
  return results
    .map(function(r, i) { return { r: r, i: i, s: scoreResult(r, q) }; })
    // Ties keep upstream order, so this can only ever be a refinement of it.
    .sort(function(a, b) { return b.s - a.s || a.i - b.i; })
    .map(function(x) { return x.r; });
}

/**
 * Collapse long-vowel romanisation, or return "" when nothing changes.
 *
 * Japanese long vowels get romanised two ways and the databases disagree
 * constantly: MAL writes "Haikyuu!! To the Top", hianime writes "Haikyu!! To
 * The Top". Searching hianime for "haikyuu" returns six specials and movies and
 * NOT the series, while "haikyu" returns the whole franchise — so a title that
 * is fully available reads as "No streaming source found".
 *
 * Same shape for Juujutsu/Jujutsu, Ryuu/Ryu, Touhou/Tohou, Shounen/Shonen.
 */
function collapseLongVowels(keyword) {
  var variant = String(keyword)
    .replace(/([aiueo])\1+/gi, "$1")
    .replace(/ou/gi, "o");
  return variant.toLowerCase() === String(keyword).toLowerCase() ? "" : variant;
}

/**
 * Did we get the thing asked for, or only its siblings?
 *
 * EXACT match only, deliberately. A prefix test looks reasonable and is too
 * lenient: searching "haikyuu" returns "Haikyuu!!: vs. Akaten", which starts
 * with the query, so a prefix rule calls that a hit and never retries — while
 * the series itself sits under the single-u spelling and stays invisible.
 *
 * Being strict here only costs one extra upstream request, and only for
 * queries that have an alternate romanisation at all.
 */
function hasStrongMatch(results, keyword) {
  var q = normalizeTitleForRank(keyword);
  if (!q) return true;
  return results.some(function(r) {
    return normalizeTitleForRank(r.name || "") === q;
  });
}

async function search(keyword) {
  var results = await searchOnce(keyword);

  /**
   * Retry with the other romanisation, but ONLY when the first attempt found
   * nothing that actually answers the query. "haikyuu" returns six Haikyu
   * specials — non-empty, so a length check would not catch it — while the
   * series itself is indexed under the single-u spelling.
   *
   * Gated on a weak result rather than run always: it costs an extra upstream
   * request, and this box fronts nine locations on one nginx worker.
   */
  if (!hasStrongMatch(results, keyword)) {
    var variant = collapseLongVowels(keyword);
    if (variant) {
      try {
        var extra = await searchOnce(variant);
        var seen = {};
        results.forEach(function(r) { seen[r.slug] = 1; });
        extra.forEach(function(r) { if (!seen[r.slug]) { seen[r.slug] = 1; results.push(r); } });
      } catch (err) {
        // A failed variant lookup must not lose the results we already have.
        console.warn("[hianime] variant search failed for \"" + variant + "\": " + err.message);
      }
    }
  }

  return rankResults(results, keyword);
}

async function searchOnce(keyword) {
  var url = config.HIANIME_BASE + "/search?keyword=" + encodeURIComponent(keyword);
  var html = await http.fetchText(url);
  var $ = cheerio.load(repairUnterminatedTags(html));

  // A large document that parses to an empty <body> did not parse. Checked
  // before anything reads the DOM, because every selector below would return
  // empty and look like an ordinary "no results" answer.
  if (html.length > 10000 && $("body").children().length === 0) {
    throw makeStageError(
      "search",
      "PARSE_BROKEN",
      "Document parsed to an empty <body> — upstream markup is malformed beyond repair.",
      { htmlLength: html.length, scriptTags: (html.match(/<script\b/gi) || []).length }
    );
  }

  var results = [];
  $(".flw-item").each(function(_, element) {
    // hianime.dk moved item links from /watch/<slug> to a root-level /<slug>
    // on 2026-08-19 and dropped the a.d-title class. Both forms are accepted so
    // this keeps working if they revert, and the slug shape is unchanged
    // (<name>-<numericId>).
    var link = $(element).find("a.film-poster-ahref, .film-name a, a.d-title").first();
    var href = link.attr("href")
      || $(element).find("a[href*='/watch/']").first().attr("href")
      || $(element).find("a[href^='/']").first().attr("href")
      || "";
    // Hrefs are ABSOLUTE since the redesign (https://hianime.dk/<slug>), so the
    // origin is stripped before matching. A leading-slash-only pattern matches
    // nothing here, and the failure is silent: search returns [] with HTTP 200.
    var hrefPath = href.replace(/^https?:\/\/[^/]+/i, "");
    var slugMatch = hrefPath.match(/^\/watch\/([^/?#]+?)(?:\/ep-\d+)?$/)
      || hrefPath.match(/^\/([^/?#]+?)(?:\/ep-\d+)?$/);
    var title = $(element).find(".film-name a").first().text().trim()
      || $(element).find(".film-name").first().text().trim()
      || $(element).find(".dynamic-name").first().text().trim()
      || $(element).find("a.d-title").first().text().trim();
    var poster = $(element).find(".film-poster-img").first().attr("src") || "";
    if (slugMatch && title) {
      results.push({
        slug: slugMatch[1],
        name: decodeHtml(title),
        poster: poster,
      });
    }
  });
  /**
   * Containers present but nothing parsed = the selectors broke.
   *
   * This is the exact failure that took anime down on 2026-08-19 and went
   * unnoticed for two days: hianime.dk changed its markup, every field came back
   * empty, and /api/search answered HTTP 200 with {"results":[]}. To the app that
   * is indistinguishable from "this keyword has no matches", so nothing anywhere
   * reported a problem.
   *
   * A genuinely empty search returns a page with ZERO .flw-item containers, so
   * the two cases are cleanly separable. Throwing here makes the next redesign
   * surface as a 502 on the very first request instead of an empty screen.
   */
  if (!results.length) {
    var pageTitle = $("title").first().text().trim();
    /**
     * Count containers in the RAW BYTES, not in the parsed DOM.
     *
     * This counted $(".flw-item") until 2026-08-22, which made it blind to the
     * one failure it exists to catch. When the document itself stops parsing,
     * the DOM reports zero containers, `containers > 0` is false — and the
     * title still parses, because <title> sits before the malformed tag, so
     * looksLikeSearchPage stays true as well. Both branches pass and search
     * returns [] exactly as if the keyword had no matches. That is precisely
     * the silent failure this block was written to prevent, reproduced inside
     * the block itself.
     *
     * A check must never be computed from the machinery it is checking. The
     * received bytes are the only thing still trustworthy once parsing has
     * collapsed, so the guard reads those and reports both numbers.
     */
    var containers = (html.match(/class="[^"]*\bflw-item\b/g) || []).length;
    var parsedContainers = $(".flw-item").length;
    // Two distinguishable failures, and neither may return [] quietly:
    //
    //  - containers present but nothing parsed  -> our selectors broke
    //  - we were not served a search page at all -> upstream search is down
    //
    // The second is live right now: hianime.dk answers /search?keyword=... with
    // its generic "Anime List" page, ignoring the keyword. Reproduced from two
    // unrelated networks, so it is their outage rather than an IP block on us.
    // Its own <title> is the cheapest reliable tell, since a real search page is
    // titled for the query. A genuine no-match search DOES return a search page,
    // so this cannot misfire on an obscure keyword.
    var looksLikeSearchPage = /search/i.test(pageTitle);
    if (containers > 0 || !looksLikeSearchPage) {
      throw makeStageError(
        "search",
        "SEARCH_UNUSABLE",
        containers > 0
          ? "Upstream served " + containers + " result cards but " + parsedContainers
            + " parsed — markup changed, or the document failed to parse."
          : "Upstream did not return a search page (title: \"" + pageTitle.slice(0, 60) + "\").",
        {
          containers: containers,
          parsedContainers: parsedContainers,
          pageTitle: pageTitle.slice(0, 80),
          htmlLength: html.length,
        }
      );
    }
  }
  return results;
}

/**
 * Fetch a title's page, accepting either URL shape.
 *
 * Both /watch/<slug> and the root-level /<slug> serve the real page today, for
 * every slug tested. /watch/ is tried first because it is the long-standing
 * form; root-level is the shape the 2026-08-19 redesign moved links to, so it
 * is the more likely survivor if one of them is retired.
 *
 * The fallback matters because of HOW this fails. An unknown slug does not 404
 * — it 301s to /home, redirects are followed, and the HOMEPAGE comes back with
 * HTTP 200. There is no #ani_detail on it, so getInfo yields an empty name and
 * an id guessed from the slug suffix, and the damage lands somewhere else
 * entirely: mal-map matches on the title, so playback silently never reaches
 * megaplay, and the episode-list endpoint selects by Referer, so it is handed
 * /home and answers with zero episodes. Trying both shapes means one retired
 * URL form cannot quietly produce that state.
 */
async function fetchTitlePage(slug) {
  var html = await http.fetchText(config.HIANIME_BASE + "/watch/" + slug);
  if (/id="ani_detail"/.test(html)) return html;

  var rootLevel = await http.fetchText(config.HIANIME_BASE + "/" + slug);
  if (/id="ani_detail"/.test(rootLevel)) return rootLevel;

  // Neither shape produced a title page — almost always a slug that no longer
  // exists. Return the legacy body so the caller's own check reports on it.
  return html;
}

async function getInfo(slug) {
  var html = await fetchTitlePage(slug);
  // The anime id lives on #ani_detail as data-anime-id. Do NOT fall back to the
  // first data-id on the page: since the 2026-08-19 redesign that is the first
  // EPISODE's id, which the episode-list endpoint silently rejects (it answers
  // with the site's HTML shell, so the JSON parse throws rather than 404ing).
  // The slug already ends in the same numeric id, so that is the safer fallback.
  var id = html.match(/id="ani_detail"[^>]*data-anime-id="(\d+)"/)
    || html.match(/data-anime-id="(\d+)"/);
  var slugId = String(slug || "").match(/-(\d+)$/);
  var nameMatch = html.match(/class="[^"]*film-name[^"]*"[^>]*>\s*([^<]+)/)
    || html.match(/class="[^"]*dynamic-name[^"]*"[^>]*>\s*([^<]+)/)
    || html.match(/class="[^"]*d-title[^"]*"[^>]*>\s*([^<]+)/);
  var posterMatch = html.match(/class="film-poster-img"[^>]*src="([^"]+)"/);
  var resolvedId = id ? id[1] : (slugId ? slugId[1] : "");
  if (!resolvedId) {
    throw makeStageError(
      "info",
      "PARSE_BROKEN",
      "Could not resolve an anime id from the watch page — upstream markup changed.",
      { slug: slug, htmlLength: html.length }
    );
  }
  rememberSlug(resolvedId, slug);
  return {
    animeId: resolvedId,
    name: nameMatch ? decodeHtml(nameMatch[1].trim()) : "",
    poster: posterMatch ? posterMatch[1] : "",
  };
}

async function getEpisodes(animeId, slugHint) {
  // Moved from /ajax/episode/list/ on 2026-08-19. The old path still answers
  // HTTP 200 but returns the site's HTML shell, so a wrong URL here surfaces as
  // a JSON parse error rather than a 404 — see the rest_url in the page's
  // hianime_ep_ajax config, which is where this was recovered from.
  // The Referer IS the selector here — see slugByAnimeId above. Refusing
  // outright beats sending the site root, which returns 200 with an empty body
  // and would surface as "this anime has no episodes".
  var referer = watchRefererFor(animeId, slugHint);
  if (!referer) {
    throw makeStageError(
      "episodes",
      "NO_SLUG",
      "Cannot list episodes without the anime's slug (resolve /api/info first).",
      { animeId: animeId }
    );
  }
  var data = await http.fetchJSON(config.HIANIME_BASE + "/api/theme/episode/list/" + animeId, {
    headers: { "X-Requested-With": "XMLHttpRequest", Referer: referer },
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
    // data-ids (plural) became data-id after the redesign. This value is the
    // episodeId the servers endpoint wants.
    var idsMatch = tag.match(/data-ids="([^"]+)"/) || tag.match(/data-id="([^"]+)"/);
    var subMatch = tag.match(/data-sub="(\d+)"/);
    var dubMatch = tag.match(/data-dub="(\d+)"/);
    var titleMatch = tag.match(/title="([^"]*)"/) || tag.match(/data-jp="([^"]*)"/) || tag.match(/<span[^>]*class="name"[^>]*>([^<]*)<\/span>/);

    if (!num) continue;
    // Upstream often supplies a single-character placeholder (literally "A") in
    // both title= and .ep-name. That is their data, not a parse failure, but a
    // list of "A" reads as broken — so anything shorter than two characters
    // falls back to the episode number.
    var rawTitle = titleMatch ? decodeHtml(titleMatch[1].trim()) : "";
    episodes.push({
      number: parseInt(num[1], 10),
      slug: slugMatch ? slugMatch[1] : num[1],
      mal: malMatch ? malMatch[1] : "",
      ids: idsMatch ? idsMatch[1] : "",
      hasSub: subMatch ? subMatch[1] === "1" : true,
      hasDub: dubMatch ? dubMatch[1] === "1" : false,
      title: rawTitle.length > 1 ? rawTitle : "Episode " + num[1],
    });
  }

  return episodes.sort(function(left, right) {
    return left.number - right.number;
  });
}

async function getServersFromList(dataIds, slugHint) {
  // /ajax/server/list is dead (answers 200 with the site's HTML shell). The
  // replacement returns one server-item per source carrying data-type,
  // data-server-name and data-hash — where data-hash is the base64 embed URL.
  // That removes the old second hop through /ajax/server?get=<linkId>:
  // getServerSource() already short-circuits when handed a full URL, so
  // decoding here is all that is needed.
  var url = config.HIANIME_BASE + "/api/theme/episode/servers?episodeId=" + encodeURIComponent(dataIds);
  console.log("[hianime] /api/theme/episode/servers id=" + String(dataIds).substring(0, 40));
  try {
    var data = await http.fetchJSON(url, {
      // Same Referer gating as the episode list; fall back to the site root
      // rather than refusing, since this one is not proven to require it.
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        Referer: watchRefererFor("", slugHint) || config.HIANIME_BASE + "/",
      },
    });
    var html = data.result || data.html || (typeof data === "string" ? data : "");
    if (!html) {
      console.warn("[hianime] server/list: empty HTML");
      return [];
    }

    var servers = [];
    // New shape first: <div class="item server-item" data-type data-server-name
    // data-hash>. data-hash is the base64 embed URL.
    var reNew = /<[a-z]+[^>]*class="[^"]*server-item[^"]*"[^>]*>/gi;
    var m2;
    while ((m2 = reNew.exec(html)) !== null) {
      var tagNew = m2[0];
      var hash = tagNew.match(/data-hash="([^"]+)"/);
      if (!hash) continue;
      var decoded = "";
      try {
        decoded = Buffer.from(hash[1], "base64").toString("utf8");
      } catch (e) {
        decoded = "";
      }
      // Only accept something that is actually a URL. A malformed hash must not
      // become a "server" that fails later in the extractor with a confusing
      // error far from its cause.
      if (!/^https?:\/\//i.test(decoded)) continue;
      var t2 = tagNew.match(/data-type="([^"]*)"/);
      var n2 = tagNew.match(/data-server-name="([^"]*)"/);
      servers.push({
        type: t2 ? t2[1] : "sub",
        linkId: decoded,
        svId: "",
        name: n2 ? n2[1].trim().toLowerCase() : "server",
        source: "list",
      });
    }
    if (servers.length) return servers;

    // Legacy shape, kept so a revert upstream does not need another deploy.
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

  /**
   * megaplay goes to the FRONT of the list, not in place of it.
   *
   * hianime hands out megacloud.help embeds for almost every title, and that
   * host has been serving Cloudflare 1027 zone-wide since 2026-08-22 — dead for
   * everyone, unfixable from our side. megaplay carries the same content but is
   * addressed by MAL id, which mal-map resolves offline from a static index.
   *
   * Prepending rather than replacing is deliberate: if mal-map cannot resolve
   * the title, or megaplay has no file for it (movies and specials, mostly),
   * the loop falls straight through to the original server list and behaves
   * exactly as it did before. A miss can only cost one extra request.
   */
  var mal = malMap.resolveMal(info.name, episodes.length);
  if (mal) {
    tryList = [{
      name: "megaplay",
      type: category,
      source: "megaplay-mal",
      linkId: config.MEGAPLAY_BASE + "/stream/mal/" + mal.mal + "/" + epNum + "/" + category,
    }].concat(tryList);
    console.log("[hianime] mal-map: \"" + info.name + "\" (" + episodes.length + " eps) -> MAL "
      + mal.mal + " via key \"" + mal.matchedKey + "\"");
  } else {
    console.log("[hianime] mal-map: no confident match for \"" + info.name
      + "\" — falling back to hianime's own servers");
  }

  var serverErrors = [];

  for (var index = 0; index < tryList.length; index += 1) {
    var server = tryList[index];
    try {
      console.log("[hianime] Trying: " + server.name + " (" + server.type + ", " + server.source + ")");
      // The megaplay entry is already a player URL. getEmbedFromServer exists to
      // turn a hianime server id into one, and would fail on a URL it did not
      // mint, so it is skipped for this source only.
      var embed = server.source === "megaplay-mal"
        ? { url: server.linkId, skipData: null }
        : await getEmbedFromServer(server.linkId);
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

module.exports = {
  search: search,
  // Exported for the offline regression suite: the 2026-08-22 outage is only
  // testable without the network if the repair step can be exercised directly.
  repairUnterminatedTags: repairUnterminatedTags,
  rankResults: rankResults,
  collapseLongVowels: collapseLongVowels,
  hasStrongMatch: hasStrongMatch,
  getServersFromList: getServersFromList,
  getInfo: getInfo,
  getEpisodes: getEpisodes,
  resolveEmbedForEpisode: resolveEmbedForEpisode,
  __getServersFromList: getServersFromList,
};
