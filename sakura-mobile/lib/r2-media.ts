import { DROPLET_IP, DROPLET_NIP_HOST } from './content-hosts';

/**
 * Optional Cloudflare R2 origin for Sakura Originals video.
 *
 * The droplet is a 1GB box with a single nginx worker fronting nine locations,
 * and on web every byte is metered twice by Vercel — once as Fast Origin
 * Transfer on the way into the CDN and once as Fast Data Transfer on the way
 * out. R2 removes both: egress to the internet is free, and the browser fetches
 * the object directly with native CORS and Range support, so the media proxy is
 * bypassed entirely for these paths. That also removes Vercel's 10MB
 * cacheable-response ceiling and its function duration limit, which are what
 * force the offline downloader to chunk large episodes.
 *
 * DELIBERATELY OPT-IN. With EXPO_PUBLIC_R2_MEDIA_BASE unset this module is a
 * no-op and every URL keeps its current shape byte for byte, so shipping it is
 * risk-free and enabling or rolling back is an env change plus a rebuild —
 * no code edit, no migration of the client.
 *
 * This file must never gain a `.web.ts` sibling. `lib/consumet-config.ts`
 * documents what happens when a platform file imports its own base name: on
 * web it resolves to itself, and every call recurses until the stack blows —
 * silently, because the callers catch and return empty.
 */

/** Set to e.g. https://media.sakuraonseeker.com or the r2.dev bucket URL. */
const R2_BASE = (process.env.EXPO_PUBLIC_R2_MEDIA_BASE || '').replace(/\/+$/, '');

/**
 * Path prefixes that were migrated. A path outside this list keeps going to the
 * droplet even when R2 is on, so the cutover can be done one show at a time and
 * anything still only on the droplet cannot 404 into a black player.
 */
const MIGRATED_PREFIXES = ['/psyopanime/', '/2heanime/', '/sakura-originals/'];

export function isR2Enabled(): boolean {
  return R2_BASE.length > 0;
}

function dropletPathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== DROPLET_IP && host !== DROPLET_NIP_HOST) return null;
    return parsed.pathname + parsed.search;
  } catch {
    return null;
  }
}

/**
 * Rewrite a droplet media URL to R2, or return null when it should not move.
 *
 * Returns null — rather than the original — so callers can tell "R2 handled it"
 * from "leave this alone", and fall through to the existing proxy path without
 * having to re-derive why.
 */
export function r2UrlFor(url: string | null | undefined): string | null {
  if (!url || !R2_BASE) return null;
  const path = dropletPathOf(url);
  if (!path) return null;
  if (!MIGRATED_PREFIXES.some((p) => path.startsWith(p))) return null;
  // The object key mirrors the droplet path exactly, so the migration is a
  // straight copy and a URL can be compared against its origin by eye.
  return `${R2_BASE}${path}`;
}
