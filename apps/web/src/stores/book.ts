import { create } from 'zustand';
import type { Side } from '@dex/shared';

export interface Level {
  price: bigint;
  qty: bigint;
}

export interface TradeRow {
  id: string;
  price: bigint;
  qty: bigint;
  takerSide: Side;
  ts: number;
}

const MAX_TRADES = 60;

/** Merge delta levels into a sorted book side. qty 0 removes the level. */
export function mergeLevels(existing: Level[], updates: Level[], descending: boolean): Level[] {
  const map = new Map<bigint, bigint>();
  for (const l of existing) map.set(l.price, l.qty);
  for (const u of updates) {
    if (u.qty === 0n) map.delete(u.price);
    else map.set(u.price, u.qty);
  }
  const out: Level[] = [];
  for (const [price, qty] of map) out.push({ price, qty });
  out.sort((a, b) => {
    if (a.price === b.price) return 0;
    const lt = a.price < b.price;
    return (lt ? -1 : 1) * (descending ? -1 : 1);
  });
  return out;
}

export interface BookState {
  marketId: string | null;
  bids: Level[];
  asks: Level[];
  seq: number;
  trades: TradeRow[];
  resetFor: (marketId: string) => void;
  setSnapshot: (marketId: string, bids: Level[], asks: Level[], seq: number) => void;
  applyDelta: (marketId: string, bids: Level[], asks: Level[], seq: number) => void;
  setTrades: (marketId: string, rows: TradeRow[]) => void;
  pushTrades: (marketId: string, rows: TradeRow[]) => void;
}

export const useBookStore = create<BookState>()((set) => ({
  marketId: null,
  bids: [],
  asks: [],
  seq: 0,
  trades: [],

  resetFor: (marketId) => set({ marketId, bids: [], asks: [], seq: 0, trades: [] }),

  setSnapshot: (marketId, bids, asks, seq) =>
    set((s) => {
      if (s.marketId !== null && s.marketId !== marketId) return s;
      // never let a stale REST seed clobber a fresher WS snapshot
      if (s.marketId === marketId && seq > 0 && seq < s.seq) return s;
      return { marketId, bids, asks, seq };
    }),

  applyDelta: (marketId, bids, asks, seq) =>
    set((s) => {
      if (s.marketId !== marketId) return s;
      if (seq > 0 && seq <= s.seq) return s;
      return {
        bids: mergeLevels(s.bids, bids, true),
        asks: mergeLevels(s.asks, asks, false),
        seq: seq > 0 ? seq : s.seq,
      };
    }),

  setTrades: (marketId, rows) =>
    set((s) => {
      if (s.marketId !== marketId) return s;
      return { trades: rows.slice(0, MAX_TRADES) };
    }),

  pushTrades: (marketId, rows) =>
    set((s) => {
      if (s.marketId !== marketId || rows.length === 0) return s;
      const seen = new Set(rows.map((r) => r.id));
      const kept = s.trades.filter((t) => !seen.has(t.id));
      return { trades: [...rows, ...kept].slice(0, MAX_TRADES) };
    }),
}));
