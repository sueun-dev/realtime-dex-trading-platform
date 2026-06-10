/**
 * Price-time priority limit order book: sorted price levels, FIFO queues.
 */
import {
  DexError,
  type BookLevel,
  type Order,
  type OrderbookSnapshot,
} from '@dex/shared';

/** Internal order entry: public Order + engine-private accounting fields. */
export interface EngineOrder extends Order {
  /** quote (spot buy / perp) or base (spot sell) still locked for this order */
  lockRemaining: bigint;
  /** asset of lockRemaining; null when nothing was locked (perp reduceOnly) */
  lockAsset: string | null;
  /** per-market user leverage captured at acceptance (1 for spot) */
  leverage: number;
  /** true while resting in the book */
  resting: boolean;
}

export function remainingQty(o: Order): bigint {
  return o.qty - o.filledQty;
}

export function toPublicOrder(o: EngineOrder): Order {
  return {
    id: o.id,
    userId: o.userId,
    marketId: o.marketId,
    side: o.side,
    type: o.type,
    price: o.price,
    qty: o.qty,
    filledQty: o.filledQty,
    status: o.status,
    tif: o.tif,
    postOnly: o.postOnly,
    reduceOnly: o.reduceOnly,
    clientOrderId: o.clientOrderId,
    seq: o.seq,
    ts: o.ts,
  };
}

interface Level {
  price: bigint;
  orders: EngineOrder[];
}

export class BookSide {
  /** sorted best-first: bids descending price, asks ascending price */
  readonly levels: Level[] = [];

  constructor(readonly isBid: boolean) {}

  /** negative when price `a` is strictly better (closer to the front) than `b` */
  private cmp(a: bigint, b: bigint): number {
    if (a === b) return 0;
    if (this.isBid) return a > b ? -1 : 1;
    return a < b ? -1 : 1;
  }

  /** Is a level at `price` within the taker's worst-acceptable `bound`? */
  inBound(price: bigint, bound: bigint): boolean {
    return this.isBid ? price >= bound : price <= bound;
  }

  best(): Level | undefined {
    return this.levels[0];
  }

  insert(o: EngineOrder): void {
    const p = o.price;
    if (p === null) throw new DexError('INTERNAL', 'resting order without price');
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cmp(this.levels[mid]!.price, p) < 0) lo = mid + 1;
      else hi = mid;
    }
    const at = this.levels[lo];
    if (at && at.price === p) at.orders.push(o);
    else this.levels.splice(lo, 0, { price: p, orders: [o] });
  }

  remove(o: EngineOrder): void {
    const p = o.price;
    if (p === null) throw new DexError('INTERNAL', 'remove: order without price');
    const idx = this.levels.findIndex((l) => l.price === p);
    if (idx < 0) throw new DexError('INTERNAL', `remove: level ${p} not found`);
    const lvl = this.levels[idx]!;
    const oi = lvl.orders.findIndex((x) => x.id === o.id);
    if (oi < 0) throw new DexError('INTERNAL', `remove: order ${o.id} not at level`);
    lvl.orders.splice(oi, 1);
    if (lvl.orders.length === 0) this.levels.splice(idx, 1);
  }

  /** Drop a level if it has become empty (after fills consumed its head). */
  pruneIfEmpty(lvl: Level): void {
    if (lvl.orders.length === 0) {
      const idx = this.levels.indexOf(lvl);
      if (idx >= 0) this.levels.splice(idx, 1);
    }
  }

  /** Total remaining qty resting within `bound`, excluding `excludeUser`'s orders. */
  qtyWithin(bound: bigint, excludeUser?: string): bigint {
    let total = 0n;
    for (const lvl of this.levels) {
      if (!this.inBound(lvl.price, bound)) break;
      for (const o of lvl.orders) {
        if (excludeUser !== undefined && o.userId === excludeUser) continue;
        total += remainingQty(o);
      }
    }
    return total;
  }

  isEmpty(): boolean {
    return this.levels.length === 0;
  }

  depth(n: number): BookLevel[] {
    const out: BookLevel[] = [];
    for (const lvl of this.levels) {
      if (out.length >= n) break;
      let qty = 0n;
      for (const o of lvl.orders) qty += remainingQty(o);
      out.push({ price: lvl.price, qty });
    }
    return out;
  }
}

export class OrderBook {
  readonly bids = new BookSide(true);
  readonly asks = new BookSide(false);

  side(side: 'buy' | 'sell'): BookSide {
    return side === 'buy' ? this.bids : this.asks;
  }

  /** The side a taker of `takerSide` matches against. */
  opposite(takerSide: 'buy' | 'sell'): BookSide {
    return takerSide === 'buy' ? this.asks : this.bids;
  }

  snapshot(marketId: string, seq: number, depth: number): OrderbookSnapshot {
    return {
      marketId,
      bids: this.bids.depth(depth),
      asks: this.asks.depth(depth),
      seq,
    };
  }
}
