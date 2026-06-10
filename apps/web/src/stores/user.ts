import { create } from 'zustand';
import type { FillData, OrderData, PositionData } from '../lib/api.js';

export interface BalanceEntry {
  available: bigint;
  locked: bigint;
}

export interface UserState {
  balances: Record<string, BalanceEntry>;
  positions: PositionData[];
  openOrders: OrderData[];
  fills: FillData[];
  perpEquity: bigint;
  marginUsed: bigint;
  setAccount: (acc: {
    balances: Record<string, BalanceEntry>;
    positions: PositionData[];
    perpEquity: bigint;
    marginUsed: bigint;
  }) => void;
  setOpenOrders: (orders: OrderData[]) => void;
  setFills: (fills: FillData[]) => void;
  clear: () => void;
}

export const useUserStore = create<UserState>()((set) => ({
  balances: {},
  positions: [],
  openOrders: [],
  fills: [],
  perpEquity: 0n,
  marginUsed: 0n,

  setAccount: (acc) =>
    set({
      balances: acc.balances,
      positions: acc.positions,
      perpEquity: acc.perpEquity,
      marginUsed: acc.marginUsed,
    }),

  setOpenOrders: (openOrders) => set({ openOrders }),
  setFills: (fills) => set({ fills }),

  clear: () =>
    set({
      balances: {},
      positions: [],
      openOrders: [],
      fills: [],
      perpEquity: 0n,
      marginUsed: 0n,
    }),
}));
