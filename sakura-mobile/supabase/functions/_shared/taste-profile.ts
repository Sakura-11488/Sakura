import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import type { TasteSnapshot } from './mappa-style.ts';

type FavoriteRow = { title?: string | null; content_type?: string | null; manga_id?: string | null };
type LibraryItem = { title?: string; type?: string };
type WatchItem = { title?: string; animeId?: string };

function uniqueStrings(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = value.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function inferGenres(titles: string[]): string[] {
  const blob = titles.join(' ').toLowerCase();
  const genres: string[] = [];
  if (/psyop|degegen|meme|satire|crypto/.test(blob)) genres.push('satire', 'supernatural');
  if (/jujutsu|demon|slayer|chainsaw|action|fight/.test(blob)) genres.push('action', 'supernatural');
  if (/romance|love|girl/.test(blob)) genres.push('romance');
  if (/horror|thriller|psychological/.test(blob)) genres.push('psychological');
  if (/isekai|fantasy|magic/.test(blob)) genres.push('fantasy');
  if (!genres.length) genres.push('action', 'supernatural', 'drama');
  return uniqueStrings(genres, 4);
}

function inferVibe(titles: string[], mix: string[]): string {
  const blob = titles.join(' ').toLowerCase();
  if (/psyop|degegen|meme/.test(blob)) return 'chaotic meme-energy shonen with cursed technique vibes';
  if (/novel|manga/.test(mix.join(' '))) return 'well-read otaku with calm intensity';
  if (/anime/.test(mix.join(' '))) return 'battle-hardened viewer with cinematic flair';
  return 'mysterious sorcerer-student energy';
}

export async function buildTasteSnapshot(
  supabase: SupabaseClient,
  walletAddress: string,
): Promise<TasteSnapshot> {
  const [favoritesRes, libraryRes, animeRes] = await Promise.all([
    supabase
      .from('favorites')
      .select('title, content_type, manga_id')
      .eq('wallet_address', walletAddress)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('user_library').select('data').eq('wallet_address', walletAddress).maybeSingle(),
    supabase.from('anime_history').select('data').eq('wallet_address', walletAddress).maybeSingle(),
  ]);

  const titles: string[] = [];
  const mix = new Set<string>();

  for (const row of (favoritesRes.data ?? []) as FavoriteRow[]) {
    if (row.title) titles.push(row.title);
    const type = row.content_type ?? 'manga';
    mix.add(type);
  }

  const library = Array.isArray(libraryRes.data?.data) ? (libraryRes.data.data as LibraryItem[]) : [];
  for (const item of library.slice(0, 15)) {
    if (item.title) titles.push(item.title);
    if (item.type) mix.add(item.type);
  }

  const watch = Array.isArray(animeRes.data?.data) ? (animeRes.data.data as WatchItem[]) : [];
  for (const item of watch.slice(0, 15)) {
    if (item.title) titles.push(item.title);
    mix.add('anime');
  }

  const topTitles = uniqueStrings(titles, 8);
  const contentMix = [...mix];
  return {
    top_titles: topTitles,
    top_genres: inferGenres(topTitles),
    content_mix: contentMix,
    vibe: inferVibe(topTitles, contentMix),
  };
}
