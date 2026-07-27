import { Platform } from 'react-native';

export const MAX_CONTENT_WIDTH = 720;
export const MAX_CAROUSEL_CARD_WIDTH = 220;
export const MAX_WALLET_MODAL_WIDTH = 420;
export const MAX_TAB_BAR_WIDTH = 480;
export const MAX_HERO_HEIGHT_WEB = 360;
/**
 * Hero height for the anime home on desktop.
 *
 * The shared 360px cap suits a card-sized banner, but on a 1080p screen it left
 * the anime home looking like a phone layout with a letterbox at the top. A
 * streaming home page earns its hero: this is tall enough to be cinematic while
 * still leaving the first row of cards visible above the fold, which is what
 * makes the page feel browsable rather than like a single advert.
 */
export const MAX_ANIME_HOME_HERO_HEIGHT_WEB = 520;

// ─── Desktop web layout ─────────────────────────────────────────────────────
// At/above this window width the web app switches from the phone-style centered
// column + floating bottom bar to a left sidebar + wide content area. Below it
// (mobile web) the original layout is preserved untouched.
export const DESKTOP_BREAKPOINT = 1000;
export const SIDEBAR_WIDTH = 232;
/** Height of the desktop-web top navigation bar. */
export const TOP_NAV_HEIGHT = 64;
// 1180 left ~250px of dead gutter on each side at 1920x1080 (the content column
// is centered in the space beside the sidebar), which read as a broken layout.
// 1440 keeps line lengths sane while making the margins look like intentional
// page padding. Components size off contentWidth(), so this cascades.
export const MAX_CONTENT_WIDTH_DESKTOP = 1440;

/** True when running on web at a desktop-class window width. */
export function isWideWeb(windowWidth: number): boolean {
  return Platform.OS === 'web' && windowWidth >= DESKTOP_BREAKPOINT;
}

/**
 * Width of the actual content area for a given window width. On desktop web
 * this subtracts the sidebar and caps at the desktop max; otherwise it caps at
 * the phone-column max. Components (e.g. FeaturedCarousel) size themselves off
 * this so widening the shell cascades automatically.
 */
export function contentWidth(windowWidth: number): number {
  if (isWideWeb(windowWidth)) {
    // No sidebar subtraction any more: navigation moved to a top bar, so the
    // full window width is available to content. The old rail cost 232px of
    // every viewport permanently.
    return Math.min(windowWidth, MAX_CONTENT_WIDTH_DESKTOP);
  }
  return Math.min(windowWidth, MAX_CONTENT_WIDTH);
}

export function isWebDesktop(): boolean {
  return Platform.OS === 'web';
}
