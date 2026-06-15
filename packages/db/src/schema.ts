/**
 * Drizzle pg-core schema for the @dex/db projection store.
 *
 * Conventions:
 * - All money/price/qty columns are `numeric(38,0)` holding 1e8 fixed-point
 *   bigint units. Drizzle's `mode: 'bigint'` maps them bigint <-> string at
 *   the driver edge (BigInt()/String()), so no float ever touches money.
 * - seq / timestamps are `bigint` (int8) read as JS numbers (epoch ms / engine
 *   seq are far below 2^53).
 * - The authoritative DDL lives in migrations.ts; this schema must match it.
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
} from 'drizzle-orm/pg-core';
import type {
  CandleInterval,
  MarketType,
  OrderStatus,
  OrderType,
  Side,
  TimeInForce,
} from '@dex/shared';

/** numeric(38,0) <-> bigint 1e8 fixed-point units. */
const money = (name: string) => numeric(name, { precision: 38, scale: 0, mode: 'bigint' });

export const users = pgTable('users', {
  /** lowercase ethereum address */
  id: text('id').primaryKey(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  faucetClaimedAt: bigint('faucet_claimed_at', { mode: 'number' }),
});

export const markets = pgTable('markets', {
  id: text('id').primaryKey(),
  type: text('type').$type<MarketType>().notNull(),
  base: text('base').notNull(),
  quote: text('quote').notNull(),
  koreanName: text('korean_name'),
  englishName: text('english_name'),
  tickSize: money('tick_size').notNull(),
  lotSize: money('lot_size').notNull(),
  minNotional: money('min_notional').notNull(),
  makerFeeBps: integer('maker_fee_bps').notNull(),
  takerFeeBps: integer('taker_fee_bps').notNull(),
  maxLeverage: integer('max_leverage').notNull(),
});

export const balances = pgTable(
  'balances',
  {
    userId: text('user_id').notNull(),
    asset: text('asset').notNull(),
    available: money('available').notNull(),
    locked: money('locked').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.asset] })],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    marketId: text('market_id').notNull(),
    side: text('side').$type<Side>().notNull(),
    type: text('type').$type<OrderType>().notNull(),
    price: money('price'),
    qty: money('qty').notNull(),
    filledQty: money('filled_qty').notNull(),
    status: text('status').$type<OrderStatus>().notNull(),
    tif: text('tif').$type<TimeInForce>().notNull(),
    postOnly: boolean('post_only').notNull(),
    reduceOnly: boolean('reduce_only').notNull(),
    clientOrderId: text('client_order_id'),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('orders_user_status_idx').on(t.userId, t.status),
    index('orders_market_status_idx').on(t.marketId, t.status),
    index('orders_market_seq_idx').on(t.marketId, t.seq),
  ],
);

export const trades = pgTable(
  'trades',
  {
    id: text('id').primaryKey(),
    marketId: text('market_id').notNull(),
    price: money('price').notNull(),
    qty: money('qty').notNull(),
    takerSide: text('taker_side').$type<Side>().notNull(),
    makerOrderId: text('maker_order_id').notNull(),
    takerOrderId: text('taker_order_id').notNull(),
    makerUserId: text('maker_user_id').notNull(),
    takerUserId: text('taker_user_id').notNull(),
    makerFee: money('maker_fee').notNull(),
    takerFee: money('taker_fee').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    ts: bigint('ts', { mode: 'number' }).notNull(),
  },
  (t) => [index('trades_market_seq_idx').on(t.marketId, t.seq)],
);

export const positions = pgTable(
  'positions',
  {
    userId: text('user_id').notNull(),
    marketId: text('market_id').notNull(),
    /** signed base qty (1e8 units): > 0 long, < 0 short */
    size: money('size').notNull(),
    entryPrice: money('entry_price').notNull(),
    leverage: integer('leverage').notNull(),
    /** engine's EXACT isolated margin, verbatim from PositionChangedEvent.margin */
    margin: money('margin').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.marketId] })],
);

export const userMarketLeverage = pgTable(
  'user_market_leverage',
  {
    userId: text('user_id').notNull(),
    marketId: text('market_id').notNull(),
    leverage: integer('leverage').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.marketId] })],
);

export const fundingPayments = pgTable('funding_payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  marketId: text('market_id').notNull(),
  userId: text('user_id').notNull(),
  /** signed 1e8 funding rate */
  rate: money('rate').notNull(),
  /** signed USDC payment applied to the user (negative = paid) */
  payment: money('payment').notNull(),
  markPrice: money('mark_price').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
});

export const liquidations = pgTable('liquidations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: text('user_id').notNull(),
  marketId: text('market_id').notNull(),
  /** signed position size that was force-closed */
  size: money('size').notNull(),
  markPrice: money('mark_price').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  ts: bigint('ts', { mode: 'number' }).notNull(),
});

export const authNonces = pgTable(
  'auth_nonces',
  {
    address: text('address').notNull(),
    nonce: text('nonce').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.address, t.nonce] })],
);

export const candlesCache = pgTable(
  'candles_cache',
  {
    marketId: text('market_id').notNull(),
    interval: text('interval').$type<CandleInterval>().notNull(),
    /** bucket open time, epoch ms */
    t: bigint('t', { mode: 'number' }).notNull(),
    o: money('o').notNull(),
    h: money('h').notNull(),
    l: money('l').notNull(),
    c: money('c').notNull(),
    v: money('v').notNull(),
    fetchedAt: bigint('fetched_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.interval, t.t] })],
);

/**
 * Key/value metadata. Keys in use:
 * - 'last_applied_seq' -> last engine event seq applied by the projector
 * - 'mark:<marketId>'  -> latest mark price (decimal string of 1e8 units)
 */
export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
