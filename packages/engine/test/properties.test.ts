import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CLEARING_ACCOUNT,
  DexError,
  absBig,
  feeOn,
  mulUnits,
  type MarketConfig,
  type OrderRequest,
  type TimeInForce,
} from '@dex/shared';
import { Exchange, spotBuyLock, type BookSide } from '../src/index.js';
import { ConservationTracker, PERP, SPOT, newExchange, req, u } from './helpers.js';

interface RawOp {
  k: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
}

const rawOp = fc.record({
  k: fc.nat(99),
  a: fc.nat(5),
  b: fc.nat(999),
  c: fc.nat(999),
  d: fc.nat(99),
  e: fc.nat(99),
});

const opSeq = fc.tuple(fc.integer({ min: 2, max: 6 }), fc.array(rawOp, { minLength: 10, maxLength: 60 }));

const ASSETS = ['KRW', 'BTC', 'USDC'] as const;

class Sim {
  readonly ex = newExchange();
  readonly t = new ConservationTracker();
  readonly users: string[];
  readonly orderIds: string[] = [];
  liquidations = 0;
  ts = 1;

  constructor(n: number) {
    this.users = Array.from({ length: n }, (_, i) => `u${i}`);
    const levs = [1, 20, 10, 5, 15, 3];
    this.users.forEach((user, i) => {
      this.dep(user, 'KRW', u(500_000_000));
      this.dep(user, 'BTC', u(100));
      this.dep(user, 'USDC', u(1_000_000));
      this.ex.setLeverage(user, PERP.id, levs[i % levs.length]!, this.ts++);
    });
  }

  private dep(user: string, asset: string, amount: bigint): void {
    this.ex.deposit(user, asset, amount, this.ts++);
    this.t.deposit(asset, amount);
  }

  private submit(user: string, r: OrderRequest): void {
    const evts = this.ex.submitOrder(user, r, this.ts++);
    for (const e of evts) {
      if (e.kind === 'orderAccepted') this.orderIds.push(e.order.id);
      if (e.kind === 'liquidation') this.liquidations++;
    }
  }

  apply(op: RawOp): void {
    const user = this.users[op.a % this.users.length]!;
    const { k } = op;
    if (k < 8) {
      this.dep(user, ASSETS[op.b % 3]!, u(1 + (op.b % 1000)));
    } else if (k < 14) {
      const asset = ASSETS[op.b % 3]!;
      const amount = u(1 + (op.c % 2000));
      try {
        this.ex.withdraw(user, asset, amount, this.ts++);
        this.t.withdraw(asset, amount);
      } catch (err) {
        if (!(err instanceof DexError)) throw err;
      }
    } else if (k < 52) {
      // spot order
      const side = op.b % 2 === 0 ? 'buy' : 'sell';
      const type = op.d % 10 < 3 ? 'market' : 'limit';
      const tif: TimeInForce =
        type === 'market' ? (op.e % 2 ? 'IOC' : 'FOK') : (['GTC', 'GTC', 'GTC', 'IOC', 'FOK'] as const)[op.e % 5]!;
      const price = SPOT.tickSize * BigInt(30 + (op.c % 20));
      const qty = SPOT.lotSize * BigInt(10 + (op.b % 500));
      this.submit(user, req(SPOT.id, side, type, price, qty, { tif, postOnly: type === 'limit' && op.e % 10 === 7 }));
    } else if (k < 78) {
      // perp order
      const side = op.b % 2 === 0 ? 'buy' : 'sell';
      const type = op.d % 10 < 3 ? 'market' : 'limit';
      const tif: TimeInForce =
        type === 'market' ? (op.e % 2 ? 'IOC' : 'FOK') : (['GTC', 'GTC', 'GTC', 'IOC', 'FOK'] as const)[op.e % 5]!;
      const price = PERP.tickSize * BigInt(90 + (op.c % 20));
      const qty = PERP.lotSize * BigInt(100 + (op.b % 2000));
      this.submit(
        user,
        req(PERP.id, side, type, price, qty, {
          tif,
          postOnly: type === 'limit' && op.e % 10 === 7,
          reduceOnly: op.e % 10 === 3,
        }),
      );
    } else if (k < 84) {
      if (this.orderIds.length > 0) {
        const id = this.orderIds[op.b % this.orderIds.length]!;
        const owner = this.ex.getOrder(id)!.userId;
        const caller = op.e % 7 === 0 ? user : owner; // occasionally exercise NOT_AUTHORIZED
        try {
          this.ex.cancelOrder(caller, id, this.ts++);
        } catch (err) {
          if (!(err instanceof DexError)) throw err;
        }
      }
    } else if (k < 92) {
      const price = PERP.tickSize * BigInt(30 + (op.c % 150));
      const evts = this.ex.setMarkPrice(PERP.id, price, this.ts++);
      this.liquidations += evts.filter((e) => e.kind === 'liquidation').length;
    } else if (k < 97) {
      const rate = BigInt(op.b - 500) * 100n; // ~±0.0005
      const evts = this.ex.applyFunding(PERP.id, rate, this.ts++);
      this.liquidations += evts.filter((e) => e.kind === 'liquidation').length;
    } else {
      try {
        this.ex.setLeverage(user, PERP.id, 1 + (op.d % 25), this.ts++);
      } catch (err) {
        if (!(err instanceof DexError)) throw err;
      }
    }
  }

  /** P5: order accounting — filledQty bounds, terminal/idle users hold zero locks. */
  checkOrders(): void {
    for (const id of this.orderIds) {
      const o = this.ex.getOrder(id)!;
      if (o.filledQty < 0n || o.filledQty > o.qty) throw new Error(`filledQty out of range for ${id}`);
      if (o.status === 'filled' && o.filledQty !== o.qty) throw new Error(`filled order not full ${id}`);
    }
    for (const user of this.users) {
      if (this.ex.getOpenOrders(user).length === 0) {
        for (const b of this.ex.getBalances(user)) {
          if (b.locked !== 0n) throw new Error(`idle user ${user} holds locked ${b.asset}`);
        }
      }
    }
  }

  cancelAll(): void {
    for (const user of this.users) {
      for (const o of this.ex.getOpenOrders(user)) this.ex.cancelOrder(user, o.id, this.ts++);
    }
  }
}

function bookSides(ex: Exchange): { market: MarketConfig; side: BookSide; isBid: boolean }[] {
  const markets = (
    ex as unknown as { markets: Map<string, { config: MarketConfig; book: { bids: BookSide; asks: BookSide } }> }
  ).markets;
  const out: { market: MarketConfig; side: BookSide; isBid: boolean }[] = [];
  for (const ms of markets.values()) {
    out.push({ market: ms.config, side: ms.book.bids, isBid: true });
    out.push({ market: ms.config, side: ms.book.asks, isBid: false });
  }
  return out;
}

/** P2: book never crossed at rest, levels sorted, FIFO within level. */
function checkBookIntegrity(ex: Exchange): void {
  const sides = bookSides(ex);
  for (const { market, side, isBid } of sides) {
    let prev: bigint | undefined;
    for (const lvl of side.levels) {
      if (lvl.orders.length === 0) throw new Error('empty level retained');
      if (prev !== undefined) {
        const ok = isBid ? lvl.price < prev : lvl.price > prev;
        if (!ok) throw new Error(`levels out of order on ${market.id}`);
      }
      prev = lvl.price;
      let prevSeq = -1;
      for (const o of lvl.orders) {
        if (o.price !== lvl.price) throw new Error('order price != level price');
        if (o.status !== 'open') throw new Error('non-open order resting');
        if (o.qty - o.filledQty <= 0n) throw new Error('zero-remaining order resting');
        if (o.seq <= prevSeq) throw new Error(`FIFO violated on ${market.id}@${lvl.price}`);
        prevSeq = o.seq;
      }
    }
  }
  for (const m of [SPOT, PERP]) {
    const snap = ex.getOrderbook(m.id, 1);
    const bestBid = snap.bids[0]?.price;
    const bestAsk = snap.asks[0]?.price;
    if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) {
      throw new Error(`book crossed at rest on ${m.id}`);
    }
  }
}

describe('property: cheap invariants (>=200 runs)', () => {
  it('spot buy lock budget always covers the fill notional (no lock underflow)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (pTicks, remLots, qLotsRaw, improve) => {
          const P = SPOT.tickSize * BigInt(pTicks);
          const rem = SPOT.lotSize * BigInt(remLots);
          const q = SPOT.lotSize * BigInt(1 + (qLotsRaw % remLots));
          const p = P - minOf(BigInt(improve) * SPOT.tickSize, P - SPOT.tickSize); // fill price <= limit
          const before = spotBuyLock(P, rem, SPOT.takerFeeBps);
          const after = spotBuyLock(P, rem - q, SPOT.takerFeeBps);
          const budget = before - after;
          const n = mulUnits(p, q);
          expect(budget >= n).toBe(true);
          expect(after >= 0n).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('single matched pair conserves funds exactly for arbitrary prices/qtys', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.boolean(),
        (mTicks, tTicks, mLots, tLots, makerIsBuy) => {
          const ex = newExchange();
          const t = new ConservationTracker();
          for (const user of ['m', 't']) {
            ex.deposit(user, 'KRW', u(100_000_000_000), 1);
            t.deposit('KRW', u(100_000_000_000));
            ex.deposit(user, 'BTC', u(10_000), 1);
            t.deposit('BTC', u(10_000));
          }
          const mp = SPOT.tickSize * BigInt(mTicks);
          const tp = SPOT.tickSize * BigInt(tTicks);
          ex.submitOrder('m', req(SPOT.id, makerIsBuy ? 'buy' : 'sell', 'limit', mp, SPOT.lotSize * BigInt(mLots)), 2);
          ex.submitOrder('t', req(SPOT.id, makerIsBuy ? 'sell' : 'buy', 'limit', tp, SPOT.lotSize * BigInt(tLots)), 3);
          t.check(ex);
          checkBookIntegrity(ex);
          // cancel rest and re-check
          for (const user of ['m', 't']) {
            for (const o of ex.getOpenOrders(user)) ex.cancelOrder(user, o.id, 4);
          }
          t.check(ex);
          for (const user of ['m', 't']) {
            for (const b of ex.getBalances(user)) expect(b.locked).toBe(0n);
          }
        },
      ),
      { numRuns: 250 },
    );
  });
});

function minOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

describe('property: op sequences (>=50 runs)', () => {
  it('P1+P5: conservation, non-negativity and order accounting after every op', () => {
    fc.assert(
      fc.property(opSeq, ([n, ops]) => {
        const sim = new Sim(n);
        sim.t.check(sim.ex);
        for (const op of ops) {
          sim.apply(op);
          sim.t.check(sim.ex); // throws on violation
          sim.checkOrders();
        }
        sim.cancelAll();
        sim.t.check(sim.ex);
        for (const user of sim.users) {
          for (const b of sim.ex.getBalances(user)) expect(b.locked).toBe(0n);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('P2: book integrity after every op', () => {
    fc.assert(
      fc.property(opSeq, ([n, ops]) => {
        const sim = new Sim(n);
        for (const op of ops) {
          sim.apply(op);
          checkBookIntegrity(sim.ex);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('P4: solvency — hypothetical force-close at a common mark returns clearing to ~0', () => {
    const perpOp = fc.record({
      a: fc.nat(3),
      b: fc.nat(999),
      c: fc.nat(999),
      d: fc.nat(99),
      e: fc.nat(99),
    });
    fc.assert(
      fc.property(fc.array(perpOp, { minLength: 5, maxLength: 40 }), (ops) => {
        const ex = newExchange();
        const users = ['u0', 'u1', 'u2', 'u3'];
        let ts = 1;
        for (const user of users) ex.deposit(user, 'USDC', u(10_000_000), ts++);
        let fills = 0;
        for (const op of ops) {
          const user = users[op.a % users.length]!;
          const side = op.b % 2 === 0 ? 'buy' : 'sell';
          const type = op.d % 10 < 3 ? 'market' : 'limit';
          const tif: TimeInForce = type === 'market' ? 'IOC' : (['GTC', 'GTC', 'IOC'] as const)[op.e % 3]!;
          const price = PERP.tickSize * BigInt(80 + (op.c % 40));
          const qty = PERP.lotSize * BigInt(100 + (op.b % 1500));
          const evts = ex.submitOrder(user, req(PERP.id, side, type, price, qty, { tif }), ts++);
          fills += evts.filter((e) => e.kind === 'trade').length;
          expect(evts.some((e) => e.kind === 'liquidation')).toBe(false);
        }
        const mark = u(100);
        let upnlSum = 0n;
        let sizeSum = 0n;
        let absSizeSum = 0n;
        let posCount = 0n;
        for (const user of users) {
          const p = ex.getPosition(user, PERP.id);
          if (!p) continue;
          posCount++;
          sizeSum += p.size;
          absSizeSum += absBig(p.size);
          upnlSum += p.size > 0n ? mulUnits(mark - p.entryPrice, p.size) : mulUnits(p.entryPrice - mark, -p.size);
        }
        expect(sizeSum).toBe(0n); // no liquidations -> OI balanced
        const clearing = ex.getBalances(CLEARING_ACCOUNT).find((b) => b.asset === 'USDC')?.available ?? 0n;
        const afterClose = clearing - upnlSum;
        // bound: a few units per fill + vwap-entry rounding proportional to size
        const bound = BigInt(fills) * 4n + absSizeSum / 10n ** 8n + posCount * 2n + 4n;
        expect(absBig(afterClose) <= bound).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it('feeOn never undercollects vs the clamped fee by more than rounding crumbs', () => {
    // documents the fee-clamp: charged fee == feeOn(n, bps) except when the
    // lock's fee reserve is short by floor/ceil crumbs across many fills
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 100 }), (units, bps) => {
        const n = BigInt(units);
        expect(feeOn(n, bps) >= (n * BigInt(bps)) / 10_000n).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
