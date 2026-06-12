import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { jsonResponse, sendExpoPushBatch } from '../_shared/expo-push.ts';

type TransferAsset = 'sakura' | 'sol';

interface TransferBody {
  asset?: TransferAsset;
  senderWallet?: string;
  receiverWallet?: string;
  amount?: number;
  txid?: string;
}

function shortenWallet(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function formatSakuraAmount(amount: number): string {
  return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatSolAmount(amount: number): string {
  return amount.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

function isWallet(address: string): boolean {
  return address.length >= 32 && address.length <= 44;
}

function normalizeAsset(raw: string | undefined): TransferAsset {
  return raw === 'sol' ? 'sol' : 'sakura';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let body: TransferBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const asset = normalizeAsset(body.asset);
  const senderWallet = body.senderWallet?.trim() ?? '';
  const receiverWallet = body.receiverWallet?.trim() ?? '';
  const amount = Number(body.amount);
  const txid = body.txid?.trim() ?? '';

  if (!isWallet(senderWallet) || !isWallet(receiverWallet) || !Number.isFinite(amount) || amount <= 0) {
    return jsonResponse(400, { error: 'Invalid transfer payload' });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const wallets = [senderWallet, receiverWallet];
  const { data: rows, error } = await supabase
    .from('push_tokens')
    .select('expo_push_token, wallet_address')
    .eq('enabled', true)
    .in('wallet_address', wallets);

  if (error) return jsonResponse(500, { error: error.message });

  const tokensByWallet = new Map<string, string[]>();
  for (const row of rows ?? []) {
    const wallet = row.wallet_address as string;
    const token = row.expo_push_token as string;
    if (!wallet || !token) continue;
    const list = tokensByWallet.get(wallet) ?? [];
    list.push(token);
    tokensByWallet.set(wallet, list);
  }

  const isSol = asset === 'sol';
  const pushType = isSol ? 'sol_transfer' : 'sakura_transfer';
  const unit = isSol ? 'SOL' : 'SAKURA';
  const amountLabel = isSol ? formatSolAmount(amount) : formatSakuraAmount(amount);

  const messages: Array<{
    to: string;
    title: string;
    body: string;
    data: Record<string, string | number | boolean>;
  }> = [];

  for (const token of [...new Set(tokensByWallet.get(senderWallet) ?? [])]) {
    messages.push({
      to: token,
      title: `${unit} sent`,
      body: `You sent ${amountLabel} ${unit} to ${shortenWallet(receiverWallet)}`,
      data: {
        type: pushType,
        asset,
        role: 'sent',
        amount,
        counterparty: receiverWallet,
        txid,
      },
    });
  }

  for (const token of [...new Set(tokensByWallet.get(receiverWallet) ?? [])]) {
    messages.push({
      to: token,
      title: `${unit} received`,
      body: `You just received ${amountLabel} ${unit} from ${shortenWallet(senderWallet)}`,
      data: {
        type: pushType,
        asset,
        role: 'received',
        amount,
        counterparty: senderWallet,
        txid,
      },
    });
  }

  if (!messages.length) {
    return jsonResponse(200, { sent: 0, message: 'No push tokens for these wallets' });
  }

  try {
    const result = await sendExpoPushBatch(messages);
    return jsonResponse(200, { sent: messages.length, result });
  } catch (e) {
    return jsonResponse(502, { error: e instanceof Error ? e.message : 'Push send failed' });
  }
});
