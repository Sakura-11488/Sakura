/**
 * Transak on-ramp URL for buying SOL with card.
 * Set EXPO_PUBLIC_TRANSAK_API_KEY when you have a partner key (recommended).
 */
export function buildTransakBuySolUrl(walletAddress: string): string {
  const apiKey = process.env.EXPO_PUBLIC_TRANSAK_API_KEY?.trim();
  const params = new URLSearchParams({
    productsAvailed: 'BUY',
    cryptoCurrencyCode: 'SOL',
    network: 'solana',
    walletAddress,
    disableWalletAddressForm: 'true',
    hideMenu: 'true',
    redirectURL: 'https://sakura.app',
  });

  if (apiKey) {
    params.set('apiKey', apiKey);
    params.set('referrerDomain', 'sakura.app');
  }

  return `https://global.transak.com/?${params.toString()}`;
}

export async function openTransakBuySol(
  walletAddress: string,
  openBrowser: (url: string) => Promise<unknown>,
): Promise<void> {
  const url = buildTransakBuySolUrl(walletAddress);
  await openBrowser(url);
}
