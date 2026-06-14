export function buildAvatarMetadata(input: {
  name: string;
  symbol: string;
  description: string;
  imageUrl: string;
  walletAddress: string;
  mode: string;
  vibe?: string;
  topGenres?: string[];
}) {
  const imageWithExt = input.imageUrl.includes('?') ? input.imageUrl : `${input.imageUrl}?ext=png`;

  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: imageWithExt,
    external_url: 'https://sakura.app',
    seller_fee_basis_points: 0,
    attributes: [
      { trait_type: 'Mode', value: input.mode },
      { trait_type: 'Vibe', value: input.vibe ?? 'Sakura reader' },
      { trait_type: 'Wallet', value: input.walletAddress },
      ...(input.topGenres?.length
        ? [{ trait_type: 'Top Genres', value: input.topGenres.slice(0, 3).join(', ') }]
        : []),
    ],
    properties: {
      category: 'image',
      files: [{ uri: imageWithExt, type: 'image/png' }],
      creators: [{ address: input.walletAddress, share: 100 }],
    },
  };
}
