import { supabase } from './supabase';

export interface SakuraMemory {
  id: string;
  wallet_address: string;
  note: string;
  tag: string | null;
  created_at: string;
}

const MAX_INJECT = 6;

export async function listMemories(walletAddress: string, limit = 20): Promise<SakuraMemory[]> {
  if (!walletAddress) return [];
  const { data, error } = await supabase
    .from('sakura_ai_memories')
    .select('*')
    .eq('wallet_address', walletAddress)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 50));
  if (error) {
    if ((error as any).code === '42P01') return [];
    console.warn('[ai-memories] list failed', error.message);
    return [];
  }
  return (data as SakuraMemory[]) || [];
}

export async function buildMemoryContext(walletAddress: string): Promise<string> {
  const items = await listMemories(walletAddress, MAX_INJECT);
  if (items.length === 0) return '';
  const lines = items.map((m, i) => `  ${i + 1}. ${m.note}${m.tag ? ` (#${m.tag})` : ''}`);
  return [
    'Long-term memories about this user (always factor these into your responses):',
    ...lines,
  ].join('\n');
}

export async function addMemory(
  walletAddress: string,
  note: string,
  tag?: string | null,
): Promise<{ ok: boolean; memory?: SakuraMemory; error?: string }> {
  const trimmed = (note || '').trim();
  if (trimmed.length < 3 || trimmed.length > 240) {
    return { ok: false, error: 'Memory must be between 3 and 240 characters.' };
  }
  const { data, error } = await supabase
    .from('sakura_ai_memories')
    .insert({ wallet_address: walletAddress, note: trimmed, tag: tag?.trim() || null })
    .select()
    .single();
  if (error || !data) {
    if ((error as any)?.code === '42P01') return { ok: false, error: 'Memory table not yet migrated.' };
    return { ok: false, error: error?.message || 'Failed to save memory.' };
  }
  return { ok: true, memory: data as SakuraMemory };
}

export async function forgetMemory(
  walletAddress: string,
  options: { id?: string; contains?: string },
): Promise<{ ok: boolean; deleted?: number; error?: string }> {
  let query = (supabase
    .from('sakura_ai_memories')
    .delete({ count: 'exact' }) as any)
    .eq('wallet_address', walletAddress);
  if (options.id) {
    query = query.eq('id', options.id);
  } else if (options.contains?.trim()) {
    query = query.ilike('note', `%${options.contains.trim()}%`);
  } else {
    return { ok: false, error: 'Provide an id or a text fragment.' };
  }
  const { error, count } = await query;
  if (error) {
    if ((error as any).code === '42P01') return { ok: false, error: 'Memory table not yet migrated.' };
    return { ok: false, error: error.message };
  }
  if (!count || count === 0) return { ok: false, error: 'No matching memory found.' };
  return { ok: true, deleted: count };
}
