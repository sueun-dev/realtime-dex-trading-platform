import { describe, expect, it } from 'vitest';
import {
  DexError,
  FEE_ACCOUNT,
  feeOn,
  mulUnits,
  type EngineEvent,
} from '@dex/shared';
import { Exchange } from '../src/index.js';
import { ConservationTracker, SPOT, acceptedId, newExchange, rejection, req, trades, u } from './helpers.js';

const M = SPOT.id;
let TS = 1_000;

function setup(): { ex: Exchange; t: ConservationTracker } {
  const ex = newExchange();
  const t = new ConservationTracker();
  ex.deposit('alice', 'KRW', u(100_000_000), TS);
  t.deposit('KRW', u(100_000_000));
  ex.deposit('bob', 'BTC', u(10), TS);
  t.deposit('BTC', u(10));
  ex.deposit('bob', 'KRW', u(100_000_000), TS);
  t.deposit('KRW', u(100_000_000));
  ex.deposit('alice', 'BTC', u(10), TS);
  t.deposit('BTC', u(10));
  return { ex, t };
}

describe('spot matching', () => {
  it('rests a GTC limit, matches an incoming taker at maker price, charges fees in quote', () => {
    const { ex, t } = setup();
    const e1 = ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const sellId = acceptedId(e1);
    expect(sellId).toMatch(/^o\d+$/);
    expect(ex.getOrderbook(M).asks).toEqual([{ price: u(50_000_000), qty: u('0.01') }]);

    // taker buys at a higher limit -> trade at maker (resting) price
    const e2 = ex.submitOrder('alice', req(M, 'buy', 'limit', u(51_000_000), u('0.01')), TS++);
    const ts2 = trades(e2);
    expect(ts2).toHaveLength(1);
    const tr = ts2[0]!;
    expect(tr.price).toBe(u(50_000_000));
    expect(tr.qty).toBe(u('0.01'));
    expect(tr.takerSide).toBe('buy');
    expect(tr.makerOrderId).toBe(sellId);

    const n = mulUnits(u(50_000_000), u('0.01')); // 500_000 KRW
    expect(tr.makerFee).toBe(feeOn(n, SPOT.makerFeeBps));
    expect(tr.takerFee).toBe(feeOn(n, SPOT.takerFeeBps));

    // balances: buyer paid n + takerFee, got base; seller got n - makerFee
    const alice = Object.fromEntries(ex.getBalances('alice').map((b) => [b.asset, b]));
    const bob = Object.fromEntries(ex.getBalances('bob').map((b) => [b.asset, b]));
    expect(alice['KRW']!.available).toBe(u(100_000_000) - n - tr.takerFee);
    expect(alice['KRW']!.locked).toBe(0n);
    expect(alice['BTC']!.available).toBe(u(10) + u('0.01'));
    expect(bob['BTC']!.available).toBe(u(10) - u('0.01'));
    expect(bob['BTC']!.locked).toBe(0n);
    expect(bob['KRW']!.available).toBe(u(100_000_000) + n - tr.makerFee);
    const fee = ex.getBalances(FEE_ACCOUNT).find((b) => b.asset === 'KRW')!;
    expect(fee.available).toBe(tr.makerFee + tr.takerFee);
    t.check(ex);

    // book empty, both orders filled
    expect(ex.getOrderbook(M).asks).toEqual([]);
    expect(ex.getOrder(sellId)!.status).toBe('filled');
  });

  it('orderAccepted comes before fills; seq strictly increases; ids are deterministic', () => {
    const { ex } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++);
    const ki = evts.map((e) => e.kind);
    expect(ki.indexOf('orderAccepted')).toBeLessThan(ki.indexOf('trade'));
    const seqs = evts.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    const tr = trades(evts)[0]!;
    expect(tr.id).toBe(`t${tr.seq}`);
  });

  it('walks levels best-first, FIFO within level, partial fills', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(51_000_000), u('0.01')), TS++);
    const first = acceptedId(ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++));
    const second = acceptedId(ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.02')), TS++));
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(51_000_000), u('0.025')), TS++);
    const ts3 = trades(evts);
    expect(ts3.map((x) => [x.makerOrderId, x.price, x.qty])).toEqual([
      [first, u(50_000_000), u('0.01')],
      [second, u(50_000_000), u('0.015')],
    ]);
    // taker filled fully at best prices; second maker partially filled
    expect(ex.getOrder(second)!.filledQty).toBe(u('0.015'));
    expect(ex.getOrder(second)!.status).toBe('open');
    expect(ex.getOrderbook(M).asks).toEqual([
      { price: u(50_000_000), qty: u('0.005') },
      { price: u(51_000_000), qty: u('0.01') },
    ]);
    t.check(ex);
  });

  it('price improvement refunds the difference vs the buy lock', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const before = ex.getBalances('alice').find((b) => b.asset === 'KRW')!;
    // buy limit 52M fills at 50M
    ex.submitOrder('alice', req(M, 'buy', 'limit', u(52_000_000), u('0.01')), TS++);
    const after = ex.getBalances('alice').find((b) => b.asset === 'KRW')!;
    const n = mulUnits(u(50_000_000), u('0.01'));
    expect(after.locked).toBe(0n);
    expect(before.available - after.available).toBe(n + feeOn(n, SPOT.takerFeeBps));
    t.check(ex);
  });

  it('cancel releases the exact remaining lock (buy and sell)', () => {
    const { ex, t } = setup();
    const buyId = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++));
    const n = mulUnits(u(50_000_000), u('0.01'));
    const lock = n + feeOn(n, SPOT.takerFeeBps);
    expect(ex.getBalances('alice').find((b) => b.asset === 'KRW')!.locked).toBe(lock);
    ex.cancelOrder('alice', buyId, TS++);
    const krw = ex.getBalances('alice').find((b) => b.asset === 'KRW')!;
    expect(krw.locked).toBe(0n);
    expect(krw.available).toBe(u(100_000_000));

    const sellId = acceptedId(ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.5')), TS++));
    expect(ex.getBalances('bob').find((b) => b.asset === 'BTC')!.locked).toBe(u('0.5'));
    ex.cancelOrder('bob', sellId, TS++);
    expect(ex.getBalances('bob').find((b) => b.asset === 'BTC')!.locked).toBe(0n);
    t.check(ex);
  });

  it('cancel after partial fill releases exactly the remaining lock', () => {
    const { ex, t } = setup();
    const buyId = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.02')), TS++));
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.005')), TS++);
    const evts = ex.cancelOrder('alice', buyId, TS++);
    expect(evts.some((e) => e.kind === 'orderCancelled' && e.remainingQty === u('0.015'))).toBe(true);
    const krw = ex.getBalances('alice').find((b) => b.asset === 'KRW')!;
    expect(krw.locked).toBe(0n);
    t.check(ex);
  });

  it('cancel errors: unknown id, terminal order, double cancel, wrong user', () => {
    const { ex } = setup();
    expect(() => ex.cancelOrder('alice', 'o999', TS)).toThrowError(DexError);
    const id = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++));
    expect(() => ex.cancelOrder('bob', id, TS)).toThrow(/NOT_AUTH|another user/);
    ex.cancelOrder('alice', id, TS++);
    expect(() => ex.cancelOrder('alice', id, TS)).toThrow(/not found|not open/);
    // filled order cannot be cancelled
    const id2 = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++));
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    expect(ex.getOrder(id2)!.status).toBe('filled');
    expect(() => ex.cancelOrder('alice', id2, TS)).toThrow();
  });

  it('IOC remainder is cancelled with reason ioc', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.03'), { tif: 'IOC' }), TS++);
    expect(trades(evts)).toHaveLength(1);
    const c = evts.find((e) => e.kind === 'orderCancelled');
    expect(c && c.kind === 'orderCancelled' && c.reason).toBe('ioc');
    expect(c && c.kind === 'orderCancelled' && c.remainingQty).toBe(u('0.02'));
    expect(ex.getBalances('alice').find((b) => b.asset === 'KRW')!.locked).toBe(0n);
    t.check(ex);
  });

  it('FOK fills fully when possible, rejects with zero side effects otherwise', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(51_000_000), u('0.01')), TS++);
    // not enough within bound 50M
    const balBefore = JSON.stringify(ex.getAllBalances(), (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const bookBefore = ex.getOrderbook(M);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.02'), { tif: 'FOK' }), TS++);
    expect(rejection(evts)?.code).toBe('FOK_NOT_FILLED');
    expect(evts).toHaveLength(1); // single rejection event, no lock/unlock noise
    expect(JSON.stringify(ex.getAllBalances(), (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(balBefore);
    expect(ex.getOrderbook(M).asks).toEqual(bookBefore.asks);
    // enough within bound 51M
    const ok = ex.submitOrder('alice', req(M, 'buy', 'limit', u(51_000_000), u('0.02'), { tif: 'FOK' }), TS++);
    expect(trades(ok)).toHaveLength(2);
    expect(ex.getOpenOrders('alice')).toHaveLength(0);
    t.check(ex);
  });

  it('postOnly rejects when crossing, rests otherwise', () => {
    const { ex } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const cross = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01'), { postOnly: true }), TS++);
    expect(rejection(cross)?.code).toBe('POST_ONLY_WOULD_CROSS');
    expect(ex.getBalances('alice').find((b) => b.asset === 'KRW')!.locked).toBe(0n);
    const rest = ex.submitOrder('alice', req(M, 'buy', 'limit', u(49_000_000), u('0.01'), { postOnly: true }), TS++);
    expect(rejection(rest)).toBeUndefined();
    expect(ex.getOrderbook(M).bids).toEqual([{ price: u(49_000_000), qty: u('0.01') }]);
  });

  it('market order requires a price bound', () => {
    const { ex } = setup();
    const evts = ex.submitOrder('alice', req(M, 'buy', 'market', undefined, u('0.01')), TS++);
    expect(rejection(evts)?.code).toBe('INVALID_ORDER');
  });

  it('market buy respects the bound: remainder beyond bound -> slippage', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(52_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'market', u(50_000_000), u('0.02')), TS++);
    expect(trades(evts)).toHaveLength(1);
    const c = evts.find((e) => e.kind === 'orderCancelled');
    expect(c && c.kind === 'orderCancelled' && c.reason).toBe('slippage');
    t.check(ex);
  });

  it('market remainder on empty book -> bookExhausted', () => {
    const { ex, t } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'market', u(55_000_000), u('0.05')), TS++);
    expect(trades(evts)).toHaveLength(1);
    const c = evts.find((e) => e.kind === 'orderCancelled');
    expect(c && c.kind === 'orderCancelled' && c.reason).toBe('bookExhausted');
    t.check(ex);
  });

  it('market sell matches levels >= bound only', () => {
    const { ex, t } = setup();
    ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++);
    ex.submitOrder('alice', req(M, 'buy', 'limit', u(48_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('bob', req(M, 'sell', 'market', u(49_000_000), u('0.02')), TS++);
    const ts2 = trades(evts);
    expect(ts2).toHaveLength(1);
    expect(ts2[0]!.price).toBe(u(50_000_000));
    const c = evts.find((e) => e.kind === 'orderCancelled');
    expect(c && c.kind === 'orderCancelled' && c.reason).toBe('slippage');
    t.check(ex);
  });

  it('market FOK pre-checks fillability within bound', () => {
    const { ex } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const fail = ex.submitOrder('alice', req(M, 'buy', 'market', u(50_000_000), u('0.02'), { tif: 'FOK' }), TS++);
    expect(rejection(fail)?.code).toBe('FOK_NOT_FILLED');
    const ok = ex.submitOrder('alice', req(M, 'buy', 'market', u(50_000_000), u('0.01'), { tif: 'FOK' }), TS++);
    expect(trades(ok)).toHaveLength(1);
  });

  it('market orders with GTC or postOnly are invalid', () => {
    const { ex } = setup();
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'market', u(50_000_000), u('0.01'), { tif: 'GTC' }), TS++))?.code).toBe('INVALID_ORDER');
    expect(
      rejection(ex.submitOrder('alice', req(M, 'buy', 'market', u(50_000_000), u('0.01'), { postOnly: true }), TS++))
        ?.code,
    ).toBe('INVALID_ORDER');
  });

  it('validation: market exists, tick, lot, minNotional, sign checks — in that order', () => {
    const { ex } = setup();
    expect(rejection(ex.submitOrder('alice', req('KRW-NOPE', 'buy', 'limit', u(1000), u(1)), TS++))?.code).toBe('MARKET_NOT_FOUND');
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000) + 1n, u('0.01')), TS++))?.code).toBe('TICK_SIZE');
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01') + 1n), TS++))?.code).toBe('LOT_SIZE');
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(1000), u('0.0001')), TS++))?.code).toBe('MIN_NOTIONAL');
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', 0n - u(1000), u('0.01')), TS++))?.code).toBe('INVALID_ORDER');
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), 0n), TS++))?.code).toBe('INVALID_ORDER');
    // tick violation reported before lot violation
    expect(rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000) + 1n, u('0.01') + 1n), TS++))?.code).toBe('TICK_SIZE');
    // reduceOnly on spot
    expect(
      rejection(ex.submitOrder('alice', req(M, 'sell', 'limit', u(50_000_000), u('0.01'), { reduceOnly: true }), TS++))
        ?.code,
    ).toBe('REDUCE_ONLY_VIOLATION');
  });

  it('insufficient balance rejections (buy quote, sell base)', () => {
    const ex = newExchange();
    ex.deposit('poor', 'KRW', u(1000), TS++);
    expect(rejection(ex.submitOrder('poor', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++))?.code).toBe('INSUFFICIENT_BALANCE');
    expect(rejection(ex.submitOrder('poor', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++))?.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('self-trade prevention cancels the resting order and keeps matching', () => {
    const { ex, t } = setup();
    const own = acceptedId(ex.submitOrder('alice', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++));
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++);
    const c = evts.find((e) => e.kind === 'orderCancelled');
    expect(c && c.kind === 'orderCancelled' && c.orderId).toBe(own);
    expect(c && c.kind === 'orderCancelled' && c.reason).toBe('selfTrade');
    const ts2 = trades(evts);
    expect(ts2).toHaveLength(1);
    expect(ts2[0]!.makerUserId).toBe('bob');
    expect(ex.getOrder(own)!.status).toBe('cancelled');
    t.check(ex);
  });

  it('deposit/withdraw events and errors', () => {
    const ex = newExchange();
    const d = ex.deposit('alice', 'KRW', u(5000), 1);
    expect(d).toHaveLength(1);
    const ev = d[0]! as Extract<EngineEvent, { kind: 'balanceChanged' }>;
    expect(ev.kind).toBe('balanceChanged');
    expect(ev.available).toBe(u(5000));
    expect(ev.reason).toBe('deposit');
    const w = ex.withdraw('alice', 'KRW', u(2000), 2);
    const we = w[0]! as Extract<EngineEvent, { kind: 'balanceChanged' }>;
    expect(we.available).toBe(u(3000));
    expect(() => ex.withdraw('alice', 'KRW', u(4000), 3)).toThrow(/insufficient/i);
    expect(() => ex.deposit('alice', 'KRW', 0n, 4)).toThrow();
    expect(() => ex.withdraw('alice', 'KRW', -1n, 5)).toThrow();
    // locked funds cannot be withdrawn
    ex.submitOrder('alice', req(M, 'buy', 'limit', u(1_000_000) * 0n + u(1000), u('0.01')), 6);
  });

  it('FOK pre-walk excludes own resting orders (they would be STP-cancelled, not filled)', () => {
    const { ex } = setup();
    ex.submitOrder('alice', req(M, 'sell', 'limit', u(50_000_000), u('0.02')), TS++);
    // book qty 0.02 is all alice's own -> her FOK buy for 0.02 must reject
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.02'), { tif: 'FOK' }), TS++);
    expect(rejection(evts)?.code).toBe('FOK_NOT_FILLED');
    // and her own resting order is untouched (no STP during the pre-walk)
    expect(ex.getOrderbook(M).asks).toEqual([{ price: u(50_000_000), qty: u('0.02') }]);
  });

  it('validation order: balance check fires before postOnly/FOK checks', () => {
    const ex = newExchange();
    ex.deposit('rich', 'BTC', u(1), TS++);
    ex.deposit('poor', 'KRW', u(100), TS++);
    ex.submitOrder('rich', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    // poor can't afford the lock AND the order would cross -> INSUFFICIENT_BALANCE wins
    const po = ex.submitOrder('poor', req(M, 'buy', 'limit', u(50_000_000), u('0.01'), { postOnly: true }), TS++);
    expect(rejection(po)?.code).toBe('INSUFFICIENT_BALANCE');
    // poor can't afford AND FOK can't fill -> INSUFFICIENT_BALANCE wins
    const fok = ex.submitOrder('poor', req(M, 'buy', 'limit', u(50_000_000), u('0.05'), { tif: 'FOK' }), TS++);
    expect(rejection(fok)?.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('rejects a duplicate clientOrderId while the first is live, allows reuse after it clears', () => {
    const { ex } = setup();
    const first = ex.submitOrder('alice', req(M, 'buy', 'limit', u(40_000_000), u('0.01'), { clientOrderId: 'dup' }), TS++);
    const id = acceptedId(first);
    // a second LIVE order with the same clientOrderId is rejected
    const dup = ex.submitOrder('alice', req(M, 'buy', 'limit', u(40_000_000), u('0.01'), { clientOrderId: 'dup' }), TS++);
    expect(rejection(dup)?.code).toBe('DUPLICATE_CLIENT_ORDER_ID');
    // a different user may use the same id
    const other = ex.submitOrder('bob', req(M, 'buy', 'limit', u(40_000_000), u('0.01'), { clientOrderId: 'dup' }), TS++);
    expect(other.find((e) => e.kind === 'orderAccepted')).toBeTruthy();
    // once the first clears, the id frees up for reuse
    ex.cancelOrder('alice', id, TS++);
    const reuse = ex.submitOrder('alice', req(M, 'buy', 'limit', u(40_000_000), u('0.01'), { clientOrderId: 'dup' }), TS++);
    expect(reuse.find((e) => e.kind === 'orderAccepted')).toBeTruthy();
  });

  it('clientOrderId round-trips through accept and reject events', () => {
    const { ex } = setup();
    const ok = ex.submitOrder(
      'alice',
      req(M, 'buy', 'limit', u(50_000_000), u('0.01'), { clientOrderId: 'cid-1' }),
      TS++,
    );
    const acc = ok.find((e) => e.kind === 'orderAccepted');
    expect(acc && acc.kind === 'orderAccepted' && acc.order.clientOrderId).toBe('cid-1');
    const bad = ex.submitOrder(
      'alice',
      req('KRW-NOPE', 'buy', 'limit', u(50_000_000), u('0.01'), { clientOrderId: 'cid-2' }),
      TS++,
    );
    const rej = bad.find((e) => e.kind === 'orderRejected');
    expect(rej && rej.kind === 'orderRejected' && rej.clientOrderId).toBe('cid-2');
  });

  it('evicts terminal orders from the live map (memory stays bounded under churn)', () => {
    const { ex } = setup();
    // 200 place→fully-cancel cycles must not grow the live order map
    for (let i = 0; i < 200; i++) {
      const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(40_000_000), u('0.001')), TS++);
      ex.cancelOrder('alice', acceptedId(evts), TS++);
    }
    const sizes = ex.orderMapSizes();
    expect(sizes.live).toBe(0); // nothing resting → live map empty
    expect(sizes.terminalCache).toBeLessThanOrEqual(20_000);
    // a fully-filled taker is also evicted from live, still answerable via getOrder
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.01')), TS++);
    const fill = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++);
    const id = acceptedId(fill);
    expect(ex.orderMapSizes().live).toBe(0); // both fully filled → none resting
    expect(ex.getOrder(id)?.status).toBe('filled'); // still served from the terminal cache
  });

  it('trade events embed post-fill maker/taker order states', () => {
    const { ex } = setup();
    ex.submitOrder('bob', req(M, 'sell', 'limit', u(50_000_000), u('0.02')), TS++);
    const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', u(50_000_000), u('0.01')), TS++);
    const te = evts.find((e) => e.kind === 'trade');
    if (!te || te.kind !== 'trade') throw new Error('no trade');
    expect(te.makerOrder.filledQty).toBe(u('0.01'));
    expect(te.makerOrder.status).toBe('open');
    expect(te.takerOrder.filledQty).toBe(u('0.01'));
    expect(te.takerOrder.status).toBe('filled');
  });
});
