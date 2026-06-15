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

export interface BookState {
  marketId: string | null;
  bids: Level[];
  asks: Level[];
  seq: number;
  /** Server-reported staleness of the venue feed; true → don't present as live. */
  stale: boolean;
  trades: TradeRow[];
  resetFor: (marketId: string) => void;
  // The live feed only ever sends full snapshots (never deltas). `stale` is
  // optional so existing/test callers that omit it keep working.
  setSnapshot: (marketId: string, bids: Level[], asks: Level[], seq: number, stale?: boolean) => void;
  setTrades: (marketId: string, rows: TradeRow[]) => void;
  pushTrades: (marketId: string, rows: TradeRow[]) => void;
}

export const useBookStore = create<BookState>()((set) => ({
  marketId: null,
  bids: [],
  asks: [],
  seq: 0,
  stale: false,
  trades: [],

  resetFor: (marketId) => set({ marketId, bids: [], asks: [], seq: 0, stale: false, trades: [] }),

  setSnapshot: (marketId, bids, asks, seq, stale = false) =>
    set((s) => {
      if (s.marketId !== null && s.marketId !== marketId) return s;
      // never let a stale REST seed clobber a fresher WS snapshot
      if (s.marketId === marketId && seq > 0 && seq < s.seq) return s;
      return { marketId, bids, asks, seq, stale };
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
