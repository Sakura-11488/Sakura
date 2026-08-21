module.exports = {
  HIANIME_BASE: process.env.HIANIME_BASE || "https://hianime.dk",
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
