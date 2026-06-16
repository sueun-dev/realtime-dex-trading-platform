/**
 * Randomized (property-style) projector tests.
 *
 * A seeded PRNG generates random engine-shaped event streams (every kind,
 * valid causal ordering: orders are accepted before they fill/cancel,
 * funding only hits open positions, liquidations close positions, ...).
 * Each stream is applied two ways:
 *   A) one clean applyBatch of the whole stream
 *   B) random contiguous batch partitions, interleaved with random
 *      overlapping re-deliveries of already-applied windows
 * and the resulting databases must be identical down to raw rows (incl.
 * bigserial ids). Final balances/positions are additionally cross-checked
 * against an independently-tracked model — positions.margin must equal the
 * last positionChanged's exact margin plus all funding payments since.
 *
 * Deterministic seeds keep failures reproducible without a fast-check dep.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SCALE, type EngineEvent, type Order, type Trade } from '@dex/shared';
import { Projector, createDb, createRepos, type DbHandle } from '../src/index.js';
import { dumpAll, mkOrder, positionChanged } from './fixtures.js';

const USERS = [
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
];
const SPOT = 'KRW-BTC';
const PERP = 'BTC-PERP';

/** mulberry32 — small deterministic PRNG, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

const pick = <T>(rng: () => number, arr: readonly T[]): T => {
  const v = arr[randInt(rng, 0, arr.length - 1)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
};

/** random bigint in [0, max] driven purely by the seeded rng. */
const randBig = (rng: () => number, max: bigint): bigint => {
  const a = BigInt(Math.floor(rng() * 0x40000000));
  const b = BigInt(Math.floor(rng() * 0x40000000));
  return ((a << 30n) | b) % (max + 1n);
};

interface PosModel {
  size: bigint;
  entryPrice: bigint;
  leverage: number;
  /** exact engine margin, or null when the stream's positionChanged was
   * contract-conforming (no margin addendum) — projected as SQL NULL */
  margin: bigint | null;
}

interface GenResult {
  events: EngineEvent[];
  /** expected final state, tracked independently of the projector */
  balances: Map<string, { available: bigint; locked: bigint }>; // `${user}|${asset}`
  positions: Map<string, PosModel>; // `${user}|${PERP}`
}

function genStream(rng: () => number, n: number): GenResult {
  const events: EngineEvent[] = [];
  const balances: GenResult['balances'] = new Map();
  const positions: GenResult['positions'] = new Map();
  const openOrders: Order[] = [];
  let seq = 0;
  const next = (): { seq: number; ts: number } => {
    seq += 1;
    return { seq, ts: 1_700_000_000_000 + seq };
  };

  const pushBalance = (): void => {
    const userId = pick(rng, USERS);
    const asset = pick(rng, ['KRW', 'USDC'] as const);
    const available = randBig(rng, 10n ** 16n);
    const locked = randBig(rng, 10n ** 14n);
    balances.set(`${userId}|${asset}`, { available, locked });
    const h = next();
    events.push({ kind: 'balanceChanged', ...h, userId, asset, available, locked, reason: 'deposit' });
  };

  const pushAccept = (): void => {
    const h = next();
    const order = mkOrder({
      id: `o${h.seq}`,
      userId: pick(rng, USERS),
      marketId: pick(rng, [SPOT, PERP] as const),
      side: pick(rng, ['buy', 'sell'] as const),
      price: (randBig(rng, 99_999n) + 1n) * SCALE,
      qty: (randBig(rng, 999n) + 1n) * (SCALE / 100n),
      seq: h.seq,
      ts: h.ts,
    });
    openOrders.push(order);
    events.push({ kind: 'orderAccepted', ...h, order });
  };

  const pushPosition = (): void => {
    const userId = pick(rng, USERS);
    const key = `${userId}|${PERP}`;
    const existing = positions.get(key);
    if (existing !== undefined && rng() < 0.35) {
      // close to zero — projector must delete the row (with or without the
      // margin addendum: a closed row carries no margin either way)
      const h = next();
      positions.delete(key);
      const realizedPnl = randBig(rng, 10n ** 12n) - 5n * 10n ** 11n;
      events.push(
        positionChanged({
          ...h,
          userId,
          marketId: PERP,
          size: 0n,
          entryPrice: 0n,
          leverage: existing.leverage,
          margin: 0n,
          realizedPnl,
        }),
      );
      return;
    }
    const size = (randBig(rng, 10n * SCALE) + 1n) * (rng() < 0.5 ? -1n : 1n);
    const entryPrice = (randBig(rng, 99_999n) + 1n) * SCALE;
    const leverage = randInt(rng, 1, 50);
    const h = next();
    // exact engine margin: arbitrary, intentionally unrelated to any formula
    const margin = randBig(rng, 10n ** 14n);
    positions.set(key, { size, entryPrice, leverage, margin });
    events.push(positionChanged({ ...h, userId, marketId: PERP, size, entryPrice, leverage, margin }));
  };

  const pushFunding = (): void => {
    const keys = [...positions.keys()];
    if (keys.length === 0) return pushPosition();
    const key = pick(rng, keys);
    const userId = key.split('|')[0];
    const pos = positions.get(key);
    if (userId === undefined || pos === undefined) throw new Error('unreachable');
    const payment = randBig(rng, 20n * SCALE) - 10n * SCALE; // signed
    // funding hits the isolated margin; unknown (null) + delta stays unknown
    if (pos.margin !== null) pos.margin += payment;
    const h = next();
    events.push({
      kind: 'fundingApplied',
      ...h,
      marketId: PERP,
      userId,
      rate: randBig(rng, 20_000n) - 10_000n,
      payment,
      markPrice: (randBig(rng, 99_999n) + 1n) * SCALE,
    });
  };

  const pushCancel = (): void => {
    if (openOrders.length === 0) return pushAccept();
    const idx = randInt(rng, 0, openOrders.length - 1);
    const [order] = openOrders.splice(idx, 1);
    if (order === undefined) throw new Error('unreachable');
    const h = next();
    events.push({
      kind: 'orderCancelled',
      ...h,
      orderId: order.id,
      userId: order.userId,
      marketId: order.marketId,
      remainingQty: order.qty - order.filledQty,
      reason: pick(rng, ['user', 'ioc', 'selfTrade'] as const),
    });
  };

  const pushTrade = (): void => {
    if (openOrders.length === 0) return pushAccept();
    const makerIdx = randInt(rng, 0, openOrders.length - 1);
    const maker = openOrders[makerIdx];
    if (maker === undefined) throw new Error('unreachable');

    const ha = next();
    const taker = mkOrder({
      id: `o${ha.seq}`,
      userId: pick(rng, USERS),
      marketId: maker.marketId,
      side: maker.side === 'buy' ? 'sell' : 'buy',
      price: maker.price,
      qty: maker.qty - maker.filledQty,
      seq: ha.seq,
      ts: ha.ts,
      tif: 'IOC',
    });
    events.push({ kind: 'orderAccepted', ...ha, order: taker });

    const remaining = maker.qty - maker.filledQty;
    const partialQty = remaining / 2n + 1n;
    const fillQty = rng() < 0.5 || partialQty >= remaining ? remaining : partialQty;
    const full = fillQty === remaining;
    const makerAfter: Order = {
      ...maker,
      filledQty: maker.filledQty + fillQty,
      status: full ? 'filled' : 'open',
    };
    if (full) openOrders.splice(makerIdx, 1);
    else openOrders[makerIdx] = makerAfter;

    const ht = next();
    const price = maker.price ?? SCALE;
    const notional = (price * fillQty) / SCALE;
    const trade: Trade = {
      id: `t${ht.seq}`,
      marketId: maker.marketId,
      price,
      qty: fillQty,
      takerSide: taker.side,
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      makerUserId: maker.userId,
      takerUserId: taker.userId,
      makerFee: (notional * 5n + 9999n) / 10_000n,
      takerFee: (notional * 10n + 9999n) / 10_000n,
      seq: ht.seq,
      ts: ht.ts,
    };
    events.push({
      kind: 'trade',
      ...ht,
      trade,
      makerOrder: makerAfter,
      takerOrder: { ...taker, filledQty: fillQty, status: 'filled' },
    });
  };

  const pushLiquidation = (): void => {
    const keys = [...positions.keys()];
    if (keys.length === 0) return pushPosition();
    const key = pick(rng, keys);
    const userId = key.split('|')[0];
    const pos = positions.get(key);
    if (userId === undefined || pos === undefined) throw new Error('unreachable');
    const markPrice = (randBig(rng, 99_999n) + 1n) * SCALE;
    const hl = next();
    events.push({ kind: 'liquidation', ...hl, userId, marketId: PERP, size: pos.size, markPrice, reason: 'maintenance' });
    positions.delete(key);
    const hp = next();
    events.push(
      positionChanged({
        ...hp,
        userId,
        marketId: PERP,
        size: 0n,
        entryPrice: 0n,
        leverage: pos.leverage,
        margin: 0n,
        realizedPnl: -randBig(rng, 10n ** 12n),
      }),
    );
    const available = randBig(rng, 10n ** 14n);
    balances.set(`${userId}|USDC`, { available, locked: 0n });
    const hb = next();
    events.push({
      kind: 'balanceChanged',
      ...hb,
      userId,
      asset: 'USDC',
      available,
      locked: 0n,
      reason: 'liquidation',
    });
  };

  const pushMisc = (): void => {
    const h = next();
    if (rng() < 0.5) {
      events.push({
        kind: 'markPrice',
        ...h,
        marketId: pick(rng, [SPOT, PERP] as const),
        price: (randBig(rng, 99_999n) + 1n) * SCALE,
      });
    } else {
      events.push({
        kind: 'orderRejected',
        ...h,
        userId: pick(rng, USERS),
        marketId: pick(rng, [SPOT, PERP] as const),
        code: 'INSUFFICIENT_BALANCE',
        reason: 'generated rejection',
        clientOrderId: rng() < 0.5 ? `c${h.seq}` : null,
      });
    }
  };

  const actions: ReadonlyArray<() => void> = [
    pushBalance,
    pushBalance,
    pushBalance,
    pushAccept,
    pushAccept,
    pushTrade,
    pushTrade,
    pushCancel,
    pushPosition,
    pushPosition,
    pushFunding,
    pushFunding,
    pushLiquidation,
    pushMisc,
  ];
  while (events.length < n) pick(rng, actions)();
  return { events, balances, positions };
}

/** Apply in random contiguous partitions + random overlapping re-deliveries. */
async function applyPartitioned(
  rng: () => number,
  events: EngineEvent[],
  projector: Projector,
): Promise<void> {
  let i = 0;
  while (i < events.length) {
    const end = Math.min(events.length, i + randInt(rng, 1, 40));
    await projector.applyBatch(events.slice(i, end));
    i = end;
    if (i > 0 && rng() < 0.35) {
      // re-deliver an already-applied window — must be a strict no-op
      const from = randInt(rng, 0, i - 1);
      const to = randInt(rng, from + 1, i);
      await projector.applyBatch(events.slice(from, to));
    }
  }
}

const handles: DbHandle[] = [];

async function freshDb(): Promise<DbHandle> {
  const h = await createDb();
  handles.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

describe('projector property: partition-independence + model equivalence', () => {
  it.each([[101], [20_260_610], [987_654_321]])(
    'seed %i: random stream — clean pass == random partitions w/ replays; model margins match',
    async (seed) => {
      const rng = mulberry32(seed);
      const { events, balances, positions } = genStream(rng, 220);
      expect(events.length).toBeGreaterThanOrEqual(220);
      events.forEach((e, i) => expect(e.seq).toBe(i + 1));

      const a = await freshDb();
      const b = await freshDb();
      await new Projector(a.db).applyBatch(events);
      await applyPartitioned(rng, events, new Projector(b.db));

      // raw-row equality across every table (incl. bigserial ids)
      expect(await dumpAll(b.pglite)).toEqual(await dumpAll(a.pglite));

      // model equivalence on the clean pass, via raw rows (works for streams
      // containing contract-conforming margin-less events too)
      const seqRow = await a.pglite.query<{ value: string }>(
        `select value from meta where key = 'last_applied_seq'`,
      );
      expect(Number(seqRow.rows[0]?.value)).toBe(events.length);

      const posRows = await a.pglite.query<{
        user_id: string;
        market_id: string;
        size: string;
        entry_price: string;
        leverage: number;
        margin: string | null;
      }>('select user_id, market_id, size, entry_price, leverage, margin from positions');
      const dbPositions = new Map(
        posRows.rows.map((r) => [
          `${r.user_id}|${r.market_id}`,
          {
            size: BigInt(r.size),
            entryPrice: BigInt(r.entry_price),
            leverage: r.leverage,
            margin: r.margin === null ? null : BigInt(r.margin),
          },
        ]),
      );
      expect(dbPositions).toEqual(positions);

      const balRows = await a.pglite.query<{
        user_id: string;
        asset: string;
        available: string;
        locked: string;
      }>('select user_id, asset, available, locked from balances');
      const dbBalances = new Map(
        balRows.rows.map((r) => [
          `${r.user_id}|${r.asset}`,
          { available: BigInt(r.available), locked: BigInt(r.locked) },
        ]),
      );
      expect(dbBalances).toEqual(balances);

      // every positionChanged now carries the exact engine margin, so
      // exact-Position reads and restore must always succeed
      const repos = createRepos(a.db);
      {
        const state = await repos.loadRestoreState();
        expect(state.lastSeq).toBe(events.length);
        const statePositions = new Map(
          state.positions.map((p) => [
            `${p.userId}|${p.marketId}`,
            { size: p.size, entryPrice: p.entryPrice, leverage: p.leverage, margin: p.margin },
          ]),
        );
        expect(statePositions).toEqual(positions);
        const stateBalances = new Map(
          state.balances.map((r) => [
            `${r.userId}|${r.asset}`,
            { available: r.available, locked: r.locked },
          ]),
        );
        expect(stateBalances).toEqual(balances);
      }
    },
    30_000,
  );
});
