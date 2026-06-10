/**
 * P3 — reference cross-check: a naive O(n^2) matcher (spot, limit GTC only)
 * implemented independently from the engine's book/ledger code. Random order
 * sequences must produce identical trade lists (price, qty, maker, taker) and
 * identical final balances.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { FEE_ACCOUNT, feeOn, mulUnits, type Side } from '@dex/shared';
import { SPOT, newExchange, req, u } from './helpers.js';

const QUOTE = SPOT.quote;
const BASE = SPOT.base;

interface RefOrder {
  idx: number;
  userId: string;
  side: Side;
  price: bigint;
  qty: bigint;
  filled: bigint;
  lockRem: bigint;
  open: boolean;
}

interface RefTrade {
  price: bigint;
  qty: bigint;
  makerIdx: number;
  takerIdx: number;
}

class RefSpot {
  readonly avail = new Map<string, bigint>();
  readonly locked = new Map<string, bigint>();
  readonly orders: RefOrder[] = [];
  readonly trades: RefTrade[] = [];

  private key(user: string, asset: string): string {
    return `${user}|${asset}`;
  }
  private add(map: Map<string, bigint>, user: string, asset: string, d: bigint): void {
    const k = this.key(user, asset);
    const v = (map.get(k) ?? 0n) + d;
    if (v < 0n) throw new Error(`ref negative balance ${k}`);
    map.set(k, v);
  }
  get(user: string, asset: string): { available: bigint; locked: bigint } {
    return {
      available: this.avail.get(this.key(user, asset)) ?? 0n,
      locked: this.locked.get(this.key(user, asset)) ?? 0n,
    };
  }
  deposit(user: string, asset: string, amount: bigint): void {
    this.add(this.avail, user, asset, amount);
  }

  private buyLock(price: bigint, rem: bigint): bigint {
    const n = mulUnits(price, rem);
    return n + feeOn(n, SPOT.takerFeeBps);
  }

  /** returns the submission idx if accepted, -1 if rejected */
  submit(userId: string, side: Side, price: bigint, qty: bigint): number {
    const idx = this.nextIdx++;
    const lock = side === 'buy' ? this.buyLock(price, qty) : qty;
    const asset = side === 'buy' ? QUOTE : BASE;
    if ((this.avail.get(this.key(userId, asset)) ?? 0n) < lock) return -1;
    this.add(this.avail, userId, asset, -lock);
    this.add(this.locked, userId, asset, lock);
    const taker: RefOrder = { idx, userId, side, price, qty, filled: 0n, lockRem: lock, open: true };
    this.orders.push(taker);
    // naive matching: scan for best opposite maker each iteration
    for (;;) {
      if (taker.qty - taker.filled === 0n) break;
      let best: RefOrder | null = null;
      for (const o of this.orders) {
        if (!o.open || o === taker || o.side === side || o.qty - o.filled === 0n) continue;
        const crosses = side === 'buy' ? o.price <= price : o.price >= price;
        if (!crosses) continue;
        if (
          best === null ||
          (side === 'buy' ? o.price < best.price : o.price > best.price) ||
          (o.price === best.price && o.idx < best.idx)
        ) {
          best = o;
        }
      }
      if (!best) break;
      if (best.userId === userId) {
        this.cancel(best.idx); // self-trade prevention: cancel resting order
        continue;
      }
      const q = (taker.qty - taker.filled < best.qty - best.filled ? taker.qty - taker.filled : best.qty - best.filled);
      this.fill(best, taker, best.price, q);
      this.trades.push({ price: best.price, qty: q, makerIdx: best.idx, takerIdx: taker.idx });
    }
    if (taker.qty - taker.filled === 0n) taker.open = false;
    return idx;
  }
  private nextIdx = 0;

  private fill(maker: RefOrder, taker: RefOrder, p: bigint, q: bigint): void {
    maker.filled += q;
    taker.filled += q;
    const buy = maker.side === 'buy' ? maker : taker;
    const sell = maker.side === 'buy' ? taker : maker;
    const buyBps = buy === maker ? SPOT.makerFeeBps : SPOT.takerFeeBps;
    const sellBps = sell === maker ? SPOT.makerFeeBps : SPOT.takerFeeBps;
    const n = mulUnits(p, q);
    // buyer
    const target = this.buyLock(buy.price, buy.qty - buy.filled);
    const budget = buy.lockRem - target;
    let buyFee = feeOn(n, buyBps);
    if (buyFee > budget - n) buyFee = budget - n;
    this.add(this.locked, buy.userId, QUOTE, -budget);
    this.add(this.avail, buy.userId, QUOTE, budget - n - buyFee);
    this.add(this.avail, buy.userId, BASE, q);
    buy.lockRem = target;
    // seller
    let sellFee = feeOn(n, sellBps);
    if (sellFee > n) sellFee = n;
    this.add(this.locked, sell.userId, BASE, -q);
    sell.lockRem -= q;
    this.add(this.avail, sell.userId, QUOTE, n - sellFee);
    this.add(this.avail, FEE_ACCOUNT, QUOTE, buyFee + sellFee);
    if (maker.qty - maker.filled === 0n) {
      maker.open = false;
      if (maker.lockRem !== 0n) throw new Error('ref: filled maker holds lock');
    }
  }

  cancel(idx: number): boolean {
    const o = this.orders.find((x) => x.idx === idx);
    if (!o || !o.open) return false;
    o.open = false;
    const asset = o.side === 'buy' ? QUOTE : BASE;
    this.add(this.locked, o.userId, asset, -o.lockRem);
    this.add(this.avail, o.userId, asset, o.lockRem);
    o.lockRem = 0n;
    return true;
  }
}

const refOp = fc.record({
  a: fc.nat(3),
  side: fc.boolean(),
  ticks: fc.integer({ min: 40, max: 60 }),
  lots: fc.integer({ min: 1, max: 300 }),
  kind: fc.nat(9),
  pick: fc.nat(999),
});

describe('P3: reference matcher cross-check (spot, limit GTC)', () => {
  it('random sequences yield identical trades and final balances', () => {
    let totalTrades = 0;
    let totalRejects = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.array(refOp, { minLength: 10, maxLength: 80 }),
        (nUsers, ops) => {
          const ex = newExchange();
          const ref = new RefSpot();
          const users = Array.from({ length: nUsers }, (_, i) => `u${i}`);
          let ts = 1;
          for (const user of users) {
            ex.deposit(user, 'KRW', u(10_000), ts++);
            ref.deposit(user, 'KRW', u(10_000));
            ex.deposit(user, 'BTC', u('0.05'), ts++);
            ref.deposit(user, 'BTC', u('0.05'));
          }
          const idxToEngineId = new Map<number, string>();
          const engineIdToIdx = new Map<string, number>();
          const engineTrades: RefTrade[] = [];
          let submissions = 0;
          for (const op of ops) {
            const user = users[op.a % users.length]!;
            if (op.kind < 8) {
              const price = SPOT.tickSize * BigInt(op.ticks);
              const qty = SPOT.lotSize * BigInt(op.lots);
              const side: Side = op.side ? 'buy' : 'sell';
              const evts = ex.submitOrder(user, req(SPOT.id, side, 'limit', price, qty), ts++);
              const refIdx = submissions++;
              const refAccepted = ref.submit(user, side, price, qty);
              const acc = evts.find((e) => e.kind === 'orderAccepted');
              if (refAccepted === -1) {
                expect(acc).toBeUndefined();
                expect(evts.some((e) => e.kind === 'orderRejected')).toBe(true);
                totalRejects++;
              } else {
                if (!acc || acc.kind !== 'orderAccepted') throw new Error('engine rejected, ref accepted');
                expect(refAccepted).toBe(refIdx);
                idxToEngineId.set(refIdx, acc.order.id);
                engineIdToIdx.set(acc.order.id, refIdx);
              }
              for (const e of evts) {
                if (e.kind === 'trade') {
                  engineTrades.push({
                    price: e.trade.price,
                    qty: e.trade.qty,
                    makerIdx: engineIdToIdx.get(e.trade.makerOrderId)!,
                    takerIdx: engineIdToIdx.get(e.trade.takerOrderId)!,
                  });
                }
                if (e.kind === 'orderCancelled' && e.reason === 'selfTrade') {
                  // mirrored inside ref.submit
                }
              }
            } else {
              // cancel a random earlier submission (owner calls)
              if (idxToEngineId.size === 0) continue;
              const keys = [...idxToEngineId.keys()];
              const idx = keys[op.pick % keys.length]!;
              const engineId = idxToEngineId.get(idx)!;
              const o = ex.getOrder(engineId)!;
              const refCancelled = ref.cancel(idx);
              if (refCancelled) {
                ex.cancelOrder(o.userId, engineId, ts++);
              } else {
                expect(o.status === 'open').toBe(false);
                expect(() => ex.cancelOrder(o.userId, engineId, ts++)).toThrow();
              }
            }
          }
          // identical trade lists
          totalTrades += engineTrades.length;
          expect(engineTrades).toEqual(ref.trades);
          // identical final balances for users + fee account
          for (const user of [...users, FEE_ACCOUNT]) {
            for (const asset of ['KRW', 'BTC']) {
              const e = ex.getBalances(user).find((b) => b.asset === asset) ?? {
                available: 0n,
                locked: 0n,
              };
              const r = ref.get(user, asset);
              expect({ user, asset, a: e.available, l: e.locked }).toEqual({
                user,
                asset,
                a: r.available,
                l: r.locked,
              });
            }
          }
          // identical open order remainders
          for (const [idx, engineId] of idxToEngineId) {
            const eo = ex.getOrder(engineId)!;
            const ro = ref.orders.find((x) => x.idx === idx)!;
            expect(eo.filledQty).toBe(ro.filled);
            expect(eo.status === 'open').toBe(ro.open);
          }
        },
      ),
      { numRuns: 120 },
    );
    // the generator must actually exercise matching and rejection paths
    expect(totalTrades).toBeGreaterThan(400);
    expect(totalRejects).toBeGreaterThan(0);
  });
});
