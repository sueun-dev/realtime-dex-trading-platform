/**
 * Test fixtures: a hand-built, realistic synthetic engine event stream
 * covering EVERY EngineEvent kind, with events[i].seq === i + 1 so slices map
 * cleanly onto seq windows. Also a full-database dump helper for
 * replay-equality assertions.
 */
import type { PGlite } from '@electric-sql/pglite';
import {
  SCALE,
  type EngineEvent,
  type MarketConfig,
  type Order,
  type PositionChangedEvent,
  type Side,
  type Trade,
} from '@dex/shared';

export const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const SPOT = 'KRW-BTC';
export const PERP = 'BTC-PERP';
export const TS0 = 1_700_000_000_000;

export const SPOT_MARKET: MarketConfig = {
  id: SPOT,
  type: 'spot',
  base: 'BTC',
  quote: 'KRW',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  tickSize: 1000n * SCALE,
  lotSize: SCALE / 10_000n,
  minNotional: 5000n * SCALE,
  makerFeeBps: 5,
  takerFeeBps: 10,
  maxLeverage: 1,
};

export const PERP_MARKET: MarketConfig = {
  id: PERP,
  type: 'perp',
  base: 'BTC',
  quote: 'USDC',
  koreanName: null,
  englishName: null,
  tickSize: SCALE / 10n,
  lotSize: SCALE / 100_000n,
  minNotional: 10n * SCALE,
  makerFeeBps: 2,
  takerFeeBps: 5,
  maxLeverage: 50,
};

interface OrderInit {
  id: string;
  userId: string;
  marketId: string;
  side: Side;
  price: bigint | null;
  qty: bigint;
  seq: number;
  ts: number;
  filledQty?: bigint;
  status?: Order['status'];
  type?: Order['type'];
  tif?: Order['tif'];
  clientOrderId?: string | null;
}

interface PositionChangedInit {
  seq: number;
  ts: number;
  userId: string;
  marketId: string;
  size: bigint;
  entryPrice: bigint;
  leverage: number;
  /** engine's exact isolated margin AFTER the change (persisted verbatim) */
  margin: bigint;
  realizedPnl?: bigint;
}

/** Build a positionChanged event carrying the engine's exact margin. */
export function positionChanged(init: PositionChangedInit): PositionChangedEvent {
  return {
    kind: 'positionChanged',
    seq: init.seq,
    ts: init.ts,
    userId: init.userId,
    marketId: init.marketId,
    size: init.size,
    entryPrice: init.entryPrice,
    leverage: init.leverage,
    margin: init.margin,
    realizedPnl: init.realizedPnl ?? 0n,
  };
}

/**
 * Exact engine margins used in the fixture stream. Deliberately NOT equal to
 * the initial-margin formula |size| * entry / SCALE / leverage (5_000 / 2_500
 * / 10_200 USDC respectively) — fees and rounding make the engine's real
 * margin diverge, and the projector must persist the event value VERBATIM.
 */
export const ALICE_PERP_OPEN_MARGIN = 4_990n * SCALE + 3n;
export const BOB_PERP_OPEN_MARGIN = 2_475n * SCALE + 1n;
export const ALICE_PERP_FINAL_MARGIN = 10_173n * SCALE + 41n;
/** funding payment applied to each holder in the fixture stream (signed). */
export const ALICE_FUNDING_PAYMENT = -5n * SCALE;
export const BOB_FUNDING_PAYMENT = 5n * SCALE;

export function mkOrder(init: OrderInit): Order {
  return {
    id: init.id,
    userId: init.userId,
    marketId: init.marketId,
    side: init.side,
    type: init.type ?? 'limit',
    price: init.price,
    qty: init.qty,
    filledQty: init.filledQty ?? 0n,
    status: init.status ?? 'open',
    tif: init.tif ?? 'GTC',
    postOnly: false,
    reduceOnly: false,
    clientOrderId: init.clientOrderId ?? null,
    seq: init.seq,
    ts: init.ts,
  };
}

/**
 * Build the synthetic stream. ~221 events, seq = index + 1.
 * Covers: orderAccepted, orderRejected, orderCancelled, trade,
 * balanceChanged, positionChanged (open / increase / close-to-zero),
 * liquidation, fundingApplied, markPrice.
 */
export function buildStream(): EngineEvent[] {
  const events: EngineEvent[] = [];
  let seq = 0;
  const next = (): { seq: number; ts: number } => {
    seq += 1;
    return { seq, ts: TS0 + seq };
  };

  // --- A) faucet-style deposits (absolute balances) -------------------------
  let aliceKrw = 100_000_000n * SCALE;
  let bobKrw = 100_000_000n * SCALE;
  const usdc = 100_000n * SCALE;
  for (const [userId, asset, available] of [
    [ALICE, 'KRW', aliceKrw],
    [ALICE, 'USDC', usdc],
    [BOB, 'KRW', bobKrw],
    [BOB, 'USDC', usdc],
  ] as const) {
    const h = next();
    events.push({
      kind: 'balanceChanged',
      ...h,
      userId,
      asset,
      available,
      locked: 0n,
      reason: 'faucet',
    });
  }

  // --- B) initial mark prices ------------------------------------------------
  {
    const h = next();
    events.push({ kind: 'markPrice', ...h, marketId: PERP, price: 50_000n * SCALE });
  }
  {
    const h = next();
    events.push({ kind: 'markPrice', ...h, marketId: SPOT, price: 93_000_000n * SCALE });
  }

  // --- C) 38 fully-filled spot round trips (5 events each = 190) -------------
  let aliceBtc = 0n;
  for (let i = 0; i < 38; i++) {
    const price = (93_000_000n + BigInt(i) * 1000n) * SCALE;
    const qty = SCALE / 100n; // 0.01 BTC
    const notional = (price * qty) / SCALE;

    const ha = next();
    const makerOrder = mkOrder({
      id: `o${ha.seq}`,
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price,
      qty,
      seq: ha.seq,
      ts: ha.ts,
      clientOrderId: i % 7 === 0 ? `alice-spot-${i}` : null,
    });
    events.push({ kind: 'orderAccepted', ...ha, order: makerOrder });

    const hb = next();
    const takerOrder = mkOrder({
      id: `o${hb.seq}`,
      userId: BOB,
      marketId: SPOT,
      side: 'sell',
      price,
      qty,
      seq: hb.seq,
      ts: hb.ts,
      tif: 'IOC',
    });
    events.push({ kind: 'orderAccepted', ...hb, order: takerOrder });

    const ht = next();
    const makerFee = (notional * 5n + 9999n) / 10_000n;
    const takerFee = (notional * 10n + 9999n) / 10_000n;
    const trade: Trade = {
      id: `t${ht.seq}`,
      marketId: SPOT,
      price,
      qty,
      takerSide: 'sell',
      makerOrderId: makerOrder.id,
      takerOrderId: takerOrder.id,
      makerUserId: ALICE,
      takerUserId: BOB,
      makerFee,
      takerFee,
      seq: ht.seq,
      ts: ht.ts,
    };
    events.push({
      kind: 'trade',
      ...ht,
      trade,
      makerOrder: { ...makerOrder, filledQty: qty, status: 'filled' },
      takerOrder: { ...takerOrder, filledQty: qty, status: 'filled' },
    });

    aliceKrw -= notional + makerFee;
    aliceBtc += qty;
    bobKrw += notional - takerFee;
    const h1 = next();
    events.push({
      kind: 'balanceChanged',
      ...h1,
      userId: ALICE,
      asset: 'KRW',
      available: aliceKrw,
      locked: 0n,
      reason: 'trade',
    });
    const h2 = next();
    events.push({
      kind: 'balanceChanged',
      ...h2,
      userId: BOB,
      asset: 'KRW',
      available: bobKrw,
      locked: 0n,
      reason: 'trade',
    });
  }

  // --- D) accept + user-cancel ------------------------------------------------
  let cancelTarget: Order;
  {
    const h = next();
    cancelTarget = mkOrder({
      id: `o${h.seq}`,
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price: 90_000_000n * SCALE,
      qty: SCALE / 10n,
      seq: h.seq,
      ts: h.ts,
    });
    events.push({ kind: 'orderAccepted', ...h, order: cancelTarget });
  }
  {
    const h = next();
    events.push({
      kind: 'orderCancelled',
      ...h,
      orderId: cancelTarget.id,
      userId: ALICE,
      marketId: SPOT,
      remainingQty: cancelTarget.qty,
      reason: 'user',
    });
  }

  // --- E) partial fill, maker stays open --------------------------------------
  {
    const price = 92_000_000n * SCALE;
    const ha = next();
    const maker = mkOrder({
      id: `o${ha.seq}`,
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price,
      qty: SCALE / 50n, // 0.02
      seq: ha.seq,
      ts: ha.ts,
    });
    events.push({ kind: 'orderAccepted', ...ha, order: maker });

    const hb = next();
    const taker = mkOrder({
      id: `o${hb.seq}`,
      userId: BOB,
      marketId: SPOT,
      side: 'sell',
      price,
      qty: SCALE / 100n, // 0.01
      seq: hb.seq,
      ts: hb.ts,
      tif: 'IOC',
    });
    events.push({ kind: 'orderAccepted', ...hb, order: taker });

    const ht = next();
    const qty = SCALE / 100n;
    const notional = (price * qty) / SCALE;
    const trade: Trade = {
      id: `t${ht.seq}`,
      marketId: SPOT,
      price,
      qty,
      takerSide: 'sell',
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      makerUserId: ALICE,
      takerUserId: BOB,
      makerFee: (notional * 5n + 9999n) / 10_000n,
      takerFee: (notional * 10n + 9999n) / 10_000n,
      seq: ht.seq,
      ts: ht.ts,
    };
    events.push({
      kind: 'trade',
      ...ht,
      trade,
      makerOrder: { ...maker, filledQty: qty, status: 'open' }, // partial — still open
      takerOrder: { ...taker, filledQty: qty, status: 'filled' },
    });
  }

  // --- F) resting open orders (restore-state material) -------------------------
  for (const [userId, side, px] of [
    [ALICE, 'buy', 91_000_000n],
    [BOB, 'sell', 95_000_000n],
    [ALICE, 'buy', 90_500_000n],
  ] as const) {
    const h = next();
    events.push({
      kind: 'orderAccepted',
      ...h,
      order: mkOrder({
        id: `o${h.seq}`,
        userId,
        marketId: SPOT,
        side,
        price: px * SCALE,
        qty: SCALE / 100n,
        seq: h.seq,
        ts: h.ts,
      }),
    });
  }

  // --- G) perp: open positions, funding, liquidation ---------------------------
  const perpPrice = 50_000n * SCALE;
  {
    const ha = next();
    const maker = mkOrder({
      id: `o${ha.seq}`,
      userId: ALICE,
      marketId: PERP,
      side: 'buy',
      price: perpPrice,
      qty: SCALE, // 1 BTC
      seq: ha.seq,
      ts: ha.ts,
    });
    events.push({ kind: 'orderAccepted', ...ha, order: maker });

    const hb = next();
    const taker = mkOrder({
      id: `o${hb.seq}`,
      userId: BOB,
      marketId: PERP,
      side: 'sell',
      price: perpPrice,
      qty: SCALE,
      seq: hb.seq,
      ts: hb.ts,
      tif: 'IOC',
    });
    events.push({ kind: 'orderAccepted', ...hb, order: taker });

    const ht = next();
    const notional = (perpPrice * SCALE) / SCALE;
    const trade: Trade = {
      id: `t${ht.seq}`,
      marketId: PERP,
      price: perpPrice,
      qty: SCALE,
      takerSide: 'sell',
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      makerUserId: ALICE,
      takerUserId: BOB,
      makerFee: (notional * 2n + 9999n) / 10_000n,
      takerFee: (notional * 5n + 9999n) / 10_000n,
      seq: ht.seq,
      ts: ht.ts,
    };
    events.push({
      kind: 'trade',
      ...ht,
      trade,
      makerOrder: { ...maker, filledQty: SCALE, status: 'filled' },
      takerOrder: { ...taker, filledQty: SCALE, status: 'filled' },
    });

    const hp1 = next();
    events.push(
      positionChanged({
        ...hp1,
        userId: ALICE,
        marketId: PERP,
        size: SCALE, // long 1 BTC
        entryPrice: perpPrice,
        leverage: 10,
        margin: ALICE_PERP_OPEN_MARGIN, // exact engine margin (≠ IM formula)
      }),
    );
    const hp2 = next();
    events.push(
      positionChanged({
        ...hp2,
        userId: BOB,
        marketId: PERP,
        size: -SCALE, // short 1 BTC (negative size!)
        entryPrice: perpPrice,
        leverage: 20,
        margin: BOB_PERP_OPEN_MARGIN,
      }),
    );
    const hb1 = next();
    events.push({
      kind: 'balanceChanged',
      ...hb1,
      userId: ALICE,
      asset: 'USDC',
      available: usdc - 5001n * SCALE,
      locked: 0n,
      reason: 'trade',
    });
    const hb2 = next();
    events.push({
      kind: 'balanceChanged',
      ...hb2,
      userId: BOB,
      asset: 'USDC',
      available: usdc - 2526n * SCALE,
      locked: 0n,
      reason: 'trade',
    });
  }

  // hourly funding: longs pay (rate > 0) — erodes/credits position margin
  {
    const rate = 10_000n; // 0.0001 in 1e8 units
    const hf1 = next();
    events.push({
      kind: 'fundingApplied',
      ...hf1,
      marketId: PERP,
      userId: ALICE,
      rate,
      payment: ALICE_FUNDING_PAYMENT,
      markPrice: perpPrice,
    });
    const hf2 = next();
    events.push({
      kind: 'fundingApplied',
      ...hf2,
      marketId: PERP,
      userId: BOB,
      rate,
      payment: BOB_FUNDING_PAYMENT,
      markPrice: perpPrice,
    });
  }

  // alice doubles up at a higher price → VWAP entry; the event's absolute
  // exact margin (already net of the funding payment above) wins verbatim
  {
    const h = next();
    events.push(
      positionChanged({
        ...h,
        userId: ALICE,
        marketId: PERP,
        size: 2n * SCALE,
        entryPrice: 51_000n * SCALE,
        leverage: 10,
        margin: ALICE_PERP_FINAL_MARGIN,
      }),
    );
  }

  // mark price spikes → bob's short is liquidated (position closes to 0)
  const liqPrice = 53_000n * SCALE;
  {
    const hm = next();
    events.push({ kind: 'markPrice', ...hm, marketId: PERP, price: liqPrice });
    const hl = next();
    events.push({
      kind: 'liquidation',
      ...hl,
      userId: BOB,
      marketId: PERP,
      size: -SCALE,
      markPrice: liqPrice,
    });
    const hp = next();
    events.push(
      positionChanged({
        ...hp,
        userId: BOB,
        marketId: PERP,
        size: 0n, // closed — row must be DELETED
        entryPrice: 0n,
        leverage: 20,
        margin: 0n,
        realizedPnl: -3000n * SCALE,
      }),
    );
    const hb = next();
    events.push({
      kind: 'balanceChanged',
      ...hb,
      userId: BOB,
      asset: 'USDC',
      available: usdc - 5526n * SCALE,
      locked: 0n,
      reason: 'liquidation',
    });
  }

  // --- H) a rejection (must be a strict no-op) ---------------------------------
  {
    const h = next();
    events.push({
      kind: 'orderRejected',
      ...h,
      userId: BOB,
      marketId: PERP,
      code: 'INSUFFICIENT_MARGIN',
      reason: 'not enough free collateral',
      clientOrderId: 'bob-rejected-1',
    });
  }

  // final spot mark price update (meta upsert overwrite path)
  {
    const h = next();
    events.push({ kind: 'markPrice', ...h, marketId: SPOT, price: 93_037_000n * SCALE });
  }

  return events;
}

const DUMP_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['users', 'id'],
  ['markets', 'id'],
  ['balances', 'user_id, asset'],
  ['orders', 'id'],
  ['trades', 'id'],
  ['positions', 'user_id, market_id'],
  ['user_market_leverage', 'user_id, market_id'],
  ['funding_payments', 'id'],
  ['liquidations', 'id'],
  ['auth_nonces', 'address, nonce'],
  ['candles_cache', 'market_id, "interval", t'],
  ['meta', 'key'],
];

/**
 * Deterministically dump every table (raw driver values). The interpolated
 * table/order-by names are compile-time constants from DUMP_TABLES —
 * identifiers cannot be bound as SQL parameters. Never interpolate runtime
 * values here; data-valued predicates must use bound parameters.
 */
export async function dumpAll(pglite: PGlite): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, orderBy] of DUMP_TABLES) {
    const res = await pglite.query<Record<string, unknown>>(
      `select * from ${table} order by ${orderBy}`,
    );
    out[table] = res.rows;
  }
  return out;
}
