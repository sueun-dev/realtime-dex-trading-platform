import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { toUnits } from '@dex/shared';
import type { Market, TickerData } from '../src/lib/api.js';
import { useAuthStore } from '../src/lib/auth.js';
import { useBookStore } from '../src/stores/book.js';
import { useMarketStore } from '../src/stores/market.js';
import { useOrderFormStore } from '../src/stores/orderform.js';
import { useToastStore } from '../src/stores/toast.js';
import { useUserStore } from '../src/stores/user.js';

export const SPOT_BTC: Market = {
  id: 'BTC-USDC',
  type: 'spot',
  base: 'BTC',
  quote: 'USDC',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  tickSize: toUnits('1'),
  lotSize: toUnits('0.0001'),
  minNotional: toUnits('1'),
  makerFeeBps: 5,
  takerFeeBps: 10,
  maxLeverage: 1,
};

export const SPOT_ETH: Market = {
  id: 'ETH-USDC',
  type: 'spot',
  base: 'ETH',
  quote: 'USDC',
  koreanName: '이더리움',
  englishName: 'Ethereum',
  tickSize: toUnits('0.1'),
  lotSize: toUnits('0.0001'),
  minNotional: toUnits('1'),
  makerFeeBps: 5,
  takerFeeBps: 10,
  maxLeverage: 1,
};

export const PERP_BTC: Market = {
  id: 'BTC-PERP',
  type: 'perp',
  base: 'BTC',
  quote: 'USDC',
  koreanName: null,
  englishName: 'Bitcoin',
  tickSize: toUnits('0.1'),
  lotSize: toUnits('0.001'),
  minNotional: toUnits('10'),
  makerFeeBps: 2,
  takerFeeBps: 5,
  maxLeverage: 50,
};

export const PERP_ETH: Market = {
  ...PERP_BTC,
  id: 'ETH-PERP',
  base: 'ETH',
  englishName: 'Ethereum',
};

export function ticker(marketId: string, price: string, change = '0'): TickerData {
  return {
    marketId,
    price: toUnits(price),
    change24h: toUnits(change),
    high24h: toUnits(price),
    low24h: toUnits(price),
    volume24h: toUnits('0'),
    ts: Date.now(),
  };
}

export function seedMarkets(markets: Market[], selectedId: string): void {
  useMarketStore.setState({
    markets,
    byId: Object.fromEntries(markets.map((m) => [m.id, m])),
    selectedId,
    selectorOpen: false,
    tickers: {},
  });
}

export function resetStores(): void {
  seedMarkets([], 'BTC-USDC');
  useBookStore.setState({ marketId: null, bids: [], asks: [], seq: 0, trades: [] });
  useUserStore.setState({
    balances: {},
    positions: [],
    openOrders: [],
    fills: [],
    perpEquity: 0n,
    marginUsed: 0n,
  });
  useToastStore.setState({ toasts: [] });
  useOrderFormStore.setState({ priceStr: '' });
  useAuthStore.setState({ address: null, token: null, status: 'idle' });
}

export function renderWithQuery(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}
