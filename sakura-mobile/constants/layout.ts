import { Platform } from 'react-native';

export const MAX_CONTENT_WIDTH = 720;
export const MAX_CAROUSEL_CARD_WIDTH = 220;
export const MAX_WALLET_MODAL_WIDTH = 420;
export const MAX_TAB_BAR_WIDTH = 480;
export const MAX_HERO_HEIGHT_WEB = 360;

// ─── Desktop web layout ─────────────────────────────────────────────────────
// At/above this window width the web app switches from the phone-style centered
// column + floating bottom bar to a left sidebar + wide content area. Below it
// (mobile web) the original layout is preserved untouched.
export const DESKTOP_BREAKPOINT = 1000;
export const SIDEBAR_WIDTH = 232;
export const MAX_CONTENT_WIDTH_DESKTOP = 1180;

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
    return Math.min(windowWidth - SIDEBAR_WIDTH, MAX_CONTENT_WIDTH_DESKTOP);
  }
  return Math.min(windowWidth, MAX_CONTENT_WIDTH);
}

export function isWebDesktop(): boolean {
  return Platform.OS === 'web';
}
