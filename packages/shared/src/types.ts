export type Side = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'rejected';
export type MarketType = 'spot' | 'perp';

export interface MarketConfig {
  /** spot: '<BASE>-USDC' (mirrors Upbit 'USDT-<BASE>'); perp: '<BASE>-PERP' */
  id: string;
  type: MarketType;
  base: string;
  quote: string; // always 'USDC' — a DEX settles in a stablecoin, no fiat
  koreanName: string | null;
  englishName: string | null;
  /** price increment, 1e8 units */
  tickSize: bigint;
  /** qty increment, 1e8 units */
  lotSize: bigint;
  /** minimum order notional in quote, 1e8 units */
  minNotional: bigint;
  makerFeeBps: number;
  takerFeeBps: number;
  /** 1 for spot */
  maxLeverage: number;
}

export interface OrderRequest {
  marketId: string;
  side: Side;
  type: OrderType;
  /** limit: required. market: optional slippage bound (worst acceptable price). */
  price?: bigint;
  /** base qty, 1e8 units */
  qty: bigint;
  tif: TimeInForce;
  postOnly?: boolean;
  /** perp only */
  reduceOnly?: boolean;
  clientOrderId?: string;
}

export interface Order {
  id: string;
  userId: string;
  marketId: string;
  side: Side;
  type: OrderType;
  /** null for market orders without slippage bound */
  price: bigint | null;
  qty: bigint;
  filledQty: bigint;
  status: OrderStatus;
  tif: TimeInForce;
  postOnly: boolean;
  reduceOnly: boolean;
  clientOrderId: string | null;
  /** engine sequence at acceptance — total order over all events */
  seq: number;
  /** epoch ms, supplied by caller (engine is deterministic) */
  ts: number;
}

export interface Trade {
  id: string;
  marketId: string;
  price: bigint;
  qty: bigint;
  /** aggressor side */
  takerSide: Side;
  makerOrderId: string;
  takerOrderId: string;
  makerUserId: string;
  takerUserId: string;
  /** fee charged in quote currency, 1e8 units */
  makerFee: bigint;
  takerFee: bigint;
  seq: number;
  ts: number;
}

export interface Balance {
  asset: string;
  available: bigint;
  locked: bigint;
}

export interface Position {
  userId: string;
  marketId: string;
  /** signed base qty: > 0 long, < 0 short, never 0 (flat positions are removed) */
  size: bigint;
  /** volume-weighted entry price, 1e8 units */
  entryPrice: bigint;
  /** user-chosen leverage for IM on this market */
  leverage: number;
  /** isolated margin allocated to this position, 1e8 USDC units */
  margin: bigint;
}

export interface BookLevel {
  price: bigint;
  qty: bigint;
}

export interface OrderbookSnapshot {
  marketId: string;
  bids: BookLevel[]; // descending price
  asks: BookLevel[]; // ascending price
  seq: number;
}

export interface Ticker {
  marketId: string;
  /** last traded / mid price, 1e8 units */
  price: bigint;
  /** 24h change rate, 1e8 units (0.05 → 5e6) */
  change24h: bigint;
  high24h: bigint;
  low24h: bigint;
  /** 24h quote volume, 1e8 units */
  volume24h: bigint;
  ts: number;
}

export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Candle {
  /** bucket open time, epoch ms */
  t: number;
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
  /** base volume, 1e8 units */
  v: bigint;
}

export interface AccountSummary {
  address: string;
  balances: Balance[];
  positions: Position[];
  /** USDC equity = USDC balance + Σ unrealized PnL (1e8 units) */
  perpEquity: bigint;
  /** Σ initial margin in use */
  marginUsed: bigint;
}

/** A DEX settles in a stablecoin — every market quotes/collateralizes in USDC. */
export const SPOT_QUOTE = 'USDC';
export const PERP_QUOTE = 'USDC';
export const COLLATERAL = 'USDC';
export const FEE_ACCOUNT = '__fees__';
/** Internal clearinghouse book-entry account for perp PnL cash flows (may go negative). */
export const CLEARING_ACCOUNT = '__clearing__';

/** House commission: flat 0.02% (2 bps) on every fill, both roles, all markets. */
export const SPOT_MAKER_FEE_BPS = 2;
export const SPOT_TAKER_FEE_BPS = 2;
export const PERP_MAKER_FEE_BPS = 2;
export const PERP_TAKER_FEE_BPS = 2;

/** Single demo collateral: $100,000 USDC, used for both spot and perps. */
export const FAUCET_USDC = 100_000n * 10n ** 8n; // $100,000
