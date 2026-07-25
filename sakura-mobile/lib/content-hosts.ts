/**
 * Canonical DigitalOcean droplet host config — SINGLE SOURCE OF TRUTH for
 * the media/scraper server addresses (comics proxy, Consumet, PsyopAnime,
 * Sakura Originals media).
 *
 * Dependency-free so it can be imported by sakura-mobile, the Expo Web
 * build (symlinked lib/), and legacy `src/` across trees.
 *
 * If the droplet IP ever changes, update it here AND in the places that
 * cannot import this module:
 *  - sakura-mobile/app.json (ATS / cleartext exceptions)
 *  - sakura-mobile/ios/Sakura/Info.plist
 *  - sakura-mobile/android/.../network_security_config.xml
 *  - supabase/functions/web-media-proxy + web-content-proxy (or set their
 *    SAKURA_MEDIA_BASE / COMICS_PROXY_BASE / HENTAI_PROXY_BASE /
 *    MANHWA_PROXY_BASE / CONSUMET_BASE secrets)
 *  - scripts/psyop-*.mjs (or set PSYOP_REMOTE)
 *  - the sakura-web repo's api/media-proxy.js path allowlist (separate repo,
 *    separate deploy — web images 400 without an entry there)
 */

export const DROPLET_IP = '165.232.83.159';
/** nip.io alias of DROPLET_IP — used for iOS ATS-compliant hostnames. */
export const DROPLET_NIP_HOST = '165-232-83-159.nip.io';

/** True if a hostname points at the Sakura droplet (either form). */
export function isDropletHost(hostname: string): boolean {
  return hostname === DROPLET_IP || hostname === DROPLET_NIP_HOST;
}

// Service base URLs (plain HTTP; web builds route via HTTPS proxies).
export const MEDIA_BASE_DEFAULT = `http://${DROPLET_NIP_HOST}`;
export const COMICS_PROXY_DEFAULT = `http://${DROPLET_IP}/comics/v1`;
export const HENTAI_PROXY_DEFAULT = `http://${DROPLET_IP}/hentai/v1`;
export const MANHWA_PROXY_DEFAULT = `http://${DROPLET_IP}/manhwa/v1`;
export const CONSUMET_URL_DEFAULT = `http://${DROPLET_NIP_HOST}:3000`;
export const CONSUMET_URL_LEGACY = `http://${DROPLET_IP}:3000`;
