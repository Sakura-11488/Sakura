import * as FileSystem from 'expo-file-system/legacy';
import { supabase } from './supabase';
import type { WalletAuthHeaders } from './wallet-auth';

export type CreatorWorkKind = 'novel' | 'manga' | 'anime';
export type ReleaseContentType = 'novel_chapter' | 'manga_chapter' | 'anime_episode';

export interface SakuraUsername {
  wallet_address: string;
  username: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatorUserProfile {
  wallet_address: string;
  display_name: string | null;
  bio: string | null;
  avatar_seed: string;
  avatar_url?: string | null;
  creator_verification_state?: string | null;
  creator_verified_at?: string | null;
  follower_count?: number | null;
  following_count?: number | null;
  revenue_enabled_at?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreatorProfile {
  username: SakuraUsername | null;
  profile: CreatorUserProfile | null;
}

export interface CreatorWork {
  id: string;
  creator_wallet: string;
  kind: CreatorWorkKind;
  title: string;
  slug: string | null;
  description: string;
  genres: string[];
  language: string;
  series_status: string;
  publication_status: string;
  visibility: string;
  minting_enabled: boolean;
  published_at: string | null;
  release_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreatorRelease {
  id: string;
  work_id: string;
  sequence_number: number;
  title: string;
  summary: string;
  content_type: string;
  publication_status: string;
  visibility: string;
  body_text: string;
  published_at: string | null;
  created_at: string;
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function validateUsername(username: string): string | null {
  const trimmed = username.trim();
  if (!USERNAME_RE.test(trimmed)) {
    return 'Use 3–20 letters, numbers, or underscores.';
  }
  return null;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 36);
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${base || 'work'}-${suffix}`;
}

function avatarSeed(walletAddress: string): string {
  return walletAddress.slice(0, 8);
}

export async function getCreatorProfile(walletAddress: string): Promise<CreatorProfile> {
  const [usernameRes, profileRes] = await Promise.all([
    supabase.from('sakura_usernames').select('*').eq('wallet_address', walletAddress).maybeSingle(),
    supabase.from('user_profiles').select('*').eq('wallet_address', walletAddress).maybeSingle(),
  ]);

  if (usernameRes.error) throw usernameRes.error;
  if (profileRes.error) throw profileRes.error;

  return {
    username: usernameRes.data as SakuraUsername | null,
    profile: profileRes.data as CreatorUserProfile | null,
  };
}

export async function isUsernameAvailable(username: string): Promise<boolean> {
  const trimmed = username.trim();
  const { data, error } = await supabase
    .from('sakura_usernames')
    .select('wallet_address')
    .ilike('username', trimmed)
    .maybeSingle();
  if (error) throw error;
  return !data;
}

export async function registerCreator(input: {
  walletAddress: string;
  username: string;
  displayName: string;
  bio: string;
}): Promise<void> {
  const usernameErr = validateUsername(input.username);
  if (usernameErr) throw new Error(usernameErr);

  const available = await isUsernameAvailable(input.username);
  if (!available) throw new Error('That username is already taken.');

  const now = new Date().toISOString();
  const displayName = input.displayName.trim() || input.username.trim();
  const bio = input.bio.trim();

  const { error: profileErr } = await supabase.from('user_profiles').upsert(
    {
      wallet_address: input.walletAddress,
      display_name: displayName,
      bio: bio || null,
      avatar_seed: avatarSeed(input.walletAddress),
      updated_at: now,
    },
    { onConflict: 'wallet_address' },
  );
  if (profileErr) throw profileErr;

  const { error: usernameInsertErr } = await supabase.from('sakura_usernames').upsert(
    {
      wallet_address: input.walletAddress,
      username: input.username.trim(),
      display_name: displayName,
      updated_at: now,
    },
    { onConflict: 'wallet_address' },
  );
  if (usernameInsertErr) throw usernameInsertErr;
}

export async function updateCreatorProfile(input: {
  walletAddress: string;
  displayName: string;
  bio: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const { error: profileErr } = await supabase.from('user_profiles').upsert(
    {
      wallet_address: input.walletAddress,
      display_name: input.displayName.trim() || null,
      bio: input.bio.trim() || null,
      avatar_seed: avatarSeed(input.walletAddress),
      updated_at: now,
    },
    { onConflict: 'wallet_address' },
  );
  if (profileErr) throw profileErr;

  const { data: usernameRow } = await supabase
    .from('sakura_usernames')
    .select('username')
    .eq('wallet_address', input.walletAddress)
    .maybeSingle();

  if (usernameRow) {
    const { error: usernameErr } = await supabase
      .from('sakura_usernames')
      .update({ display_name: input.displayName.trim() || null, updated_at: now })
      .eq('wallet_address', input.walletAddress);
    if (usernameErr) throw usernameErr;
  }
}

export async function getCreatorWorks(walletAddress: string): Promise<CreatorWork[]> {
  const { data, error } = await supabase
    .from('creator_works')
    .select('*')
    .eq('creator_wallet', walletAddress)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CreatorWork[];
}

export async function getWorkReleases(workId: string): Promise<CreatorRelease[]> {
  const { data, error } = await supabase
    .from('work_releases')
    .select('*')
    .eq('work_id', workId)
    .order('sequence_number', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CreatorRelease[];
}

/**
 * Public catalog: the most recent published works of a given kind, across all
 * creators. Powers the "From Sakura Creators" rows on the Novels/Manga/Anime
 * tabs.
 */
export async function listPublishedWorks(
  kind: CreatorWorkKind,
  limit = 30,
): Promise<CreatorWork[]> {
  const { data, error } = await supabase
    .from('creator_works')
    .select('*')
    .eq('kind', kind)
    .eq('publication_status', 'published')
    .eq('visibility', 'public')
    .order('published_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as CreatorWork[];
}

export interface WorkReadRelease {
  id: string;
  sequence_number: number;
  title: string;
  summary: string;
  content_type: string;
  body_text: string;
  published_at: string | null;
  media: { pages?: string[]; videoPath?: string | null; posterPath?: string | null };
}

export interface WorkReadPayload {
  work: {
    id: string;
    creator_wallet: string;
    kind: CreatorWorkKind;
    title: string;
    slug: string | null;
    description: string;
    genres: string[];
    series_status: string;
    published_at: string | null;
    cover_url: string | null;
  };
  releases: WorkReadRelease[];
}

/**
 * Load a public creator work for reading: work + published releases + per-kind
 * media URLs (novel body_text inline, signed manga page URLs, droplet anime
 * video paths). Served by the read-work-media edge function (service role, so
 * private manga pages can be signed).
 */
export async function fetchWorkForReading(workId: string): Promise<WorkReadPayload> {
  const { data, error } = await supabase.functions.invoke('read-work-media', {
    body: { work_id: workId },
  });
  if (error) throw new Error(error.message || 'Could not load this work.');
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }
  return data as WorkReadPayload;
}

function contentTypeForKind(kind: CreatorWorkKind): ReleaseContentType {
  if (kind === 'manga') return 'manga_chapter';
  if (kind === 'anime') return 'anime_episode';
  return 'novel_chapter';
}

export async function createCreatorWork(input: {
  walletAddress: string;
  kind: CreatorWorkKind;
  title: string;
  description: string;
  genres?: string[];
}): Promise<CreatorWork> {
  const title = input.title.trim();
  if (!title) throw new Error('Title is required.');

  const row = {
    creator_wallet: input.walletAddress,
    kind: input.kind,
    title,
    slug: slugify(title),
    description: input.description.trim(),
    genres: input.genres?.length ? input.genres : ['General'],
    language: 'en',
    series_status: 'ongoing',
    publication_status: 'draft',
    visibility: 'private',
    minting_enabled: false,
    release_metadata: {},
  };

  const { data, error } = await supabase.from('creator_works').insert(row).select('*').single();
  if (error) throw error;
  return data as CreatorWork;
}

export async function createWorkRelease(input: {
  workId: string;
  kind: CreatorWorkKind;
  title: string;
  summary?: string;
  bodyText?: string;
  sequenceNumber?: number;
}): Promise<CreatorRelease> {
  const title = input.title.trim();
  if (!title) throw new Error('Release title is required.');

  let sequence = input.sequenceNumber;
  if (sequence == null) {
    const { count, error: countErr } = await supabase
      .from('work_releases')
      .select('*', { count: 'exact', head: true })
      .eq('work_id', input.workId);
    if (countErr) throw countErr;
    sequence = (count ?? 0) + 1;
  }

  const row = {
    work_id: input.workId,
    sequence_number: sequence,
    title,
    summary: input.summary?.trim() || '',
    content_type: contentTypeForKind(input.kind),
    publication_status: 'draft',
    visibility: 'private',
    body_text: input.bodyText?.trim() || '',
    release_metadata: {},
  };

  const { data, error } = await supabase.from('work_releases').insert(row).select('*').single();
  if (error) throw error;
  return data as CreatorRelease;
}

export async function publishCreatorWork(
  workId: string,
  authHeaders: WalletAuthHeaders,
): Promise<void> {
  const { error } = await supabase.functions.invoke('publish-creator-work', {
    body: { work_id: workId },
    headers: authHeaders,
  });
  if (error) throw error;
}

export function publicCoverUrl(bucket: string, objectPath: string): string {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
  return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
}

// NOTE: cover uploads now go through the `upload-work-media` edge function
// (see uploadWorkImage in lib/creator-media.ts). A direct client storage write
// + creator_works UPDATE is blocked by RLS (the app has no Supabase session),
// so the old uploadWorkCover has been removed.

export function workCoverUrl(work: CreatorWork): string | null {
  const meta = work.release_metadata || {};
  if (typeof meta.cover_url === 'string') return meta.cover_url;
  if (typeof meta.cover_path === 'string') {
    return publicCoverUrl('creator-covers', meta.cover_path);
  }
  return null;
}

export function statusLabel(status: string): string {
  if (status === 'published') return 'Live';
  if (status === 'draft') return 'Draft';
  if (status === 'submitted') return 'In review';
  return status.replace(/_/g, ' ');
}

export interface PublicCreatorProfile {
  wallet_address: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_seed: string | null;
  avatar_url: string | null;
  follower_count: number;
  creator_verification_state: string | null;
  creator_verified_at: string | null;
}

export interface UserSearchResult {
  wallet_address: string;
  username: string;
  display_name: string | null;
  avatar_seed: string | null;
  avatar_url: string | null;
}

export async function searchUsersByUsername(query: string, limit = 20): Promise<UserSearchResult[]> {
  const trimmed = query.replace(/^@/, '').trim();
  if (trimmed.length < 2) return [];

  const { data: usernameRows, error } = await supabase
    .from('sakura_usernames')
    .select('wallet_address, username, display_name')
    .ilike('username', `%${trimmed}%`)
    .limit(limit);
  if (error) throw error;
  if (!usernameRows?.length) return [];

  const wallets = usernameRows.map((r) => r.wallet_address);
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('wallet_address, display_name, avatar_seed, avatar_url')
    .in('wallet_address', wallets);

  const profileMap = new Map((profiles ?? []).map((p) => [p.wallet_address, p]));

  return usernameRows.map((row) => {
    const profile = profileMap.get(row.wallet_address);
    return {
      wallet_address: row.wallet_address,
      username: row.username,
      display_name: profile?.display_name ?? row.display_name ?? null,
      avatar_seed: profile?.avatar_seed ?? row.wallet_address.slice(0, 8),
      avatar_url: profile?.avatar_url ?? null,
    };
  });
}

export async function getCreatorByUsername(username: string): Promise<PublicCreatorProfile | null> {
  const trimmed = username.replace(/^@/, '').trim();
  if (!trimmed) return null;

  const { data: usernameRow, error } = await supabase
    .from('sakura_usernames')
    .select('wallet_address, username, display_name')
    .ilike('username', trimmed)
    .maybeSingle();
  if (error) throw error;
  if (!usernameRow) return null;

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('wallet_address, display_name, bio, avatar_seed, avatar_url, follower_count, creator_verification_state, creator_verified_at')
    .eq('wallet_address', usernameRow.wallet_address)
    .maybeSingle();

  return {
    wallet_address: usernameRow.wallet_address,
    username: usernameRow.username,
    display_name: profile?.display_name ?? usernameRow.display_name ?? null,
    bio: profile?.bio ?? null,
    avatar_seed: profile?.avatar_seed ?? usernameRow.wallet_address.slice(0, 8),
    avatar_url: profile?.avatar_url ?? null,
    follower_count: profile?.follower_count ?? 0,
    creator_verification_state: profile?.creator_verification_state ?? null,
    creator_verified_at: profile?.creator_verified_at ?? null,
  };
}

export async function getPublicCreatorWorks(creatorWallet: string): Promise<CreatorWork[]> {
  const { data, error } = await supabase
    .from('creator_works')
    .select('*')
    .eq('creator_wallet', creatorWallet)
    .eq('visibility', 'public')
    .eq('publication_status', 'published')
    .order('published_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CreatorWork[];
}

export async function uploadCreatorAvatar(input: {
  keypair: import('@solana/web3.js').Keypair;
  localUri: string;
  mimeType?: string;
}): Promise<string> {
  const { invokeCreatorFunction } = await import('./creator-api');
  const base64 = await FileSystem.readAsStringAsync(input.localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const mimeType = input.mimeType?.trim() || 'image/jpeg';

  const result = await invokeCreatorFunction<{ avatar_url: string }>(
    'upload-profile-avatar',
    'upload-profile-avatar',
    input.keypair,
    { image_base64: base64, mime_type: mimeType },
  );

  if (!result.avatar_url) throw new Error('Avatar upload failed.');
  return result.avatar_url;
}
