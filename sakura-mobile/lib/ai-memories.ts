import { invokeMemoryOp } from './sakura-ai';

/**
 * Sakura's long-term memories about the user.
 *
 * These used to be read and written straight from the client with the anon key.
 * That only worked because `sakura_ai_memories` carried `USING(true)` on every
 * policy — which also meant anyone with the anon key (it ships inside the APK
 * and the PWA bundle) could read or delete anybody else's memories. The table
 * is service-role only now, so every operation goes through `sakura-ai-chat`,
 * which knows the wallet from an Ed25519 signature rather than from whatever
 * address the caller typed.
 *
 * The `walletAddress` argument is kept for call-site compatibility but is no
 * longer authoritative: the server uses the wallet it verified, so asking for
 * someone else's memories simply returns your own.
 */

export interface SakuraMemory {
  id: string;
  wallet_address: string;
  note: string;
  tag: string | null;
  created_at: string;
}

export async function listMemories(_walletAddress: string, limit = 20): Promise<SakuraMemory[]> {
  try {
    const data = await invokeMemoryOp({ op: 'list', limit: Math.min(limit, 50) });
    return (data?.memories ?? []) as SakuraMemory[];
  } catch (e) {
    console.warn('[ai-memories] list failed', e instanceof Error ? e.message : e);
    return [];
  }
}

export async function buildMemoryContext(walletAddress: string): Promise<string> {
  const items = await listMemories(walletAddress, 6);
  if (items.length === 0) return '';
  const lines = items.map((m, i) => `  ${i + 1}. ${m.note}${m.tag ? ` (#${m.tag})` : ''}`);
  return [
    'Long-term memories about this user (always factor these into your responses):',
    ...lines,
  ].join('\n');
}

export async function addMemory(
  _walletAddress: string,
  note: string,
  tag?: string | null,
): Promise<{ ok: boolean; memory?: SakuraMemory; error?: string }> {
  const trimmed = (note || '').trim();
  if (trimmed.length < 3 || trimmed.length > 240) {
    return { ok: false, error: 'Memory must be between 3 and 240 characters.' };
  }
  try {
    const data = await invokeMemoryOp({ op: 'add', note: trimmed, tag: tag?.trim() || null });
    return data as { ok: boolean; memory?: SakuraMemory; error?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to save memory.' };
  }
}

export async function forgetMemory(
  _walletAddress: string,
  options: { id?: string; contains?: string },
): Promise<{ ok: boolean; deleted?: number; error?: string }> {
  const contains = options.contains?.trim();
  if (!contains) return { ok: false, error: 'Provide a text fragment to forget.' };
  try {
    const data = await invokeMemoryOp({ op: 'forget', contains });
    return data as { ok: boolean; deleted?: number; error?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to delete memory.' };
  }
}
