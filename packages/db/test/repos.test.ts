import { afterEach, describe, expect, it } from 'vitest';
import { SCALE, type Candle, type EngineEvent, type Order, type Trade } from '@dex/shared';
import { Projector, createDb, createRepos, type DbHandle } from '../src/index.js';
import { ALICE, BOB, PERP, SPOT, mkOrder, positionChanged } from './fixtures.js';

let handle: DbHandle | undefined;

async function setup() {
  handle = await createDb();
  return {
    db: handle.db,
    pglite: handle.pglite,
    projector: new Projector(handle.db),
    repos: createRepos(handle.db),
  };
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('users repo', () => {
  it('getOrCreate inserts once, normalizes case, and is stable across calls', async () => {
    const { repos } = await setup();
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const created = await repos.users.getOrCreate(mixed, 1111);
    expect(created.id).toBe(mixed.toLowerCase());
    expect(created.createdAt).toBe(1111);
    expect(created.faucetClaimedAt).toBeNull();

    const again = await repos.users.getOrCreate(mixed.toUpperCase().replace('0X', '0x'), 2222);
    expect(again.createdAt).toBe(1111); // not overwritten

    expect(await repos.users.get('0xdoesnotexist')).toBeUndefined();
  });

  it('setFaucetClaimed records the claim timestamp', async () => {
    const { repos } = await setup();
    await repos.users.getOrCreate(ALICE, 1000);
    await repos.users.setFaucetClaimed(ALICE, 5000);
    const row = await repos.users.get(ALICE);
    expect(row?.faucetClaimedAt).toBe(5000);
  });

  it('claimFaucet is an atomic compare-and-set — exactly one of N concurrent claims wins', async () => {
    const { repos } = await setup();
    await repos.users.getOrCreate(ALICE, 1000);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repos.users.claimFaucet(ALICE, 5000 + i)),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one winner
    expect((await repos.users.get(ALICE))?.faucetClaimedAt).not.toBeNull();
    // a later claim never wins again
    expect(await repos.users.claimFaucet(ALICE, 9999)).toBe(false);
  });
});

describe('nonces repo', () => {
  it('consume is single-use', async () => {
    const { repos } = await setup();
    await repos.nonces.issue(ALICE, 'nonce-1', 60_000, 1_000_000);
    expect(await repos.nonces.consume(ALICE, 'nonce-1', 1_030_000)).toBe(true);
    expect(await repos.nonces.consume(ALICE, 'nonce-1', 1_030_001)).toBe(false); // replay
  });

  it('expired nonces cannot be consumed and wrong address/nonce fails', async () => {
    const { repos } = await setup();
    await repos.nonces.issue(ALICE, 'nonce-2', 60_000, 1_000_000);
    expect(await repos.nonces.consume(ALICE, 'nonce-2', 1_060_001)).toBe(false); // expired
    await repos.nonces.issue(ALICE, 'nonce-3', 60_000, 1_000_000);
    expect(await repos.nonces.consume(BOB, 'nonce-3', 1_000_001)).toBe(false); // wrong address
    expect(await repos.nonces.consume(ALICE, 'nope', 1_000_001)).toBe(false); // unknown nonce
    expect(await repos.nonces.consume(ALICE, 'nonce-3', 1_000_001)).toBe(true); // still intact
  });

  it('sweepExpired garbage-collects only expired rows and reports the count', async () => {
    const { repos, pglite } = await setup();
    await repos.nonces.issue(ALICE, 'old-1', 60_000, 1_000_000); // expires 1_060_000
    await repos.nonces.issue(ALICE, 'old-2', 30_000, 1_000_000); // expires 1_030_000
    await repos.nonces.issue(BOB, 'fresh', 60_000, 1_050_000); //   expires 1_110_000

    expect(await repos.nonces.sweepExpired(1_060_000)).toBe(2); // both old rows (<= now)
    expect(await repos.nonces.sweepExpired(1_060_000)).toBe(0); // idempotent

    // the live nonce survived and still works
    const left = await pglite.query<{ nonce: string }>('select nonce from auth_nonces');
    expect(left.rows).toEqual([{ nonce: 'fresh' }]);
    expect(await repos.nonces.consume(BOB, 'fresh', 1_060_001)).toBe(true);
  });
});

describe('candles repo', () => {
  const c = (t: number, close: bigint): Candle => ({
    t,
    o: 100n * SCALE,
    h: 110n * SCALE,
    l: 90n * SCALE,
    c: close,
    v: 12n * SCALE,
  });

  it('put + get returns ascending t, limited to the most recent buckets', async () => {
    const { repos } = await setup();
    await repos.candles.put(SPOT, '1m', [c(3000, 103n), c(1000, 101n), c(2000, 102n)], 9999);
    const all = await repos.candles.get(SPOT, '1m', 10);
    expect(all.map((x) => x.t)).toEqual([1000, 2000, 3000]);
    expect(all.map((x) => x.c)).toEqual([101n, 102n, 103n]);

    const latest2 = await repos.candles.get(SPOT, '1m', 2);
    expect(latest2.map((x) => x.t)).toEqual([2000, 3000]); // newest two, still ascending
  });

  it('re-putting the same bucket overwrites OHLCV (upsert)', async () => {
    const { repos, pglite } = await setup();
    await repos.candles.put(SPOT, '5m', [c(1000, 101n)], 1);
    await repos.candles.put(SPOT, '5m', [{ ...c(1000, 999n), h: 1000n }], 2);
    const rows = await repos.candles.get(SPOT, '5m', 10);
    expect(rows).toEqual([{ t: 1000, o: 100n * SCALE, h: 1000n, l: 90n * SCALE, c: 999n, v: 12n * SCALE }]);
    const fetched = await pglite.query<{ fetched_at: number }>(
      'select fetched_at from candles_cache where market_id = $1',
      [SPOT],
    );
    expect(Number(fetched.rows[0]?.fetched_at)).toBe(2);
  });

  it('intervals and markets are isolated', async () => {
    const { repos } = await setup();
    await repos.candles.put(SPOT, '1m', [c(1000, 1n)], 1);
    await repos.candles.put(SPOT, '1h', [c(1000, 2n)], 1);
    await repos.candles.put(PERP, '1m', [c(1000, 3n)], 1);
    expect((await repos.candles.get(SPOT, '1m', 10))[0]?.c).toBe(1n);
    expect((await repos.candles.get(SPOT, '1h', 10))[0]?.c).toBe(2n);
    expect((await repos.candles.get(PERP, '1m', 10))[0]?.c).toBe(3n);
    expect(await repos.candles.get(PERP, '1h', 10)).toEqual([]);
  });
});

describe('leverage repo', () => {
  it('defaults to 1, set() upserts', async () => {
    const { repos } = await setup();
    expect(await repos.leverage.get(ALICE, PERP)).toBe(1);
    await repos.leverage.set(ALICE, PERP, 5);
    expect(await repos.leverage.get(ALICE, PERP)).toBe(5);
    await repos.leverage.set(ALICE, PERP, 20); // update path
    expect(await repos.leverage.get(ALICE, PERP)).toBe(20);
    expect(await repos.leverage.get(BOB, PERP)).toBe(1); // others unaffected
    await expect(repos.leverage.set(ALICE, PERP, 0)).rejects.toThrow(RangeError);
  });
});

describe('orders + trades repos', () => {
  async function seedOrdersAndTrades(projector: Projector) {
    const events: EngineEvent[] = [];
    let seq = 0;
    const accept = (order: Order) => {
      events.push({ kind: 'orderAccepted', seq: order.seq, ts: order.ts, order });
    };
    const mk = (userId: string, marketId: string, side: 'buy' | 'sell', price: bigint) => {
      seq += 1;
      return mkOrder({
        id: `o${seq}`,
        userId,
        marketId,
        side,
        price,
        qty: SCALE / 100n,
        seq,
        ts: 1000 + seq,
      });
    };
    const a1 = mk(ALICE, SPOT, 'buy', 90n * SCALE);
    const a2 = mk(ALICE, PERP, 'buy', 50n * SCALE);
    const a3 = mk(ALICE, SPOT, 'buy', 91n * SCALE);
    const b1 = mk(BOB, SPOT, 'sell', 95n * SCALE);
    for (const o of [a1, a2, a3, b1]) accept(o);

    // 3 trades: alice maker on two, bob maker on one
    for (const [makerO, takerU, tradeSeq] of [
      [a1, BOB, 100],
      [a3, BOB, 101],
      [b1, ALICE, 102],
    ] as const) {
      const trade: Trade = {
        id: `t${tradeSeq}`,
        marketId: makerO.marketId,
        price: makerO.price ?? 0n,
        qty: SCALE / 200n,
        takerSide: makerO.side === 'buy' ? 'sell' : 'buy',
        makerOrderId: makerO.id,
        takerOrderId: `o${tradeSeq}taker`,
        makerUserId: makerO.userId,
        takerUserId: takerU,
        makerFee: 5n,
        takerFee: 10n,
        seq: tradeSeq,
        ts: 1000 + tradeSeq,
      };
      events.push({
        kind: 'trade',
        seq: tradeSeq,
        ts: 1000 + tradeSeq,
        trade,
        makerOrder: { ...makerO, filledQty: SCALE / 200n, status: 'open' },
        takerOrder: mkOrder({
          id: trade.takerOrderId,
          userId: takerU,
          marketId: makerO.marketId,
          side: trade.takerSide,
          price: makerO.price,
          qty: SCALE / 200n,
          filledQty: SCALE / 200n,
          status: 'filled',
          seq: tradeSeq,
          ts: 1000 + tradeSeq,
          tif: 'IOC',
        }),
      });
    }
    await projector.applyBatch(events);
    return { a1, a2, a3, b1 };
  }

  it('byId / openForUser / openAllAscSeq behave and order by seq', async () => {
    const { projector, repos } = await setup();
    const { a1, a2, a3, b1 } = await seedOrdersAndTrades(projector);

    expect((await repos.orders.byId(a2.id))?.marketId).toBe(PERP);
    expect(await repos.orders.byId('o-missing')).toBeUndefined();

    const aliceSpot = await repos.orders.openForUser(ALICE, SPOT);
    expect(aliceSpot.map((o) => o.id)).toEqual([a1.id, a3.id]);

    const aliceAll = await repos.orders.openForUser(ALICE);
    expect(aliceAll.map((o) => o.id)).toEqual([a1.id, a2.id, a3.id]);

    const openAll = await repos.orders.openAllAscSeq();
    expect(openAll.map((o) => o.id)).toEqual([a1.id, a2.id, a3.id, b1.id]);
    expect(openAll.every((o) => o.status === 'open')).toBe(true);
  });

  it('fillsForUser returns the user trades (maker or taker), newest first, limited', async () => {
    const { projector, repos } = await setup();
    await seedOrdersAndTrades(projector);

    const aliceFills = await repos.orders.fillsForUser(ALICE, { limit: 10 });
    expect(aliceFills.map((t) => t.id)).toEqual(['t102', 't101', 't100']); // maker x2 + taker x1
    const limited = await repos.orders.fillsForUser(ALICE, { limit: 2 });
    expect(limited.map((t) => t.id)).toEqual(['t102', 't101']);
    expect(limited[0]?.makerFee).toBe(5n);
  });

  it('recentForMarket filters by market, newest first, limited', async () => {
    const { projector, repos } = await setup();
    await seedOrdersAndTrades(projector);
    const spotTrades = await repos.trades.recentForMarket(SPOT, 50);
    expect(spotTrades.map((t) => t.id)).toEqual(['t102', 't101', 't100']);
    expect(await repos.trades.recentForMarket(PERP, 50)).toEqual([]);
    const one = await repos.trades.recentForMarket(SPOT, 1);
    expect(one.map((t) => t.id)).toEqual(['t102']);
  });
});

describe('trailing-stop persistence', () => {
  it('persists trigger trail and applies orderTriggerUpdated (ratchet) survives restore', async () => {
    const { projector, repos } = await setup();
    const order = mkOrder({
      id: 'ts1',
      userId: ALICE,
      marketId: PERP,
      side: 'sell',
      type: 'market',
      status: 'untriggered',
      price: null,
      qty: SCALE,
      seq: 1,
      ts: 1,
      trigger: { price: 90n * SCALE, direction: 'below', trail: 10n * SCALE },
    });
    await projector.applyBatch([
      { kind: 'orderAccepted', seq: 1, ts: 1, order },
      // the stop ratcheted up to 140 as the ref rose
      {
        kind: 'orderTriggerUpdated',
        seq: 2,
        ts: 2,
        orderId: 'ts1',
        userId: ALICE,
        marketId: PERP,
        triggerPrice: 140n * SCALE,
      },
    ] as EngineEvent[]);

    const restored = await repos.orders.byId('ts1');
    expect(restored?.trigger).toEqual({
      price: 140n * SCALE, // the ratcheted stop, not the original 90
      direction: 'below',
      trail: 10n * SCALE,
    });
    // and it loads as a conditional for the engine restore path
    const state = await repos.loadRestoreState();
    expect(state.conditionalOrders?.some((o) => o.id === 'ts1')).toBe(true);
  });
});

describe('OCO group persistence', () => {
  it('persists oco_group on orders and restores it for the engine OCO map', async () => {
    const { projector, repos } = await setup();
    const o = mkOrder({
      id: 'oco1',
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price: SCALE,
      qty: SCALE,
      status: 'open',
      seq: 1,
      ts: 1,
      ocoGroup: 'bracket-7',
    });
    await projector.applyBatch([{ kind: 'orderAccepted', seq: 1, ts: 1, order: o }] as EngineEvent[]);
    expect((await repos.orders.byId('oco1'))?.ocoGroup).toBe('bracket-7');
    const state = await repos.loadRestoreState();
    expect(state.openOrders.find((x) => x.id === 'oco1')?.ocoGroup).toBe('bracket-7');
  });
});

describe('perpHistory repo (funding + liquidations)', () => {
  it('fundingForUser + liquidationsForUser: newest first, seq-cursor paginated', async () => {
    const { projector, repos } = await setup();
    await projector.applyBatch([
      positionChanged({
        seq: 1,
        ts: 1,
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 100n * SCALE,
        leverage: 5,
        margin: 20n * SCALE,
      }),
      // a payer settlement (negative → erodes the position above) and a receiver
      // settlement (positive → wallet credit, no position row needed)
      { kind: 'fundingApplied', seq: 2, ts: 2, marketId: PERP, userId: ALICE, rate: 1000n, payment: -3n * SCALE, markPrice: 100n * SCALE },
      { kind: 'fundingApplied', seq: 4, ts: 4, marketId: PERP, userId: ALICE, rate: -500n, payment: 1n * SCALE, markPrice: 99n * SCALE },
      { kind: 'liquidation', seq: 6, ts: 6, userId: ALICE, marketId: PERP, size: SCALE, markPrice: 60n * SCALE, reason: 'maintenance' },
      // an unrelated user's funding must never appear in ALICE's history
      { kind: 'fundingApplied', seq: 7, ts: 7, marketId: PERP, userId: BOB, rate: 1000n, payment: 2n * SCALE, markPrice: 100n * SCALE },
    ] as EngineEvent[]);

    const funding = await repos.perpHistory.fundingForUser(ALICE);
    expect(funding.map((f) => f.seq)).toEqual([4, 2]); // newest first, BOB excluded
    expect(funding[0]!.payment).toBe(1n * SCALE);

    const page = await repos.perpHistory.fundingForUser(ALICE, { beforeSeq: 4, limit: 1 });
    expect(page.map((f) => f.seq)).toEqual([2]); // cursor skips seq 4

    const liqs = await repos.perpHistory.liquidationsForUser(ALICE);
    expect(liqs).toHaveLength(1);
    expect(liqs[0]).toMatchObject({ marketId: PERP, size: SCALE, seq: 6 });
    expect(await repos.perpHistory.liquidationsForUser(BOB)).toEqual([]);
  });

  it('realized PnL: booked from positionChanged deltas (incl. full close at size 0)', async () => {
    const { projector, repos } = await setup();
    await projector.applyBatch([
      // open (no realized), partial reduce (+30), full close at size 0 (-10), zero (skipped)
      positionChanged({ seq: 1, ts: 1, userId: ALICE, marketId: PERP, size: 2n * SCALE, entryPrice: 100n * SCALE, leverage: 5, margin: 40n * SCALE, realizedPnl: 0n }),
      positionChanged({ seq: 2, ts: 2, userId: ALICE, marketId: PERP, size: SCALE, entryPrice: 100n * SCALE, leverage: 5, margin: 20n * SCALE, realizedPnl: 30n * SCALE }),
      positionChanged({ seq: 3, ts: 3, userId: ALICE, marketId: SPOT, size: SCALE, entryPrice: 10n * SCALE, leverage: 1, margin: 10n * SCALE, realizedPnl: 7n * SCALE }),
      positionChanged({ seq: 4, ts: 4, userId: ALICE, marketId: PERP, size: 0n, entryPrice: 0n, leverage: 5, margin: 0n, realizedPnl: -10n * SCALE }),
    ] as EngineEvent[]);

    // tape: newest first, the realizedPnl==0 open is NOT booked
    const tape = await repos.perpHistory.realizedPnlForUser(ALICE);
    expect(tape.map((r) => r.seq)).toEqual([4, 3, 2]);
    expect(tape.map((r) => r.amount)).toEqual([-10n * SCALE, 7n * SCALE, 30n * SCALE]);

    // summary: grand total + per-market
    const summary = await repos.perpHistory.realizedPnlSummary(ALICE);
    expect(summary.total).toBe(27n * SCALE); // 30 - 10 + 7
    expect(summary.byMarket).toEqual([
      { marketId: PERP, amount: 20n * SCALE }, // 30 - 10
      { marketId: SPOT, amount: 7n * SCALE },
    ]);
    expect(await repos.perpHistory.realizedPnlSummary(BOB)).toEqual({ total: 0n, byMarket: [] });
  });
});

describe('loadRestoreState', () => {
  it('returns exactly the projected open orders (asc seq), balances, positions, markPrices, lastSeq', async () => {
    const { projector, repos } = await setup();

    const o5 = mkOrder({
      id: 'o5',
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price: 90n * SCALE,
      qty: SCALE,
      seq: 5,
      ts: 1005,
    });
    const o3 = mkOrder({
      id: 'o3',
      userId: BOB,
      marketId: SPOT,
      side: 'sell',
      price: 95n * SCALE,
      qty: 2n * SCALE,
      seq: 3,
      ts: 1003,
      clientOrderId: 'bob-1',
    });
    const events: EngineEvent[] = [
      {
        kind: 'balanceChanged',
        seq: 1,
        ts: 1001,
        userId: ALICE,
        asset: 'KRW',
        available: 7n * SCALE,
        locked: 3n * SCALE,
        reason: 'deposit',
      },
      {
        kind: 'balanceChanged',
        seq: 2,
        ts: 1002,
        userId: BOB,
        asset: 'USDC',
        available: 11n * SCALE,
        locked: 0n,
        reason: 'deposit',
      },
      { kind: 'orderAccepted', seq: 3, ts: 1003, order: o3 },
      positionChanged({
        seq: 4,
        ts: 1004,
        userId: BOB,
        marketId: PERP,
        size: -5n * SCALE,
        entryPrice: 50_000n * SCALE,
        leverage: 4,
        // exact engine margin, ≠ IM formula (62_500 USDC)
        margin: 62_437n * SCALE + 19n,
      }),
      { kind: 'orderAccepted', seq: 5, ts: 1005, order: o5 },
      { kind: 'markPrice', seq: 6, ts: 1006, marketId: PERP, price: 50_500n * SCALE },
      { kind: 'markPrice', seq: 7, ts: 1007, marketId: PERP, price: 50_600n * SCALE }, // overwrite
      // filled + cancelled orders must NOT be restored
      {
        kind: 'orderAccepted',
        seq: 8,
        ts: 1008,
        order: mkOrder({
          id: 'o8',
          userId: ALICE,
          marketId: SPOT,
          side: 'buy',
          price: 89n * SCALE,
          qty: SCALE,
          seq: 8,
          ts: 1008,
        }),
      },
      {
        kind: 'orderCancelled',
        seq: 9,
        ts: 1009,
        orderId: 'o8',
        userId: ALICE,
        marketId: SPOT,
        remainingQty: SCALE,
        reason: 'user',
      },
    ];
    await projector.applyBatch(events);
    await repos.leverage.set(BOB, PERP, 4);

    const state = await repos.loadRestoreState();
    expect(state.balances).toEqual([
      { userId: ALICE, asset: 'KRW', available: 7n * SCALE, locked: 3n * SCALE },
      { userId: BOB, asset: 'USDC', available: 11n * SCALE, locked: 0n },
    ]);
    expect(state.positions).toEqual([
      {
        userId: BOB,
        marketId: PERP,
        size: -5n * SCALE,
        entryPrice: 50_000n * SCALE,
        leverage: 4,
        margin: 62_437n * SCALE + 19n, // the event's exact margin, verbatim
      },
    ]);
    expect(state.leverages).toEqual([{ userId: BOB, marketId: PERP, leverage: 4 }]);
    expect(state.openOrders).toEqual([o3, o5]); // ascending seq, exact Order objects
    expect(state.markPrices).toEqual([{ marketId: PERP, price: 50_600n * SCALE }]);
    expect(state.lastSeq).toBe(9);
  });

  it('is empty-safe on a fresh database', async () => {
    const { repos } = await setup();
    const state = await repos.loadRestoreState();
    expect(state).toEqual({
      balances: [],
      positions: [],
      leverages: [],
      openOrders: [],
      conditionalOrders: [],
      markPrices: [],
      lastSeq: 0,
    });
  });
});

describe('retention.prune (bounds DB growth from book-mirror churn)', () => {
  const MIRROR = 'mm-bot';

  it('prunes only the MIRROR’s old terminal orders; keeps user history + open + restore', async () => {
    const { projector, repos } = await setup();
    let seq = 0;
    const batch: EngineEvent[] = [];
    const mk = (id: string, userId: string, ts: number, status: 'open' | 'cancelled'): void => {
      const order = mkOrder({ id, userId, marketId: SPOT, side: 'buy', price: SCALE, qty: SCALE, seq: ++seq, ts });
      batch.push({ kind: 'orderAccepted', seq, ts, order });
      if (status === 'cancelled') {
        batch.push({ kind: 'orderCancelled', seq: ++seq, ts, orderId: id, userId, marketId: SPOT, remainingQty: SCALE, reason: 'user' });
      }
    };
    mk('mm-old', MIRROR, 1_000, 'cancelled'); // mirror churn, old → pruned
    mk('mm-new', MIRROR, 9_000, 'cancelled'); // mirror churn, recent → kept
    mk('user-old', ALICE, 1_000, 'cancelled'); // a USER's closed order, old → KEPT (history)
    mk('user-open', ALICE, 1_000, 'open'); // user resting → kept
    await projector.applyBatch(batch);

    const pruned = await repos.retention.prune({
      mirrorUserId: MIRROR,
      terminalOrdersBeforeTs: 5_000, // ts 1000 is older; ts 9000 is not
      tradesKeep: 1_000_000,
      eventsKeep: 1_000_000,
    });
    expect(pruned.orders).toBe(1); // only mm-old

    expect(await repos.orders.byId('mm-old')).toBeUndefined(); // mirror churn pruned
    expect((await repos.orders.byId('mm-new'))?.status).toBe('cancelled'); // recent mirror kept
    expect((await repos.orders.byId('user-old'))?.status).toBe('cancelled'); // USER history kept
    expect((await repos.orders.byId('user-open'))?.status).toBe('open');

    // restore reads only open orders → unaffected
    const state = await repos.loadRestoreState();
    expect(state.openOrders.map((o) => o.id)).toEqual(['user-open']);
    // user order history survives pruning + is paginable
    const hist = await repos.orders.historyForUser(ALICE, { status: 'closed' });
    expect(hist.map((o) => o.id)).toEqual(['user-old']);
  });

  it('caps trades to the most recent N by seq', async () => {
    const { projector, repos } = await setup();
    const trade = (seq: number): EngineEvent => {
      const maker = mkOrder({ id: `m${seq}`, userId: BOB, marketId: SPOT, side: 'sell', price: SCALE, qty: SCALE, filledQty: SCALE, status: 'filled', seq, ts: seq });
      const taker = mkOrder({ id: `t${seq}`, userId: ALICE, marketId: SPOT, side: 'buy', price: SCALE, qty: SCALE, filledQty: SCALE, status: 'filled', seq, ts: seq });
      return {
        kind: 'trade',
        seq,
        ts: seq,
        trade: {
          id: `tr${seq}`,
          marketId: SPOT,
          price: SCALE,
          qty: SCALE,
          takerSide: 'buy',
          makerOrderId: `m${seq}`,
          takerOrderId: `t${seq}`,
          makerUserId: BOB,
          takerUserId: ALICE,
          makerFee: 0n,
          takerFee: 0n,
          seq,
          ts: seq,
        },
        makerOrder: maker,
        takerOrder: taker,
      };
    };
    await projector.applyBatch([trade(1), trade(2), trade(3), trade(4), trade(5)]);
    const pruned = await repos.retention.prune({ mirrorUserId: MIRROR, terminalOrdersBeforeTs: 0, tradesKeep: 2, eventsKeep: 1_000_000 });
    expect(pruned.trades).toBe(3); // keep most-recent 2 (seq 4,5), drop 1,2,3
    const recent = await repos.trades.recentForMarket(SPOT, 50);
    expect(recent.map((t) => t.seq).sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it('pruning realized PnL folds trimmed rows into a carryover so the lifetime summary is exact', async () => {
    const { projector, repos } = await setup();
    // five realized-PnL bookings for ALICE on PERP: +10, -4, +6, +1, +2 = +15
    const amounts = [10n, -4n, 6n, 1n, 2n].map((a) => a * SCALE);
    const batch: EngineEvent[] = amounts.map((amount, i) =>
      positionChanged({
        seq: i + 1,
        ts: i + 1,
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 100n * SCALE,
        leverage: 5,
        margin: 20n * SCALE,
        realizedPnl: amount,
      }),
    );
    await projector.applyBatch(batch);
    const before = await repos.perpHistory.realizedPnlSummary(ALICE);
    expect(before.total).toBe(15n * SCALE);

    // keep only the most-recent 2 rows → the older 3 (+10, -4, +6 = +12) fold into carryover
    const pruned = await repos.retention.prune({
      mirrorUserId: MIRROR,
      terminalOrdersBeforeTs: 0,
      tradesKeep: 1_000_000,
      eventsKeep: 2,
    });
    expect(pruned.realizedPnl).toBe(3); // three oldest rows trimmed

    // the live tape shrank, but the cumulative summary is UNCHANGED
    const tape = await repos.perpHistory.realizedPnlForUser(ALICE);
    expect(tape).toHaveLength(2);
    const after = await repos.perpHistory.realizedPnlSummary(ALICE);
    expect(after.total).toBe(15n * SCALE); // carryover + live = exact lifetime total
    expect(after.byMarket).toEqual([{ marketId: PERP, amount: 15n * SCALE }]);
  });
});
