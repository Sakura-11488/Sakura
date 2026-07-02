import { isSolanaMainnet } from './config';

const TRANSAK_ENV = isSolanaMainnet() ? 'PRODUCTION' : 'STAGING';
const TRANSAK_BASE =
  TRANSAK_ENV === 'PRODUCTION'
    ? 'https://global.transak.com'
    : 'https://global-stg.transak.com';

export function isTransakConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_TRANSAK_API_KEY?.trim());
}

function getRedirectUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/app/`;
  }
  return 'https://sakuraonseeker.com/app/';
}

/**
 * Transak on-ramp URL for buying SOL with card.
 * Requires EXPO_PUBLIC_TRANSAK_API_KEY (get from https://dashboard.transak.com).
 */
export function buildTransakBuySolUrl(walletAddress: string): string {
  const apiKey = process.env.EXPO_PUBLIC_TRANSAK_API_KEY?.trim() ?? '';

  const params = new URLSearchParams({
    productsAvailed: 'BUY',
    cryptoCurrencyCode: 'SOL',
    network: 'solana',
    walletAddress,
    disableWalletAddressForm: 'true',
    hideMenu: 'true',
    redirectURL: getRedirectUrl(),
    defaultPaymentMethod: 'credit_debit_card',
    themeColor: 'ff6b9d',
    exchangeScreenTitle: 'Buy SOL for Sakura',
  });

  if (apiKey) {
    params.set('apiKey', apiKey);
    params.set('environment', TRANSAK_ENV);
    params.set('referrerDomain', typeof window !== 'undefined' ? window.location.hostname : 'sakuraonseeker.com');
  }

  return `${TRANSAK_BASE}?${params.toString()}`;
}

export function isTransakOrderSuccessEvent(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const eventId = (data as { event_id?: string }).event_id;
  return eventId === 'TRANSAK_ORDER_SUCCESSFUL' || eventId === 'TRANSAK_ORDER_COMPLETED';
}

export async function openTransakBuySol(
  walletAddress: string,
  openBrowser: (url: string) => Promise<unknown>,
): Promise<void> {
  const url = buildTransakBuySolUrl(walletAddress);
  await openBrowser(url);
}
