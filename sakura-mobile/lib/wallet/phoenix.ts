import { Buffer } from 'buffer';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  type Keypair,
} from '@solana/web3.js';
import { PhoenixHttpClient } from '@ellipsis-labs/rise';
import { getConnection } from './connection';
import { validatePhoenixInstructions } from './phoenix-validation';

// ─── Config ─────────────────────────────────────────────────────────────────
const DEFAULT_PHOENIX_API_URL = 'https://perp-api.phoenix.trade';
const DEFAULT_MARKET_SYMBOL = 'SOL';

export function getPhoenixApiUrl(): string {
  return (process.env.EXPO_PUBLIC_PHOENIX_API_URL || DEFAULT_PHOENIX_API_URL).replace(/\/+$/, '');
}

export function normalizePhoenixSymbol(symbol?: string | null): string {
  const configured = (
    symbol ||
    process.env.EXPO_PUBLIC_PHOENIX_DEFAULT_MARKET ||
    DEFAULT_MARKET_SYMBOL
  ).trim();
  return configured.replace(/-PERP$/i, '').toUpperCase();
}

export function getDefaultPhoenixSymbol(): string {
  return normalizePhoenixSymbol();
}

let httpClient: PhoenixHttpClient | null = null;

function getPhoenixHttpClient(): PhoenixHttpClient {
  if (!httpClient) {
    httpClient = new PhoenixHttpClient({ apiUrl: getPhoenixApiUrl(), timeout: 30_000 });
  }
  return httpClient;
}

// ─── Types ──────────────────────────────────────────────────────────────────
export interface PhoenixMarketState {
  symbol: string;
  displaySymbol: string;
  markPrice: number;
  indexPrice: number;
  midPrice: number;
  fundingRate: number;
  nextFundingTs: number;
  openInterest: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  change24h: number;
  maxLeverage: number;
  takerFee: number;
  makerFee: number;
  active: boolean;
}

export interface PhoenixPositionInfo {
  hasPosition: boolean;
  side: 'long' | 'short' | 'none';
  size: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  pnl: number;
  pnlPercent: number;
  margin: number;
  leverage: number;
  liquidationPrice: number;
  market: string;
}

export interface PhoenixBalanceInfo {
  wallet: string;
  collateral: number;
  availableMargin: number;
  effectiveCollateral: number;
  maintenanceMargin: number;
  initialMargin: number;
  unrealizedPnl: number;
  riskState: string;
}

export interface PhoenixTradeRecord {
  id: string;
  market: string;
  side: string;
  size: number;
  price: number;
  pnl: number | null;
  status: string;
  createdAt: string;
  txSig?: string;
}

export interface PhoenixOpenOrder {
  id: string;
  market: string;
  side: string;
  price: number;
  size: number;
  reduceOnly?: boolean;
}

export interface PhoenixTraderData {
  balance: PhoenixBalanceInfo;
  position: PhoenixPositionInfo | null;
  openOrders: PhoenixOpenOrder[];
  trades: PhoenixTradeRecord[];
  isActivated: boolean;
}

export interface PhoenixOrderRequest {
  authority: string;
  symbol: string;
  side: 'long' | 'short';
  orderType: 'market' | 'limit';
  quantity: number;
  price?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  transferAmount?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

type TokenAmountLike = { ui?: string; value?: string | number; decimals?: number };
function tokenUi(value: TokenAmountLike | undefined): number {
  if (!value) return 0;
  if (typeof value.ui === 'string') return toNumber(value.ui);
  const decimals = toNumber(value.decimals);
  const raw = toNumber(value.value);
  return decimals > 0 ? raw / 10 ** decimals : raw;
}

// ─── Market data ────────────────────────────────────────────────────────────
type MarketStatsLike = {
  markPx?: number; midPx?: number; oraclePx?: number; prevDayPx?: number;
  dayNtlVlm?: number; openInterest?: number; funding?: number; high24h?: number; low24h?: number;
};
type MarketConfigLike = {
  symbol?: string; marketStatus?: string; takerFee?: number; makerFee?: number;
  fundingIntervalSeconds?: number; leverageTiers?: Array<{ maxLeverage?: number }>;
};

function buildMarketState(
  symbol: string,
  config: MarketConfigLike,
  latestStats: MarketStatsLike | null,
): PhoenixMarketState {
  const markPrice = toNumber(latestStats?.markPx ?? latestStats?.midPx ?? latestStats?.oraclePx);
  const indexPrice = toNumber(latestStats?.oraclePx, markPrice);
  const previous = toNumber(latestStats?.prevDayPx, markPrice);
  const change24h = previous > 0 ? ((markPrice - previous) / previous) * 100 : 0;
  const maxLeverage = Math.max(
    1,
    ...(config.leverageTiers || []).map((tier) => toNumber(tier.maxLeverage, 1)),
  );
  return {
    symbol,
    displaySymbol: `${symbol}-PERP`,
    markPrice,
    indexPrice,
    midPrice: toNumber(latestStats?.midPx, markPrice),
    fundingRate: toNumber(latestStats?.funding),
    nextFundingTs: Math.floor(Date.now() / 1000) + toNumber(config.fundingIntervalSeconds, 3600),
    openInterest: toNumber(latestStats?.openInterest),
    volume24h: toNumber(latestStats?.dayNtlVlm),
    high24h: toNumber(latestStats?.high24h, Math.max(markPrice, previous)),
    low24h: toNumber(latestStats?.low24h, Math.min(markPrice, previous || markPrice)),
    change24h,
    maxLeverage,
    takerFee: toNumber(config.takerFee),
    makerFee: toNumber(config.makerFee),
    active: config.marketStatus === 'active',
  };
}

export async function fetchPhoenixMarketState(
  inputSymbol = getDefaultPhoenixSymbol(),
): Promise<PhoenixMarketState> {
  const symbol = normalizePhoenixSymbol(inputSymbol);
  const client = getPhoenixHttpClient();
  const [config, stats] = await Promise.all([
    client.exchange().getMarket(symbol) as Promise<MarketConfigLike>,
    client.markets().getMarketStatsHistory(symbol, { limit: 1 }).catch(() => null) as Promise<unknown>,
  ]);
  const statsData =
    stats && typeof stats === 'object' && 'data' in stats
      ? ((stats as { data?: MarketStatsLike[] }).data?.[0] ?? null)
      : null;
  return buildMarketState(symbol, config, statsData);
}

// ─── Trader data ──────────────────────────────────────────────────────────────
type TraderPositionLike = {
  symbol?: string; marketSymbol?: string; side?: string;
  baseLots?: string | number; baseUnits?: string | number; size?: string | number;
  entryPrice?: string | number; pnl?: string | number; unrealizedPnl?: string | number;
  margin?: string | number; liquidationPrice?: string | number;
};
type TraderLike = {
  state?: string; riskState?: string;
  collateralBalance?: TokenAmountLike; effectiveCollateral?: TokenAmountLike;
  maintenanceMargin?: TokenAmountLike; initialMargin?: TokenAmountLike; unrealizedPnl?: TokenAmountLike;
  positions?: TraderPositionLike[]; orders?: Array<Record<string, unknown>>;
};
type TraderStateLike = TraderLike & {
  traders?: TraderLike[];
  snapshot?: { capabilities?: { state?: string }; subaccounts?: Array<{ positions?: TraderPositionLike[]; orders?: Array<Record<string, unknown>> }> };
};
type HistoryResponse = { data?: Array<Record<string, unknown>> };

function normalizePosition(
  position: TraderPositionLike | undefined,
  markPrice: number,
): PhoenixPositionInfo | null {
  if (!position) return null;
  const size = Math.abs(toNumber(position.baseUnits ?? position.size ?? position.baseLots));
  if (size <= 0) return null;
  const sideText = String(position.side || '').toLowerCase();
  const side = sideText.includes('ask') || sideText.includes('short') ? 'short' : 'long';
  const entryPrice = toNumber(position.entryPrice, markPrice);
  const pnl = toNumber(position.pnl ?? position.unrealizedPnl);
  const notional = size * markPrice;
  const margin = toNumber(position.margin, notional > 0 ? notional / 5 : 0);
  return {
    hasPosition: true,
    side,
    size,
    notional,
    entryPrice,
    markPrice,
    pnl,
    pnlPercent: margin > 0 ? (pnl / margin) * 100 : 0,
    margin,
    leverage: margin > 0 ? notional / margin : 0,
    liquidationPrice: toNumber(position.liquidationPrice),
    market: normalizePhoenixSymbol(position.symbol || position.marketSymbol || 'SOL'),
  };
}

function normalizeOrder(order: Record<string, unknown>, index: number): PhoenixOpenOrder {
  return {
    id: String(order.orderId ?? order.id ?? order.orderSequenceNumber ?? index),
    market: normalizePhoenixSymbol(String(order.symbol ?? order.marketSymbol ?? 'SOL')),
    side: String(order.side ?? 'unknown'),
    price: toNumber(order.price ?? order.priceUsd),
    size: Math.abs(toNumber(order.size ?? order.quantity ?? order.baseUnits ?? order.baseLots)),
    reduceOnly: Boolean(order.reduceOnly ?? order.isReduceOnly),
  };
}

function normalizeTrade(row: Record<string, unknown>, index: number): PhoenixTradeRecord {
  const size = toNumber(row.baseQty ?? row.baseAmount ?? row.quantity ?? row.size);
  return {
    id: String(row.id ?? row.transactionSignature ?? index),
    market: normalizePhoenixSymbol(String(row.marketSymbol ?? row.symbol ?? 'SOL')),
    side: String(row.side ?? (size >= 0 ? 'buy' : 'sell')),
    size: Math.abs(size),
    price: toNumber(row.price),
    pnl: row.pnl == null ? null : toNumber(row.pnl),
    status: String(row.status ?? 'filled'),
    createdAt: new Date(toNumber(row.timestamp ?? row.createdAt ?? Date.now())).toISOString(),
    txSig: typeof row.transactionSignature === 'string' ? row.transactionSignature : undefined,
  };
}

export async function fetchPhoenixTraderData(
  wallet: string,
  markPrice = 0,
): Promise<PhoenixTraderData> {
  const client = getPhoenixHttpClient();
  const [stateResult, snapshotResult, tradesResult, ordersResult] = await Promise.allSettled([
    client.traders().getTraderState(wallet) as unknown as Promise<TraderStateLike>,
    client.traders().getTraderStateSnapshot(wallet) as unknown as Promise<TraderStateLike>,
    client.trades().getTraderTradesHistory(wallet, { limit: 30 }) as unknown as Promise<HistoryResponse>,
    client.orders().getTraderOrderHistory(wallet, { limit: 30 }) as unknown as Promise<HistoryResponse>,
  ]);

  const state = stateResult.status === 'fulfilled' ? stateResult.value : null;
  const snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  const firstTrader = state?.traders?.[0];
  const firstSubaccount = snapshot?.snapshot?.subaccounts?.[0];
  const positions = firstTrader?.positions || firstSubaccount?.positions || [];
  const openOrders = firstTrader?.orders || firstSubaccount?.orders || [];
  const position = normalizePosition(positions[0], markPrice);
  const collateral = tokenUi(firstTrader?.collateralBalance ?? state?.collateralBalance);
  const effectiveCollateral = tokenUi(firstTrader?.effectiveCollateral ?? state?.effectiveCollateral);
  const unrealizedPnl = tokenUi(firstTrader?.unrealizedPnl ?? state?.unrealizedPnl);
  const initialMargin = tokenUi(firstTrader?.initialMargin ?? state?.initialMargin);
  const riskState =
    firstTrader?.riskState || state?.riskState || snapshot?.snapshot?.capabilities?.state || 'unknown';

  return {
    balance: {
      wallet,
      collateral,
      availableMargin: Math.max(0, effectiveCollateral - initialMargin),
      effectiveCollateral,
      maintenanceMargin: tokenUi(firstTrader?.maintenanceMargin ?? state?.maintenanceMargin),
      initialMargin,
      unrealizedPnl,
      riskState,
    },
    position,
    openOrders: (openOrders as Array<Record<string, unknown>>).map(normalizeOrder),
    trades:
      tradesResult.status === 'fulfilled'
        ? (tradesResult.value.data || []).map(normalizeTrade)
        : [],
    isActivated: riskState !== 'unknown',
  };
}

// ─── Order execution ──────────────────────────────────────────────────────────
type ApiAccountMeta = { pubkey: string; isSigner: boolean; isWritable: boolean };
type ApiInstructionResponse = { programId: string; data: number[]; keys: ApiAccountMeta[] };
type KitAccountMeta = { address?: string; role?: number | string };
type KitInstructionResponse = { programAddress?: string; data?: Uint8Array | number[]; accounts?: readonly KitAccountMeta[] };

function isWritableRole(role: unknown): boolean {
  if (typeof role === 'number') return role === 1 || role === 3;
  if (typeof role === 'string') return role.toLowerCase().includes('writable');
  return false;
}
function isSignerRole(role: unknown): boolean {
  if (typeof role === 'number') return role === 2 || role === 3;
  if (typeof role === 'string') return role.toLowerCase().includes('signer');
  return false;
}

function toTransactionInstruction(
  raw: ApiInstructionResponse | KitInstructionResponse,
): TransactionInstruction {
  const apiIx = raw as ApiInstructionResponse;
  if (apiIx.programId && apiIx.keys) {
    return new TransactionInstruction({
      programId: new PublicKey(apiIx.programId),
      keys: apiIx.keys.map((key) => ({
        pubkey: new PublicKey(key.pubkey),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      data: Buffer.from(apiIx.data),
    });
  }
  const kitIx = raw as KitInstructionResponse;
  if (!kitIx.programAddress || !kitIx.accounts || !kitIx.data) {
    throw new Error('Phoenix returned an unsupported instruction shape');
  }
  return new TransactionInstruction({
    programId: new PublicKey(kitIx.programAddress),
    keys: kitIx.accounts.map((account) => ({
      pubkey: new PublicKey(account.address || ''),
      isSigner: isSignerRole(account.role),
      isWritable: isWritableRole(account.role),
    })),
    data: Buffer.from(kitIx.data),
  });
}

function sideToPhoenix(side: 'long' | 'short'): 'bid' | 'ask' {
  return side === 'long' ? 'bid' : 'ask';
}

async function buildOrderInstructions(
  request: PhoenixOrderRequest,
): Promise<Array<ApiInstructionResponse | KitInstructionResponse>> {
  const client = getPhoenixHttpClient();
  const base = {
    authority: request.authority,
    symbol: normalizePhoenixSymbol(request.symbol),
    side: sideToPhoenix(request.side),
    quantity: request.quantity,
    isReduceOnly: !!request.reduceOnly,
    allowCrossAndIsolatedForAsset: true,
    transferAmount: request.transferAmount
      ? Math.max(0, Math.round(request.transferAmount * 1_000_000))
      : undefined,
  };
  if (request.orderType === 'limit') {
    if (!request.price || request.price <= 0) throw new Error('Limit price is required');
    return (await client.orders().placeIsolatedLimitOrder({
      ...base,
      price: request.price,
      isPostOnly: !!request.postOnly,
    })) as unknown as Array<ApiInstructionResponse | KitInstructionResponse>;
  }
  return (await client.orders().placeIsolatedMarketOrder(base)) as unknown as Array<
    ApiInstructionResponse | KitInstructionResponse
  >;
}

export interface PhoenixOrderResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/**
 * Build a Phoenix order via REST (returns instructions), then sign & send with
 * the user's in-app keypair. Mirrors the web flow but uses the Expo wallet.
 */
export async function executePhoenixOrder(
  request: PhoenixOrderRequest,
  keypair: Keypair,
): Promise<PhoenixOrderResult> {
  try {
    if (keypair.publicKey.toBase58() !== request.authority) {
      throw new Error('Wallet mismatch');
    }
    const instructions = await buildOrderInstructions(request);
    if (!instructions.length) throw new Error('Phoenix did not return any instructions');
    const parsedInstructions = instructions.map(toTransactionInstruction);
    await validatePhoenixInstructions(parsedInstructions, request, keypair.publicKey);

    const connection = getConnection();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({ feePayer: keypair.publicKey, recentBlockhash: blockhash });
    transaction.add(...parsedInstructions);
    transaction.sign(keypair);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed');
    return { success: true, signature };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Order failed' };
  }
}

export async function closePhoenixPosition(
  params: { authority: string; symbol: string; side: 'long' | 'short'; quantity: number },
  keypair: Keypair,
): Promise<PhoenixOrderResult> {
  return executePhoenixOrder(
    {
      authority: params.authority,
      symbol: params.symbol,
      side: params.side === 'long' ? 'short' : 'long',
      orderType: 'market',
      quantity: params.quantity,
      reduceOnly: true,
    },
    keypair,
  );
}
