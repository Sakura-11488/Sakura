import Constants from 'expo-constants';
import type { ChatMediaKind } from './chat-media';

export interface GiphyItem {
  id: string;
  title: string;
  kind: ChatMediaKind;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

function resolveApiKey(): string {
  return (
    process.env.EXPO_PUBLIC_GIPHY_API_KEY?.trim() ||
    (Constants.expoConfig?.extra as { giphyApiKey?: string } | undefined)?.giphyApiKey?.trim() ||
    ''
  );
}

function mapGiphyItem(
  raw: {
    id: string;
    title?: string;
    images?: Record<string, { url?: string; width?: string; height?: string }>;
  },
  kind: ChatMediaKind,
): GiphyItem | null {
  const images = raw.images ?? {};
  const main =
    images.fixed_width ||
    images.downsized ||
    images.fixed_height ||
    images.original;
  const preview = images.fixed_width_small || images.preview_gif || main;
  if (!main?.url) return null;

  return {
    id: raw.id,
    title: raw.title?.trim() || (kind === 'sticker' ? 'Sticker' : 'GIF'),
    kind,
    url: main.url,
    previewUrl: preview?.url || main.url,
    width: Number(main.width ?? 200),
    height: Number(main.height ?? 200),
  };
}

export function isGiphyConfigured(): boolean {
  return resolveApiKey().length > 0;
}

export async function fetchGiphyItems(
  kind: ChatMediaKind,
  query?: string,
  limit = 24,
): Promise<GiphyItem[]> {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'Add EXPO_PUBLIC_GIPHY_API_KEY to ios/.xcode.env.local (free key at developers.giphy.com).',
    );
  }

  const endpoint = kind === 'gif' ? 'gifs' : 'stickers';
  const trimmed = query?.trim();
  const url = trimmed
    ? `https://api.giphy.com/v1/${endpoint}/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(trimmed)}&limit=${limit}&rating=pg-13&lang=en`
    : `https://api.giphy.com/v1/${endpoint}/trending?api_key=${encodeURIComponent(apiKey)}&limit=${limit}&rating=pg-13`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Giphy request failed (${res.status})`);
  }

  const json = (await res.json()) as {
    data?: Array<{
      id: string;
      title?: string;
      images?: Record<string, { url?: string; width?: string; height?: string }>;
    }>;
  };

  return (json.data ?? [])
    .map((item) => mapGiphyItem(item, kind))
    .filter((item): item is GiphyItem => item != null);
}
