module.exports = {
  HIANIME_BASE: process.env.HIANIME_BASE || "https://hianime.dk",
  /**
   * megaplay is now the PRIMARY embed host. On 2026-08-22 megacloud.help began
   * serving Cloudflare error 1027 ("the owner has reached their plan limits") —
   * a zone-level quota served identically to every visitor, verified from three
   * networks on two continents. No proxy or header change gets past it.
   *
   * megaplay is addressed by MAL id rather than by a hianime episode id, which
   * is what scrapers/mal-map.js exists to supply.
   */
  MEGAPLAY_BASE: process.env.MEGAPLAY_BASE || "https://megaplay.buzz",

  /**
   * Kept only as a fallback for titles mal-map cannot resolve.
   *
   * All three of these were probed on 2026-08-22 and are DEAD — .club and .blog
   * time out entirely, .tv no longer serves. The host actually in use,
   * megacloud.help, was never in this list at all, so this config has been
   * decorative for some time. Left in place rather than deleted because the
   * extractor still recognises the shape, and an empty list would change
   * behaviour for a path that is already only a fallback.
   */
  MEGACLOUD_BASES: [
    "https://megacloud.tv",
    "https://megacloud.club",
    "https://megacloud.blog",
  ],
  USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  PREFERRED_SERVERS: ["megacloud", "vidcloud", "vidstreaming", "streamsb"],
  PORT: parseInt(process.env.PORT, 10) || 3000,
  REQUEST_TIMEOUT_MS: 15000,
  BROWSER_VERSION: 1676800512,
  WASM_IMAGE_VERSION: "0.0.9",
};
