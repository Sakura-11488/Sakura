/// <reference lib="deno.ns" />
import { createAnimeStreamHandler } from './handler.ts';
import { resolveEpisode } from './provider.ts';

// A dedicated capability secret is required; never reuse a JWT or service-role key.
Deno.serve(createAnimeStreamHandler({
  signingSecret: Deno.env.get('ANIME_STREAM_SIGNING_SECRET'),
  publicBaseUrl: `${(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '')}/functions/v1/anime-stream`,
  resolveEpisode,
  // Comma-separated media host families, e.g. "shadowharbor.space,newcdn.site".
  // Lets a provider CDN rotation be followed with `supabase secrets set` alone.
  allowedMediaHosts: (Deno.env.get('ANIME_STREAM_MEDIA_HOSTS') ?? '').split(',').map(host => host.trim()).filter(Boolean),
}));
