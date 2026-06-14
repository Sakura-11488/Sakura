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

export async function uploadWorkCover(input: {
  walletAddress: string;
  workId: string;
  localUri: string;
  mimeType?: string;
}): Promise<string | null> {
  const ext = input.mimeType?.includes('png') ? 'png' : 'jpg';
  const objectPath = `${input.walletAddress}/${input.workId}/cover.${ext}`;

  const base64 = await FileSystem.readAsStringAsync(input.localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const { error: uploadErr } = await supabase.storage
    .from('creator-covers')
    .upload(objectPath, bytes, {
      contentType: input.mimeType || `image/${ext}`,
      upsert: true,
    });

  if (uploadErr) {
    console.warn('Cover upload failed:', uploadErr.message);
    return null;
  }

  const coverUrl = publicCoverUrl('creator-covers', objectPath);
  const { error: metaErr } = await supabase
    .from('creator_works')
    .update({
      release_metadata: { cover_url: coverUrl, cover_path: objectPath },
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.workId);
  if (metaErr) throw metaErr;

  return coverUrl;
}

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
