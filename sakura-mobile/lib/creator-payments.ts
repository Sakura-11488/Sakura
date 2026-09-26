import { readStore, writeStore, removeStore } from './kv-store';

function key(workId: string, wallet: string): string {
  return `creator-payment-${workId}-${wallet}.txt`;
}

export async function pendingCreatorPayment(workId: string, wallet: string): Promise<string | null> {
  const value = await readStore(key(workId, wallet));
  return value && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) ? value : null;
}

export async function saveCreatorPayment(workId: string, wallet: string, signature: string): Promise<void> {
  const saved = await writeStore(key(workId, wallet), signature);
  if (!saved) throw new Error(`Payment was submitted but could not be saved locally. Keep this transaction ID: ${signature}`);
}

export async function clearCreatorPayment(workId: string, wallet: string): Promise<void> {
  await removeStore(key(workId, wallet));
}
