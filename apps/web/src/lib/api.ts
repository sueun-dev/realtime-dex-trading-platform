/**
 * Typed REST client for the /api contract. Over the wire all 1e8 bigint values
 * are decimal strings (ARCHITECTURE.md); parse* helpers convert them back to
 * bigint. Money values never live in JS number.
 */
import { toUnits } from '@dex/shared';
import type { CandleInterval, MarketType, OrderStatus, OrderType, Side, TimeInForce } from '@dex/shared';

export const API_BASE = '/api';

// ---------------------------------------------------------------------------
// auth token plumbing (registered by lib/auth.ts to avoid an import cycle)
// ---------------------------------------------------------------------------

let tokenProvider: () => string | null = () => null;

export function setTokenProvider(fn: () => string | null): void {
  tokenProvider = fn;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const KO_ERROR_MESSAGES: Record<string, string> = {
  INVALID_ORDER: '잘못된 주문입니다',
  MARKET_NOT_FOUND: '마켓을 찾을 수 없습니다',
  ORDER_NOT_FOUND: '주문을 찾을 수 없습니다',
  INSUFFICIENT_BALANCE: '잔고가 부족합니다',
  INSUFFICIENT_MARGIN: '증거금이 부족합니다',
  POST_ONLY_WOULD_CROSS: 'Post Only 주문이 즉시 체결되어 거부되었습니다',
  FOK_NOT_FILLED: 'FOK 주문을 전량 체결할 수 없습니다',
  MIN_NOTIONAL: '최소 주문 금액보다 작습니다',
  TICK_SIZE: '가격 단위가 올바르지 않습니다',
  LOT_SIZE: '수량 단위가 올바르지 않습니다',
  SLIPPAGE_EXCEEDED: '슬리피지 한도를 초과했습니다',
  REDUCE_ONLY_VIOLATION: 'Reduce Only 조건을 위반했습니다',
  LEVERAGE_EXCEEDED: '최대 레버리지를 초과했습니다',
  LEVERAGE_IN_USE: '포지션 또는 주문이 있어 레버리지를 변경할 수 없습니다',
  NOT_AUTHORIZED: '권한이 없습니다',
  FAUCET_ALREADY_CLAIMED: '이미 테스트 자금을 받았습니다',
  DUPLICATE_CLIENT_ORDER_ID: '중복된 주문 ID입니다',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
  INTERNAL: '서버 오류가 발생했습니다',
};

/** Korean toast message for an API error (or anything thrown around fetch). */
export function koMessage(e: unknown): string {
  if (e instanceof ApiError) {
    return KO_ERROR_MESSAGES[e.code] ?? `오류가 발생했습니다 (${e.code})`;
  }
  if (e instanceof TypeError) return '서버에 연결할 수 없습니다';
  return '오류가 발생했습니다';
}

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
}

export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const token = tokenProvider();
  if (token !== null) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const errBody = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(errBody?.code ?? 'INTERNAL', errBody?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// wire types (bigint fields serialized as decimal strings)
// ---------------------------------------------------------------------------

export interface TickerWire {
  marketId: string;
  price: string;
  change24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  ts: number;
}

export interface MarketWire {
  id: string;
  type: MarketType;
  base: string;
  quote: string;
  koreanName: string | null;
  englishName: string | null;
  tickSize: string;
  lotSize: string;
  minNotional: string;
  makerFeeBps: number;
  takerFeeBps: number;
  maxLeverage: number;
  ticker?: TickerWire | null;
}

export interface BookLevelWire {
  price: string;
  qty: string;
}

export interface OrderbookWire {
  marketId: string;
  bids: BookLevelWire[];
  asks: BookLevelWire[];
  seq: number;
}

export interface TradeWire {
  id: string;
  marketId: string;
  price: string;
  qty: string;
  takerSide: Side;
  ts: number;
}

export interface CandleWire {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface BalanceWire {
  asset: string;
  available: string;
  locked: string;
}

export interface PositionWire {
  userId?: string;
  marketId: string;
  size: string;
  entryPrice: string;
  leverage: number;
  margin: string;
}

export interface AccountWire {
  address: string;
  balances: BalanceWire[];
  positions: PositionWire[];
  perpEquity: string;
  marginUsed: string;
}

export interface OrderWire {
  id: string;
  marketId: string;
  side: Side;
  type: OrderType;
  price: string | null;
  qty: string;
  filledQty: string;
  status: OrderStatus;
  tif: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  ts: number;
}

export interface FillWire {
  id?: string;
  marketId: string;
  price: string;
  qty: string;
  side?: Side;
  takerSide?: Side;
  fee?: string;
  ts: number;
}

export interface PlaceOrderBody {
  marketId: string;
  side: Side;
  type: OrderType;
  price: string;
  qty: string;
  tif: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
}

// ---------------------------------------------------------------------------
// parsed (bigint) app-side models
// ---------------------------------------------------------------------------

export interface Market {
  id: string;
  type: MarketType;
  base: string;
  quote: string;
  koreanName: string | null;
  englishName: string | null;
  tickSize: bigint;
  lotSize: bigint;
  minNotional: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  maxLeverage: number;
}

export interface TickerData {
  marketId: string;
  price: bigint;
  change24h: bigint;
  high24h: bigint;
  low24h: bigint;
  volume24h: bigint;
  ts: number;
}

export interface PositionData {
  marketId: string;
  size: bigint;
  entryPrice: bigint;
  leverage: number;
  margin: bigint;
}

export interface OrderData {
  id: string;
  marketId: string;
  side: Side;
  type: OrderType;
  price: bigint | null;
  qty: bigint;
  filledQty: bigint;
  status: OrderStatus;
  tif: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  ts: number;
}

export interface FillData {
  id: string;
  marketId: string;
  side: Side | null;
  price: bigint;
  qty: bigint;
  fee: bigint | null;
  ts: number;
}

export function parseMarket(w: MarketWire): Market {
  return {
    id: w.id,
    type: w.type,
    base: w.base,
    quote: w.quote,
    koreanName: w.koreanName ?? null,
    englishName: w.englishName ?? null,
    tickSize: toUnits(w.tickSize),
    lotSize: toUnits(w.lotSize),
    minNotional: toUnits(w.minNotional),
    makerFeeBps: w.makerFeeBps,
    takerFeeBps: w.takerFeeBps,
    maxLeverage: w.maxLeverage,
  };
}

export function parseTicker(w: TickerWire): TickerData {
  return {
    marketId: w.marketId,
    price: toUnits(w.price),
    change24h: toUnits(w.change24h),
    high24h: toUnits(w.high24h),
    low24h: toUnits(w.low24h),
    volume24h: toUnits(w.volume24h),
    ts: w.ts,
  };
}

export function isTickerWire(d: unknown): d is TickerWire {
  if (d === null || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return typeof o['marketId'] === 'string' && typeof o['price'] === 'string';
}

export function parsePosition(w: PositionWire): PositionData {
  return {
    marketId: w.marketId,
    size: toUnits(w.size),
    entryPrice: toUnits(w.entryPrice),
    leverage: w.leverage,
    margin: toUnits(w.margin),
  };
}

export function parseOrder(w: OrderWire): OrderData {
  return {
    id: w.id,
    marketId: w.marketId,
    side: w.side,
    type: w.type,
    price: w.price === null || w.price === undefined ? null : toUnits(w.price),
    qty: toUnits(w.qty),
    filledQty: toUnits(w.filledQty),
    status: w.status,
    tif: w.tif,
    postOnly: w.postOnly,
    reduceOnly: w.reduceOnly,
    ts: w.ts,
  };
}

export function parseFill(w: FillWire, index: number): FillData {
  return {
    id: w.id ?? `fill-${w.ts}-${index}`,
    marketId: w.marketId,
    side: w.side ?? w.takerSide ?? null,
    price: toUnits(w.price),
    qty: toUnits(w.qty),
    fee: w.fee !== undefined ? toUnits(w.fee) : null,
    ts: w.ts,
  };
}

/** Tolerate both bare arrays and `{key: [...]}` wrappers. */
function unwrapArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

export const api = {
  async markets(): Promise<MarketWire[]> {
    return unwrapArray<MarketWire>(await apiFetch<unknown>('/markets'), 'markets');
  },
  orderbook(marketId: string, depth = 20): Promise<OrderbookWire> {
    return apiFetch<OrderbookWire>(`/markets/${marketId}/orderbook?depth=${depth}`);
  },
  async trades(marketId: string, limit = 50): Promise<TradeWire[]> {
    return unwrapArray<TradeWire>(await apiFetch<unknown>(`/markets/${marketId}/trades?limit=${limit}`), 'trades');
  },
  async candles(marketId: string, interval: CandleInterval, limit = 200): Promise<CandleWire[]> {
    return unwrapArray<CandleWire>(
      await apiFetch<unknown>(`/markets/${marketId}/candles?interval=${interval}&limit=${limit}`),
      'candles',
    );
  },
  async account(): Promise<AccountWire> {
    const raw = await apiFetch<unknown>('/account');
    const obj = raw as Record<string, unknown> | null;
    if (obj !== null && typeof obj === 'object' && 'account' in obj && !('balances' in obj)) {
      return obj['account'] as AccountWire;
    }
    return raw as AccountWire;
  },
  faucet(): Promise<unknown> {
    return apiFetch<unknown>('/account/faucet', { method: 'POST' });
  },
  async openOrders(): Promise<OrderWire[]> {
    return unwrapArray<OrderWire>(await apiFetch<unknown>('/orders?status=open'), 'orders');
  },
  async fills(): Promise<FillWire[]> {
    return unwrapArray<FillWire>(await apiFetch<unknown>('/fills'), 'fills');
  },
  placeOrder(body: PlaceOrderBody): Promise<unknown> {
    return apiFetch<unknown>('/orders', { method: 'POST', body });
  },
  cancelOrder(orderId: string): Promise<unknown> {
    return apiFetch<unknown>(`/orders/${orderId}`, { method: 'DELETE' });
  },
  setLeverage(marketId: string, leverage: number): Promise<unknown> {
    return apiFetch<unknown>('/account/leverage', { method: 'POST', body: { marketId, leverage } });
  },
};
