import { Platform } from 'react-native';

export const MAX_CONTENT_WIDTH = 720;
export const MAX_CAROUSEL_CARD_WIDTH = 220;
export const MAX_WALLET_MODAL_WIDTH = 420;
export const MAX_TAB_BAR_WIDTH = 480;
export const MAX_HERO_HEIGHT_WEB = 360;

export function contentWidth(windowWidth: number): number {
  return Math.min(windowWidth, MAX_CONTENT_WIDTH);
}

export function isWebDesktop(): boolean {
  return Platform.OS === 'web';
}
