/**
 * Metro asset plugin (metro.config.js transformer.assetPlugins): publish
 * exported assets under paths that contain no `node_modules` segment.
 *
 * Why: Vercel does not serve any path containing node_modules, and Expo's
 * export puts package assets exactly there: /app/assets/node_modules/... for
 * packages in web/node_modules, /app/assets/_sakura-mobile/node_modules/...
 * for those in sakura-mobile/node_modules. The live site 404ed on all four
 * Nunito weights and every icon font this way, on every page load, and so did
 * a third of the service worker's precache list.
 *
 * normalize-export-assets.mjs used to rename the folder after the export and
 * patch the bundle text. That cannot work once the bundle is split into
 * chunks: Expo names each chunk after a hash of its contents and of the
 * chunks it can load, so editing one after the fact leaves stale names behind
 * it. Renaming here, where Metro first records each asset's URL, changes the
 * URL the code references and the place the file is written in one step, and
 * every chunk hash already accounts for it.
 *
 * Every `node_modules` segment becomes `vendor`, which keeps the URLs
 * normalize-export-assets.mjs used to produce (/app/assets/vendor/...), so
 * files that browsers and the service worker already cached stay valid.
 *
 * Only export paths are rewritten (`?export_path=`). The dev server serves
 * assets from their real location through `?unstable_path=`, which must stay
 * exactly as Metro wrote it.
 */
const EXPORT_PATH = /^(.*[?&]export_path=)(.*)$/;

function publicAssetLocation(httpServerLocation) {
  const m = EXPORT_PATH.exec(httpServerLocation);
  if (!m) return httpServerLocation;
  return m[1] + m[2].replace(/(^|\/)node_modules(?=\/|$)/g, '$1vendor');
}

module.exports = function publicAssetPaths(asset) {
  const httpServerLocation = publicAssetLocation(asset.httpServerLocation);
  return httpServerLocation === asset.httpServerLocation ? asset : { ...asset, httpServerLocation };
};
module.exports.publicAssetLocation = publicAssetLocation;
