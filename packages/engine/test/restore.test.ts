import { describe, expect, it } from 'vitest';
import type { EngineEvent, Order, Position } from '@dex/shared';
import { Exchange } from '../src/index.js';
import { PERP, SPOT, newExchange, req, u } from './helpers.js';

const jsonBig = (v: unknown): string =>
  JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));

function sortedBalances(ex: Exchange) {
  return ex
    .getAllBalances()
    .slice()
    .sort((a, b) => `${a.userId}|${a.asset}`.localeCompare(`${b.userId}|${b.asset}`));
}

const USERS = ['alice', 'bob', 'carol'];

interface Snapshot {
  balances: { userId: string; asset: string; available: bigint; locked: bigint }[];
  positions: Position[];
  leverages: { userId: string; marketId: string; leverage: number }[];
  openOrders: Order[];
  markPrices: { marketId: string; price: bigint }[];
  lastSeq: number;
}

function snapshot(ex: Exchange, leverages: Snapshot['leverages']): Snapshot {
  const positions: Position[] = [];
  const openOrders: Order[] = [];
  for (const user of USERS) {
    positions.push(...ex.getPositions(user));
    openOrders.push(...ex.getOpenOrders(user));
  }
  openOrders.sort((a, b) => a.seq - b.seq);
  const markPrices: Snapshot['markPrices'] = [];
  for (const m of ex.getMarkets()) {
    const p = ex.getMarkPrice(m.id);
    if (p !== undefined) markPrices.push({ marketId: m.id, price: p });
  }
  return { balances: ex.getAllBalances(), positions, leverages, openOrders, markPrices, lastSeq: ex.seq };
}

/** Prefix: builds spot + perp state with partial fills, positions, resting orders. */
function runPrefix(ex: Exchange): Snapshot['leverages'] {
  let ts = 1;
  for (const user of USERS) {
    ex.deposit(user, 'KRW', u(50_000_000), ts++);
    ex.deposit(user, 'BTC', u(5), ts++);
    ex.deposit(user, 'USDC', u(50_000), ts++);
  }
  const leverages = [
    { userId: 'alice', marketId: PERP.id, leverage: 5 },
    { userId: 'bob', marketId: PERP.id, leverage: 10 },
  ];
  for (const l of leverages) ex.setLeverage(l.userId, l.marketId, l.leverage, ts++);
  // spot: bob rests a sell, alice partially fills it as taker, alice rests a bid
  ex.submitOrder('bob', req(SPOT.id, 'sell', 'limit', u(50_000_000), u('0.02')), ts++);
  ex.submitOrder('alice', req(SPOT.id, 'buy', 'limit', u(50_000_000), u('0.005')), ts++);
  ex.submitOrder('alice', req(SPOT.id, 'buy', 'limit', u(49_000_000), u('0.01')), ts++);
  // alice rests a partially-filled spot buy: carol sells into it
  ex.submitOrder('alice', req(SPOT.id, 'buy', 'limit', u(48_000_000), u('0.02')), ts++);
  ex.submitOrder('carol', req(SPOT.id, 'sell', 'limit', u(48_000_000), u('0.008')), ts++);
  // perp: bob short 1 @100 (maker, partial), alice long 1
  ex.submitOrder('bob', req(PERP.id, 'sell', 'limit', u(100), u(2)), ts++);
  ex.submitOrder('alice', req(PERP.id, 'buy', 'limit', u(100), u(1)), ts++);
  // alice rests a reduceOnly sell, carol rests a bid
  ex.submitOrder('alice', req(PERP.id, 'sell', 'limit', u(120), u('0.5'), { reduceOnly: true }), ts++);
  ex.submitOrder('carol', req(PERP.id, 'buy', 'limit', u(95), u('0.7')), ts++);
  ex.setMarkPrice(PERP.id, u(100), ts++);
  return leverages;
}

/** Identical op suffix to run on the original and the restored engine. */
function runSuffix(ex: Exchange, restoredOrderIds: { aliceBid: string }): EngineEvent[] {
  let ts = 10_000;
  const out: EngineEvent[] = [];
  // fill against restored resting orders (spot maker bob, perp RO maker alice)
  out.push(...ex.submitOrder('carol', req(SPOT.id, 'buy', 'limit', u(50_000_000), u('0.01')), ts++));
  out.push(...ex.submitOrder('carol', req(PERP.id, 'buy', 'limit', u(120), u('0.3')), ts++));
  // cancel a restored order by its original id
  out.push(...ex.cancelOrder('alice', restoredOrderIds.aliceBid, ts++));
  // market order + IOC
  out.push(...ex.submitOrder('bob', req(SPOT.id, 'sell', 'market', u(48_000_000), u('0.02')), ts++));
  out.push(...ex.submitOrder('bob', req(PERP.id, 'buy', 'limit', u(95), u('0.2'), { tif: 'IOC' }), ts++));
  // mark move + funding
  out.push(...ex.setMarkPrice(PERP.id, u(90), ts++));
  out.push(...ex.applyFunding(PERP.id, u('0.0001'), ts++));
  return out;
}

describe('restoreState', () => {
  it('round-trips: identical books, balances, and identical behaviour on an op suffix', () => {
    const a = newExchange();
    const leverages = runPrefix(a);
    const snap = snapshot(a, leverages);

    const b = newExchange();
    b.restoreState(snap);

    // immediate equivalence
    expect(b.seq).toBe(a.seq);
    expect(jsonBig(b.getOrderbook(SPOT.id))).toBe(jsonBig(a.getOrderbook(SPOT.id)));
    expect(jsonBig(b.getOrderbook(PERP.id))).toBe(jsonBig(a.getOrderbook(PERP.id)));
    expect(jsonBig(sortedBalances(b))).toBe(jsonBig(sortedBalances(a)));
    for (const user of USERS) {
      expect(jsonBig(b.getOpenOrders(user))).toBe(jsonBig(a.getOpenOrders(user)));
      expect(jsonBig(b.getPositions(user))).toBe(jsonBig(a.getPositions(user)));
    }
    expect(b.getMarkPrice(PERP.id)).toBe(u(100));

    // identical suffix -> identical events (incl. seq/ids), balances, books
    const aliceBid = a.getOpenOrders('alice', SPOT.id).find((o) => o.price === u(49_000_000))!.id;
    const evA = runSuffix(a, { aliceBid });
    const evB = runSuffix(b, { aliceBid });
    expect(jsonBig(evB)).toBe(jsonBig(evA));
    expect(jsonBig(sortedBalances(b))).toBe(jsonBig(sortedBalances(a)));
    expect(jsonBig(b.getOrderbook(SPOT.id))).toBe(jsonBig(a.getOrderbook(SPOT.id)));
    expect(jsonBig(b.getOrderbook(PERP.id))).toBe(jsonBig(a.getOrderbook(PERP.id)));
    for (const user of USERS) {
      expect(jsonBig(b.getPositions(user))).toBe(jsonBig(a.getPositions(user)));
    }
  });

  it('cancel-after-restore releases exactly what the restored locked balance holds', () => {
    const a = newExchange();
    const leverages = runPrefix(a);
    const snap = snapshot(a, leverages);
    const b = newExchange();
    b.restoreState(snap);

    let ts = 99_000;
    for (const user of USERS) {
      const before = new Map(b.getBalances(user).map((x) => [x.asset, x]));
      for (const o of b.getOpenOrders(user)) b.cancelOrder(user, o.id, ts++);
      for (const after of b.getBalances(user)) {
        const prev = before.get(after.asset)!;
        expect(after.locked).toBe(0n);
        expect(after.available).toBe(prev.available + prev.locked);
      }
    }
  });

  it('restored engine assigns fresh non-colliding order ids', () => {
    const a = newExchange();
    const leverages = runPrefix(a);
    const snap = snapshot(a, leverages);
    const b = newExchange();
    b.restoreState(snap);
    const evts = b.submitOrder('carol', req(SPOT.id, 'buy', 'limit', u(47_000_000), u('0.01')), 50_000);
    const acc = evts.find((e) => e.kind === 'orderAccepted');
    if (!acc || acc.kind !== 'orderAccepted') throw new Error('no accept');
    expect(Number(acc.order.id.slice(1))).toBeGreaterThan(snap.lastSeq);
    expect(snap.openOrders.some((o) => o.id === acc.order.id)).toBe(false);
  });

  it('full determinism: identical op sequences on fresh engines yield identical events', () => {
    const a = newExchange();
    const b = newExchange();
    const la = runPrefix(a);
    runPrefix(b);
    const aliceBidA = a.getOpenOrders('alice', SPOT.id).find((o) => o.price === u(49_000_000))!.id;
    const evA = runSuffix(a, { aliceBid: aliceBidA });
    const evB = runSuffix(b, { aliceBid: aliceBidA });
    expect(jsonBig(evB)).toBe(jsonBig(evA));
    void la;
  });
});
