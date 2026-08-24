/**
 * Regression tests for the Comic Book Plus parsers.
 *
 * Every fixture below is trimmed from real markup captured 2026-08-24, and
 * every assertion exists because the naive reading of that markup is wrong in a
 * way that produced a blank screen, a 404 or a 403 during the build. Pure
 * parsers only — this suite makes no network calls.
 *
 *     node cbp.spec.mjs
 */
import {
    parseCatalog,
    parseSeries,
    parseIssue,
    parseViewerBase,
    buildPageUrls,
    fixThumbUrl,
    cbpSoft404,
    isCbpId,
    cbpNumeric,
    toCbpId,
} from "./comicbookplus.js";

let pass = 0, fail = 0;
const ok = (cond, name, detail = "") => {
    if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
    else { fail += 1; console.log(`  FAIL  ${name} ${detail}`); }
};
const eq = (actual, expected, name) =>
    ok(actual === expected, name, `\n          expected ${JSON.stringify(expected)}\n          actual   ${JSON.stringify(actual)}`);

// --- fixtures ---------------------------------------------------------------

// A publisher block from ?cid=1507. Note the two shapes of cid link: the
// publisher's own (bare name, in the "Publisher:" and "Available Online:" rows)
// and its titles (name + "(count)"). Treating both as titles is the bug this
// fixture pins: it would put "Ace Magazines" in the catalogue as a comic.
const CATALOG = `<div class="mainbody"><div class="mainh1"><h1 class="sectionh1">Comic Books</h1></div>
<h2 class="cathead" id="seq0">Ace Magazines</h2>
<table class="f" itemscope itemtype="https://schema.org/Organization"><tr>
<td class="g"><a href="/?cid=806"><img src="https://box01.comicbookplus.com/thumbs/ace/LargeAce.png" class="thumb" alt="Thumbnail for Ace Magazines" width="175" height="245"></a></td>
<td><table class="f">
<tr><td class="d">Publisher:</td><td class="e"><span itemprop="name"><a href="/?cid=806">Ace Magazines</a></span></td></tr>
<tr><td class="d">Available Online:</td><td class="e">Titles: 43 | Books: <a href="/?cid=806">719</a></td></tr>
<tr><td class="d">Latest Book:</td><td class="e"><a href='/?dlid=102097'>Crime Must Pay the Penalty 42</a> | Uploaded: Jun 3, 2026</td></tr>
<tr><td class="d">Titles:</td><td class="e"><a href="/?cid=3245">All Love (7)</a> | <a href="/?cid=858">All Romances (5)</a> | <a href="/?cid=860">Atomic War! (4)</a></td></tr>
</table></td></tr></table></div>`;

// Two rows from ?cid=1325. The thumbnailUrl deliberately keeps the site's own
// broken form (no fan-out directory) — fixing it is the parser's job.
const SERIES = `<html><body><div class="mainbody"><div class="mainh1"><h1>Register and Tribune Syndicate: The Spirit</h1></div>
<img src="https://box01.comicbookplus.com/thumbs/quality/TheSpiritSection.png" class="thumb" alt="x">
<table>
<tr class="overrow" onclick="mp('82675')" itemscope itemtype="https://schema.org/Book">
  <td class="n"><meta itemprop="thumbnailUrl" content="https://box01.comicbookplus.com/viewer/87bacc5561521bced87d93d3b5dbc854/mediumthumb.jpg">
  <a href="/?dlid=82675"><img src="x.png" alt="The Spirit 1941-02-16"></a></td>
  <td class="n"><a href="/?dlid=82675" itemprop="url"><span itemprop="name">The Spirit 1941-02-16 - Minneapolis Star Journal</span></a></td>
  <td class="r"><time class="nofloat" itemprop="datePublished" datetime="1941-02-16">Feb 16, 1941</time></td>
  <td class="r" itemprop="numberOfPages">16</td></tr>
<tr class="overrow" onclick="mp('76231')" itemscope itemtype="https://schema.org/Book">
  <td class="n"><meta itemprop="thumbnailUrl" content="https://box01.comicbookplus.com/viewer/a424f8e284b56b903568f2caabcefd34/mediumthumb.jpg"></td>
  <td class="n"><a href="/?dlid=76231" itemprop="url"><span itemprop="name">The Spirit 1942-02-22 - Philadelphia Record</span></a></td>
  <td class="r"><time itemprop="datePublished" datetime="1942-02-22">Feb 22, 1942</time></td>
  <td class="r" itemprop="numberOfPages">17</td></tr>
</table></div></body></html>`;

// An issue whose images live on box01 (most of them do). The main-domain form
// exists too, which is exactly why the base must be read, not rebuilt.
const ISSUE_BOX01 = `<html><head><title>The Spirit 1945-06-24 - Chicago Sun - Comic Book Plus</title></head>
<body><div class="mainh1"><h1>The Spirit 1945-06-24 - Chicago Sun</h1></div>
<img src="https://box01.comicbookplus.com/viewer/11/111794331f1ae10fa57b4d22a62a5a9d/largethumb.jpg">
<img id="mainpage" src="https://box01.comicbookplus.com/viewer/11/111794331f1ae10fa57b4d22a62a5a9d/0.jpg">
<div>17 pages</div></body></html>`;

const ISSUE_MAIN = `<html><head><title>The Spirit 1951-04-08 (Star Ledger) - Comic Book Plus</title></head>
<body><h1>The Spirit 1951-04-08 (Star Ledger)</h1>
<img src="https://comicbookplus.com/viewer/f5/f5072fc13058e6b26cfb75307aad7325/0.jpg">
<span itemprop="numberOfPages">8</span></body></html>`;

// What the site returns for a bad id, or for `&limit=` past the end. It is 105
// KB of ordinary chrome, so "did it parse to zero rows" cannot distinguish it
// from a real but empty series.
const SOFT_404 = `<html><head><title> We Could Not Find It  - Comic Book Plus</title></head>
<body><div class="mainh1"><h1>Something Is Not Quite Right</h1></div>
<p>Sorry, we could not find that page.</p></body></html>`;

// --- ids --------------------------------------------------------------------

console.log("\nids");
ok(isCbpId("cbp-1325"), "namespaced id is recognised");
ok(!isCbpId("invincible"), "an XOXO slug is not a Comic Book Plus id");
ok(!isCbpId("cbp-"), "the prefix alone is not an id");
ok(!isCbpId("cbp-12a"), "a non-numeric tail is not an id");
eq(cbpNumeric("cbp-1325"), "1325", "numeric id round-trips");
eq(cbpNumeric("invincible"), null, "an XOXO slug yields no numeric id");
eq(toCbpId(1325), "cbp-1325", "id is built with the prefix");

// --- soft-404 ---------------------------------------------------------------

console.log("\nsoft-404 detection");
ok(cbpSoft404(SOFT_404), "the styled 404 page is detected");
ok(!cbpSoft404(SERIES), "a real series page is not a soft-404");
ok(cbpSoft404(""), "empty body counts as unusable");
eq(parseSeries(SOFT_404), null, "a soft-404 never parses as an empty series");
eq(parseIssue(SOFT_404), null, "a soft-404 never parses as an empty issue");
eq(parseCatalog(SOFT_404).length, 0, "a soft-404 never parses as a catalogue");

// --- catalogue --------------------------------------------------------------

console.log("\ncatalogue");
const cat = parseCatalog(CATALOG);
eq(cat.length, 3, "only the three TITLES are indexed");
ok(!cat.some((c) => c.title === "Ace Magazines"), "the publisher is not indexed as a comic");
ok(!cat.some((c) => c.id === "cbp-806"), "the publisher's own cid is excluded");
eq(cat[0].id, "cbp-3245", "title id is namespaced");
eq(cat[0].title, "All Love", "the trailing count is stripped from the title");
eq(cat[0].issueCount, 7, "the trailing count becomes the issue count");
eq(cat[0].publisher, "Ace Magazines", "the publisher heading is carried onto its titles");
eq(cat[0].cover, "https://box01.comicbookplus.com/thumbs/ace/LargeAce.png", "publisher art is the placeholder cover");

// --- series -----------------------------------------------------------------

console.log("\nseries");
const series = parseSeries(SERIES);
eq(series.title, "Register and Tribune Syndicate: The Spirit", "series title from h1");
eq(series.cover, "https://box01.comicbookplus.com/thumbs/quality/TheSpiritSection.png", "series cover from the in-page thumb");
eq(series.issues.length, 2, "both issue rows parsed");
eq(series.issues[0].id, "cbp-82675", "issue id comes from the row's mp() handler");
eq(series.issues[0].title, "The Spirit 1941-02-16 - Minneapolis Star Journal", "issue title from itemprop=name");
eq(series.issues[0].pages, 16, "page count from itemprop=numberOfPages");
eq(series.issues[0].publishAt, "1941-02-16", "publish date from the datetime attribute");
eq(series.issues[1].pages, 17, "second row is not confused with the first");

console.log("\nthumbnail fan-out");
eq(
    series.issues[0].thumb,
    "https://box01.comicbookplus.com/viewer/87/87bacc5561521bced87d93d3b5dbc854/mediumthumb.jpg",
    "the missing fan-out directory is inserted",
);
eq(
    fixThumbUrl("https://box01.comicbookplus.com/viewer/a424f8e284b56b903568f2caabcefd34/mediumthumb.jpg"),
    "https://box01.comicbookplus.com/viewer/a4/a424f8e284b56b903568f2caabcefd34/mediumthumb.jpg",
    "fan-out is the first two characters of the hash",
);
ok(
    fixThumbUrl("https://comicbookplus.com/viewer/a424f8e284b56b903568f2caabcefd34/mediumthumb.jpg")
        .startsWith("https://box01."),
    "thumbs are pinned to box01, which is the only host that serves them",
);
eq(fixThumbUrl(null), null, "a missing thumb stays missing");

// --- issue ------------------------------------------------------------------

console.log("\nissue");
const box01 = parseIssue(ISSUE_BOX01);
eq(box01.viewerBase, "https://box01.comicbookplus.com/viewer/11/111794331f1ae10fa57b4d22a62a5a9d", "box01 viewer base is taken verbatim");
eq(box01.pageCount, 17, "page count falls back to the '17 pages' text");
const main = parseIssue(ISSUE_MAIN);
eq(main.viewerBase, "https://comicbookplus.com/viewer/f5/f5072fc13058e6b26cfb75307aad7325", "main-domain viewer base is taken verbatim");
eq(main.pageCount, 8, "page count prefers itemprop=numberOfPages");
eq(main.title, "The Spirit 1951-04-08 (Star Ledger)", "issue title drops the site suffix");
ok(
    parseViewerBase(ISSUE_BOX01).startsWith("https://box01."),
    "the base keeps the host the page used — rebuilding it against the main domain 404s",
);
eq(parseIssue("<html><body>no viewer here</body></html>"), null, "no viewer base means no pages, not an empty reader");

// --- page urls --------------------------------------------------------------

console.log("\npage urls");
const urls = buildPageUrls("https://box01.comicbookplus.com/viewer/11/abc", 3);
eq(urls.length, 3, "one url per page");
eq(urls[0], "https://box01.comicbookplus.com/viewer/11/abc/0.jpg", "pages are zero-indexed");
eq(urls[2], "https://box01.comicbookplus.com/viewer/11/abc/2.jpg", "the last index is count-1 — index `count` is a 404");
eq(buildPageUrls("https://x/y", 0).length, 0, "a zero page count yields no urls");
eq(buildPageUrls("https://x/y", -5).length, 0, "a negative count cannot produce urls");
eq(buildPageUrls("https://x/y", 99999).length, 2000, "an absurd count is capped");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
