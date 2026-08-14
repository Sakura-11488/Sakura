import { supabase } from './supabase';
import { buildWalletAuthHeaders, type WalletAuthHeaders } from './wallet-auth';
import { AVATAR_MINT_PRICE_SAKURA } from './wallet/config';

export type AvatarGenerationMode = 'tastes' | 'general';

export interface AvatarGenerationResult {
  id: string;
  status: 'ready' | 'failed' | 'processing' | 'queued' | 'rejected';
  public_url?: string | null;
  metadata_uri?: string | null;
  mint_address?: string | null;
  mint_tx_signature?: string | null;
  payment_tx_signature?: string | null;
  payment_amount_sakura?: number;
  /** True when this mint spent a free apology credit and cost the user nothing. */
  free_credit?: boolean;
  /** Free avatars still owed to this wallet after this mint. */
  credits_remaining?: number;
  /** Owed avatars whose mint went out but was never confirmed. */
  credits_in_review?: number;
  taste_snapshot?: {
    top_genres?: string[];
    top_titles?: string[];
    content_mix?: string[];
    vibe?: string;
  };
  mode?: AvatarGenerationMode;
  error?: string;
}

export interface AvatarProfileFields {
  avatar_url?: string | null;
  avatar_seed?: string | null;
  avatar_mint_address?: string | null;
  wallet_address: string;
}

export interface AvatarMintQuote {
  price_sakura: number;
  currency: string;
  rate_limit_hours: number;
}

export interface AvatarMintItem {
  id: string;
  mint_address: string | null;
  public_url: string | null;
  mode: AvatarGenerationMode;
  created_at: string;
  is_active: boolean;
}

export interface AvatarMintEligibility extends AvatarMintQuote {
  can_mint: boolean;
  /**
   * Free avatars this wallet is owed and has not forged yet.
   *
   * > 0 means the forge must NOT call sendSakura and must not gate on
   * `retry_after_hours` — a credit is exempt from the 24h limit server-side.
   * Charging here would take 100,000 SAKURA for an avatar we are giving away,
   * from the exact wallets this whole flow exists to apologise to.
   */
  free_credits: number;
  already_minted: boolean;
  mint_count: number;
  active_generation_id: string | null;
  mint_address: string | null;
  avatar_url: string | null;
  retry_after_hours: number;
  mints: AvatarMintItem[];
}

export function resolveAvatarUri(profile: AvatarProfileFields): string {
  if (profile.avatar_url?.trim()) return profile.avatar_url.trim();
  const seed = profile.wallet_address.trim() || profile.avatar_seed?.trim() || 'sakura';
  return `https://robohash.org/${encodeURIComponent(seed)}?set=set4&bgset=bg1`;
}

export function hasMintedAvatar(profile: AvatarProfileFields): boolean {
  return Boolean(profile.avatar_url?.trim() || profile.avatar_mint_address?.trim());
}

export function walletAccentColor(wallet: string): string {
  let hash = 0;
  for (let i = 0; i < wallet.length; i += 1) {
    hash = wallet.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 52%)`;
}

interface InvokeFailure {
  message: string;
  /** 0 when the failure never reached the edge function. */
  status: number;
  /** The generation the server was working on, when it told us. */
  generationId: string | null;
  code: string | null;
  creditsRemaining: number | null;
}

/**
 * Everything the edge function said, not just the sentence.
 *
 * The bodies a resumable forge needs were all thrown away before: 409
 * `{ error, id }` (already processing), 502 `{ error, id }`, and now
 * `code: 'no_credits_left' | 'mint_in_flight' | 'mint_unconfirmed'`. The code is
 * what lets the apology card tell "nothing was spent, try again" apart from
 * "your avatar may already exist, go and look", instead of asserting one of them
 * blindly.
 */
async function parseInvokeFailure(error: {
  message?: string;
  context?: Response;
}): Promise<InvokeFailure> {
  let message = error.message || 'Avatar mint failed.';
  let generationId: string | null = null;
  let code: string | null = null;
  let creditsRemaining: number | null = null;

  if (error.context) {
    try {
      const body = await error.context.json();
      if (body?.error) message = String(body.error);
      else if (body?.retry_after_hours) {
        message = `Rate limited. Try again in about ${body.retry_after_hours} hour(s).`;
      }
      if (body?.id) generationId = String(body.id);
      if (body?.code) code = String(body.code);
      if (typeof body?.credits_remaining === 'number') creditsRemaining = body.credits_remaining;
    } catch {
      // Fall through to generic message.
    }
  }

  return { message, status: error.context?.status ?? 0, generationId, code, creditsRemaining };
}

async function parseInvokeError(error: { message?: string; context?: Response }): Promise<string> {
  return (await parseInvokeFailure(error)).message;
}

/** A forge failure that kept the HTTP status, the generation id and the code. */
export class AvatarForgeError extends Error {
  readonly status: number;
  readonly generationId: string | null;
  readonly code: string | null;
  readonly creditsRemaining: number | null;

  constructor(message: string, failure: Omit<InvokeFailure, 'message'>) {
    super(message);
    this.name = 'AvatarForgeError';
    this.status = failure.status;
    this.generationId = failure.generationId;
    this.code = failure.code;
    this.creditsRemaining = failure.creditsRemaining;
    // Without this, `instanceof` is false whenever the bundle downlevels class
    // extends — which is exactly what the callers rely on.
    Object.setPrototypeOf(this, AvatarForgeError.prototype);
  }
}

export async function fetchAvatarMintEligibility(
  authHeaders: WalletAuthHeaders,
): Promise<AvatarMintEligibility> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'eligibility' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    price_sakura: Number(data?.price_sakura ?? AVATAR_MINT_PRICE_SAKURA),
    currency: String(data?.currency ?? 'SAKURA'),
    rate_limit_hours: Number(data?.rate_limit_hours ?? 24),
    can_mint: Boolean(data?.can_mint),
    // Defaults to 0, so a client running against an older function deploy pays
    // as it always did rather than forging on a credit that is not there.
    free_credits: Number(data?.free_credits ?? 0),
    already_minted: Boolean(data?.already_minted),
    mint_count: Number(data?.mint_count ?? 0),
    active_generation_id: data?.active_generation_id ?? null,
    mint_address: data?.mint_address ?? null,
    avatar_url: data?.avatar_url ?? null,
    retry_after_hours: Number(data?.retry_after_hours ?? 0),
    mints: Array.isArray(data?.mints) ? (data.mints as AvatarMintItem[]) : [],
  };
}

export async function listAvatarMints(authHeaders: WalletAuthHeaders): Promise<AvatarMintItem[]> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'list' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return Array.isArray(data?.mints) ? (data.mints as AvatarMintItem[]) : [];
}

export async function selectAvatarMint(
  authHeaders: WalletAuthHeaders,
  generationId: string,
): Promise<{ mint_address: string | null; public_url: string | null; generation_id: string }> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'select', generation_id: generationId },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    generation_id: String(data?.generation_id ?? generationId),
    mint_address: data?.mint_address ?? null,
    public_url: data?.public_url ?? null,
  };
}

export async function fetchAvatarMintQuote(): Promise<AvatarMintQuote> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'quote' },
  });
  if (error) throw new Error(await parseInvokeError(error));
  return {
    price_sakura: Number(data?.price_sakura ?? AVATAR_MINT_PRICE_SAKURA),
    currency: String(data?.currency ?? 'SAKURA'),
    rate_limit_hours: Number(data?.rate_limit_hours ?? 24),
  };
}

export async function generateUserAvatar(input: {
  mode: AvatarGenerationMode;
  /**
   * Omit to spend a free apology credit. This is not a way to get a free avatar:
   * with no signature the server looks for an unspent credit on the SIGNED
   * wallet and returns the ordinary "payment required" 400 when there is none.
   */
  paymentTxSignature?: string | null;
  hint?: string;
  authHeaders: WalletAuthHeaders;
}): Promise<AvatarGenerationResult> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'generate',
      mode: input.mode,
      hint: input.hint?.trim() || undefined,
      // Omitted entirely rather than sent as null: a missing signature is what
      // tells the server to spend a credit.
      ...(input.paymentTxSignature ? { payment_tx_signature: input.paymentTxSignature } : {}),
    },
    headers: input.authHeaders,
  });

  if (error) {
    const failure = await parseInvokeFailure(error);
    const { message, ...rest } = failure;
    throw new AvatarForgeError(message, rest);
  }

  if (data?.error) {
    throw new AvatarForgeError(String(data.error), {
      status: 200,
      generationId: (data?.id as string | undefined) ?? null,
      code: (data?.code as string | undefined) ?? null,
      creditsRemaining:
        typeof data?.credits_remaining === 'number' ? (data.credits_remaining as number) : null,
    });
  }

  return data as AvatarGenerationResult;
}

export async function fetchAvatarGenerationStatus(input: {
  generationId: string;
  authHeaders: WalletAuthHeaders;
}): Promise<AvatarGenerationResult> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'status',
      generation_id: input.generationId,
    },
    headers: input.authHeaders,
  });

  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return data as AvatarGenerationResult;
}

export function buildAvatarAuthHeaders(keypair: Parameters<typeof buildWalletAuthHeaders>[0]) {
  return buildWalletAuthHeaders(keypair, 'generate-avatar');
}

/**
 * A one-time apology grant: free avatars minted to a wallet that paid SAKURA and
 * received nothing. `resolved` is the server-side latch — once true the prompt
 * must never be shown again, on any device, after any reinstall.
 *
 * The unauthenticated status call deliberately carries NO generation ids, only
 * public image URLs, and performs no writes. Ids and the ability to resolve the
 * grant both require a wallet signature.
 */
export type AvatarApologyIncident = 'charged_without_delivery' | 'charged_twice_delivered_once';

export interface AvatarApologyGrantStatus {
  has_grant: boolean;
  resolved: boolean;
  /**
   * There is something to show him: at least one granted avatar has landed, or
   * at least one free avatar is still waiting to be forged. It used to mean
   * "every promised avatar has landed", which under the credit model is never
   * true at card time — the whole point is that nothing is minted until he asks.
   */
  ready: boolean;
  incident: AvatarApologyIncident;
  avatar_count: number;
  minted_count: number;
  /** Free avatars still owed. The card offers to forge exactly this many. */
  credits_remaining: number;
  /** Owed avatars whose mint went out but never confirmed. Not re-forgeable. */
  credits_in_review: number;
  /** Unspent credits switched off by the operator. Say so; never vanish. */
  credits_paused: number;
  /** What the user actually lost, in SAKURA. Drives the apology copy. */
  charged_sakura: number;
  /** SAKURA sent back manually. >0 changes the apology copy. */
  refund_sakura: number;
  /** How many avatars they DID receive for those payments. */
  received_count: number;
  granted_at: string | null;
  already_shown: boolean;
  preview_urls: string[];
}

export interface AvatarApologyGrantDetail extends AvatarApologyGrantStatus {
  avatars: AvatarMintItem[];
}

function normalizeGrant(data: Record<string, unknown> | null | undefined): AvatarApologyGrantStatus {
  const incident = data?.incident === 'charged_twice_delivered_once'
    ? 'charged_twice_delivered_once'
    : 'charged_without_delivery';
  return {
    has_grant: Boolean(data?.has_grant),
    resolved: Boolean(data?.resolved),
    ready: Boolean(data?.ready),
    incident,
    avatar_count: Number(data?.avatar_count ?? 0),
    minted_count: Number(data?.minted_count ?? 0),
    credits_remaining: Number(data?.credits_remaining ?? 0),
    credits_in_review: Number(data?.credits_in_review ?? 0),
    credits_paused: Number(data?.credits_paused ?? 0),
    charged_sakura: Number(data?.charged_sakura ?? 0),
    refund_sakura: Number(data?.refund_sakura ?? 0),
    received_count: Number(data?.received_count ?? 0),
    granted_at: (data?.granted_at as string | null) ?? null,
    already_shown: Boolean(data?.already_shown),
    preview_urls: Array.isArray(data?.preview_urls) ? (data!.preview_urls as string[]) : [],
  };
}

/**
 * App-open check. Unauthenticated on purpose (same shape as
 * fetchGamificationState) so launching the app cannot raise an unlock prompt for
 * the overwhelming majority of users who have no grant. Swallows failures to
 * null: a background check must never throw into the UI.
 */
export async function fetchAvatarApologyGrantStatus(
  walletAddress: string,
): Promise<AvatarApologyGrantStatus | null> {
  try {
    const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
      body: { action: 'grant-status', wallet_address: walletAddress },
    });
    if (error || !data || (data as { error?: string }).error) return null;
    return normalizeGrant(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Signed fetch of the granted avatars. Calling this is what marks the apology as
 * SHOWN server-side, which is also what unlocks resolution — the grant cannot be
 * marked "decided" before this has happened.
 */
export async function fetchAvatarApologyGrantDetail(
  authHeaders: WalletAuthHeaders,
): Promise<AvatarApologyGrantDetail> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: { action: 'grant-detail' },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  return {
    ...normalizeGrant(data as Record<string, unknown>),
    avatars: Array.isArray(data?.avatars) ? (data.avatars as AvatarMintItem[]) : [],
  };
}

/**
 * Burn the apology prompt for good. Signed, so only the owner can dismiss their
 * own grant. Idempotent server-side: a second ack is a no-op and the first
 * resolution stays authoritative.
 */
export async function acknowledgeAvatarApologyGrant(
  authHeaders: WalletAuthHeaders,
  input: { resolution: 'selected' | 'dismissed'; generationId?: string | null },
): Promise<{ resolved: boolean }> {
  const { data, error } = await supabase.functions.invoke('generate-user-avatar', {
    body: {
      action: 'grant-ack',
      resolution: input.resolution,
      ...(input.resolution === 'selected' && input.generationId
        ? { generation_id: input.generationId }
        : {}),
    },
    headers: authHeaders,
  });
  if (error) throw new Error(await parseInvokeError(error));
  if (data?.error) throw new Error(String(data.error));
  // A 'selected' ack on a grant that still owes avatars returns resolved:false
  // on purpose — picking a profile picture is not waiving the rest.
  return { resolved: Boolean(data?.resolved) };
}
