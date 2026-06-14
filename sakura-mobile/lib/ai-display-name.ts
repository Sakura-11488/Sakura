import { listMemories } from './ai-memories';
import { getProfile, upsertProfile } from './supabase';

const NAME_TAG = /^(name|display-?name|preferred-?name)$/i;

const NAME_PATTERNS = [
  /(?:my name is|call me|i am|i'm|they call me|name is)\s+([A-Za-z][A-Za-z0-9_.\- ]{0,38}[A-Za-z0-9_.\-])/i,
  /^name:\s*(.+)$/i,
  /^preferred name:\s*(.+)$/i,
];

export function extractDisplayNameFromMemory(note: string, tag?: string | null): string | null {
  const trimmed = (note || '').trim();
  if (!trimmed) return null;

  if (tag && NAME_TAG.test(tag.trim())) {
    const fromTag = sanitizeDisplayName(trimmed);
    if (fromTag) return fromTag;
  }

  for (const pattern of NAME_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const name = sanitizeDisplayName(match[1]);
      if (name) return name;
    }
  }

  return null;
}

function sanitizeDisplayName(raw: string): string | null {
  const cleaned = raw
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 40) return null;
  if (/^(user|guest|anon|anonymous)$/i.test(cleaned)) return null;
  return cleaned;
}

export async function syncAiDisplayName(walletAddress: string, displayName: string): Promise<void> {
  const existing = await getProfile(walletAddress);
  await upsertProfile(walletAddress, displayName, existing?.bio ?? null);
}

export async function resolveProfileDisplayName(walletAddress: string): Promise<string> {
  const profile = await getProfile(walletAddress);
  const fromProfile = profile?.display_name?.trim();
  if (fromProfile) return fromProfile;

  const memories = await listMemories(walletAddress, 30);
  for (const memory of memories) {
    const extracted = extractDisplayNameFromMemory(memory.note, memory.tag);
    if (extracted) return extracted;
  }

  return '';
}
