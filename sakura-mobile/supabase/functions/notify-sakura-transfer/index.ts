import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { jsonResponse, sendExpoPushBatch } from '../_shared/expo-push.ts';
import { verifyWalletHeaders } from '../_shared/wallet-auth.ts';
import { TransferVerificationError, verifyTransfer } from '../_shared/verify-transfer.ts';

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

/**
 * "You received 50,000 SAKURA" — pushed to a real person's phone.
 *
 * This had no authentication of any kind: anyone who could reach the URL could
 * send that notification to any wallet, naming any sender and any amount. As a
 * phishing primitive that is close to ideal, because the notification arrives
 * from the app the user trusts.
 *
 * A shared secret is not available here — the caller is the app on someone's
 * device, and a secret shipped to the client is not a secret. So the sender
 * signs instead: the notification can only claim a transfer FROM the wallet that
 * signed the request.
 *
 * Exaggeration is now closed too. The amount in the payload is treated as a
 * claim and discarded: `verifyTransfer` reads the transaction, checks the
 * signer is the fee payer, and measures what actually landed in the receiver's
 * accounts in exact base units. The notification quotes the chain's number, so
 * "you received 50,000 SAKURA" cannot be produced by a 1-token transfer with a
 * fifty-thousand in the body.
 *
 * A txid is therefore required. It was optional before, which is what made the
 * amount unfalsifiable in the first place.
 */
Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  let signer: string;
  try {
    signer = verifyWalletHeaders(req.headers, 'transfer-notify').walletAddress;
  } catch {
    return jsonResponse(401, { error: 'Could not verify your wallet.' });
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
  if (!txid) {
    return jsonResponse(400, { error: 'A transaction signature is required.' });
  }

  // You may only announce your own outgoing transfer.
  if (senderWallet !== signer) {
    return jsonResponse(403, { error: 'You can only notify transfers you sent.' });
  }

  // The chain decides the number, not the caller. `amount` above is validated
  // only so an obviously malformed body is rejected before we pay for an RPC
  // call; it is never used in the notification.
  let verifiedAmount: number;
  try {
    const verified = await verifyTransfer({
      signature: txid,
      expectedSigner: signer,
      receiver: receiverWallet,
      asset,
    });
    verifiedAmount = verified.amount;
  } catch (e) {
    if (e instanceof TransferVerificationError) {
      // 'unverifiable' is our problem, not the caller's — an RPC outage must not
      // read as a rejected transfer.
      return jsonResponse(e.failure === 'unverifiable' ? 503 : 400, {
        error: e.message,
        reason: e.failure,
      });
    }
    return jsonResponse(500, { error: e instanceof Error ? e.message : 'Verification failed' });
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
  const unit = isSol ? 'SOL' : 'SKR';
  const amountLabel = isSol ? formatSolAmount(verifiedAmount) : formatSakuraAmount(verifiedAmount);

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
        amount: verifiedAmount,
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
        amount: verifiedAmount,
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
