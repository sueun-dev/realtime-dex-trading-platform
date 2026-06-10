import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toUnits } from '@dex/shared';
import { api, isTickerWire, parseFill, parseMarket, parseOrder, parsePosition, parseTicker } from './lib/api.js';
import type { BookLevelWire, TradeWire } from './lib/api.js';
import { hasStoredKey, useAuthStore } from './lib/auth.js';
import { getWs } from './lib/ws.js';
import { useBookStore } from './stores/book.js';
import type { Level, TradeRow } from './stores/book.js';
import { useMarketStore } from './stores/market.js';
import { useUserStore } from './stores/user.js';
import { TopBar } from './components/TopBar.js';
import { ChartPanel } from './components/ChartPanel.js';
import { OrderBookPanel } from './components/OrderBookPanel.js';
import { OrderForm } from './components/OrderForm.js';
import { BottomPanel } from './components/BottomPanel.js';
import { MarketSelector } from './components/MarketSelector.js';
import { Toasts } from './components/Toasts.js';

function parseLevels(levels: BookLevelWire[] | undefined): Level[] {
  if (!Array.isArray(levels)) return [];
  return levels.map((l) => ({ price: toUnits(l.price), qty: toUnits(l.qty) }));
}

function parseTradeRow(w: TradeWire): TradeRow {
  return {
    id: w.id,
    price: toUnits(w.price),
    qty: toUnits(w.qty),
    takerSide: w.takerSide,
    ts: w.ts,
  };
}

interface BookMessage {
  type?: string;
  bids?: BookLevelWire[];
  asks?: BookLevelWire[];
  seq?: number;
}

export default function App() {
  const selectedId = useMarketStore((s) => s.selectedId);
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();

  // ---- markets (REST, slow refresh; live prices come over WS) ----
  const marketsQuery = useQuery({
    queryKey: ['markets'],
    queryFn: () => api.markets(),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    const wires = marketsQuery.data;
    if (wires === undefined) return;
    const store = useMarketStore.getState();
    store.setMarkets(wires.map(parseMarket));
    const seeded = wires
      .map((w) => w.ticker)
      .filter((t): t is NonNullable<typeof t> => t !== null && t !== undefined && isTickerWire(t))
      .map(parseTicker);
    if (seeded.length > 0) store.setTickers(seeded);
    // re-read the store: `store` is the snapshot from BEFORE setMarkets ran,
    // so its byId would always be empty on first load and clobber the default
    const fresh = useMarketStore.getState();
    if (fresh.byId[fresh.selectedId] === undefined && wires.length > 0) {
      fresh.selectMarket(wires[0]!.id);
    }
  }, [marketsQuery.data]);

  // ---- auto-login when a key is already stored ----
  useEffect(() => {
    if (hasStoredKey() && useAuthStore.getState().token === null) {
      useAuthStore
        .getState()
        .login()
        .then((t) => getWs().auth(t))
        .catch(() => {
          /* surfaced via wallet button on demand */
        });
    }
  }, []);

  // ---- global allTickers stream ----
  useEffect(() => {
    const ws = getWs();
    return ws.subscribe('allTickers', (data) => {
      const arr = Array.isArray(data) ? data : [data];
      const parsed = arr.filter(isTickerWire).map(parseTicker);
      if (parsed.length > 0) useMarketStore.getState().setTickers(parsed);
    });
  }, []);

  // ---- authed WS + user channel ----
  useEffect(() => {
    if (token === null) return;
    const ws = getWs();
    ws.auth(token);
    const unsubscribe = ws.subscribe('user', () => {
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['fills'] });
    });
    return unsubscribe;
  }, [token, queryClient]);

  // ---- per-market streams: ticker / orderbook (snapshot+deltas) / trades ----
  useEffect(() => {
    const ws = getWs();
    const book = useBookStore.getState();
    book.resetFor(selectedId);

    const unTicker = ws.subscribe(`ticker:${selectedId}`, (data) => {
      if (isTickerWire(data)) useMarketStore.getState().setTicker(parseTicker(data));
    });

    const unBook = ws.subscribe(`orderbook:${selectedId}`, (data, seq) => {
      const msg = data as BookMessage | null;
      if (msg === null || typeof msg !== 'object') return;
      const bids = parseLevels(msg.bids);
      const asks = parseLevels(msg.asks);
      const msgSeq = typeof msg.seq === 'number' ? msg.seq : (seq ?? 0);
      const store = useBookStore.getState();
      if (msg.type === 'delta') store.applyDelta(selectedId, bids, asks, msgSeq);
      else store.setSnapshot(selectedId, bids, asks, msgSeq);
    });

    const unTrades = ws.subscribe(`trades:${selectedId}`, (data) => {
      const arr = (Array.isArray(data) ? data : [data]) as TradeWire[];
      const rows = arr
        .filter((t) => t !== null && typeof t === 'object' && typeof t.price === 'string')
        .map(parseTradeRow)
        .sort((a, b) => b.ts - a.ts);
      useBookStore.getState().pushTrades(selectedId, rows);
    });

    // REST seed so the panel isn't empty until the first WS frame
    api
      .orderbook(selectedId, 20)
      .then((ob) => {
        useBookStore.getState().setSnapshot(selectedId, parseLevels(ob.bids), parseLevels(ob.asks), ob.seq);
      })
      .catch(() => undefined);
    api
      .trades(selectedId, 50)
      .then((rows) => {
        useBookStore
          .getState()
          .setTrades(selectedId, rows.map(parseTradeRow).sort((a, b) => b.ts - a.ts));
      })
      .catch(() => undefined);

    return () => {
      unTicker();
      unBook();
      unTrades();
    };
  }, [selectedId]);

  // ---- authed account/orders/fills polling (WS user events trigger refetch) ----
  const accountQuery = useQuery({
    queryKey: ['account'],
    queryFn: () => api.account(),
    enabled: token !== null,
    refetchInterval: 5000,
  });

  useEffect(() => {
    const acc = accountQuery.data;
    if (acc === undefined) return;
    const balances: Record<string, { available: bigint; locked: bigint }> = {};
    for (const b of acc.balances ?? []) {
      balances[b.asset] = { available: toUnits(b.available), locked: toUnits(b.locked) };
    }
    useUserStore.getState().setAccount({
      balances,
      positions: (acc.positions ?? []).map(parsePosition),
      perpEquity: toUnits(acc.perpEquity ?? '0'),
      marginUsed: toUnits(acc.marginUsed ?? '0'),
    });
  }, [accountQuery.data]);

  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: () => api.openOrders(),
    enabled: token !== null,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (ordersQuery.data === undefined) return;
    useUserStore.getState().setOpenOrders(ordersQuery.data.map(parseOrder));
  }, [ordersQuery.data]);

  const fillsQuery = useQuery({
    queryKey: ['fills'],
    queryFn: () => api.fills(),
    enabled: token !== null,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (fillsQuery.data === undefined) return;
    useUserStore.getState().setFills(fillsQuery.data.map(parseFill));
  }, [fillsQuery.data]);

  // clear user data on logout
  useEffect(() => {
    if (token === null) useUserStore.getState().clear();
  }, [token]);

  return (
    <div className="app">
      <TopBar />
      <main className="chart-area panel">
        <ChartPanel />
      </main>
      <section className="book-area panel">
        <OrderBookPanel />
      </section>
      <aside className="form-area panel">
        <OrderForm />
      </aside>
      <section className="bottom-area panel">
        <BottomPanel />
      </section>
      <MarketSelector />
      <Toasts />
    </div>
  );
}
