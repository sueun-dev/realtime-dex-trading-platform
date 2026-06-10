import { create } from 'zustand';
import type { Market, TickerData } from '../lib/api.js';

export interface MarketState {
  markets: Market[];
  byId: Record<string, Market>;
  tickers: Record<string, TickerData>;
  selectedId: string;
  selectorOpen: boolean;
  setMarkets: (markets: Market[]) => void;
  setTicker: (t: TickerData) => void;
  setTickers: (ts: TickerData[]) => void;
  selectMarket: (id: string) => void;
  setSelectorOpen: (open: boolean) => void;
}

export const useMarketStore = create<MarketState>()((set) => ({
  markets: [],
  byId: {},
  tickers: {},
  selectedId: 'BTC-USDC',
  selectorOpen: false,

  setMarkets: (markets) =>
    set({
      markets,
      byId: Object.fromEntries(markets.map((m) => [m.id, m])),
    }),

  setTicker: (t) =>
    set((s) => ({ tickers: { ...s.tickers, [t.marketId]: t } })),

  setTickers: (ts) =>
    set((s) => {
      if (ts.length === 0) return s;
      const tickers = { ...s.tickers };
      for (const t of ts) tickers[t.marketId] = t;
      return { tickers };
    }),

  selectMarket: (id) => set({ selectedId: id, selectorOpen: false }),
  setSelectorOpen: (open) => set({ selectorOpen: open }),
}));
