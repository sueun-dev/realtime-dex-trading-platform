/**
 * Live real-data feeds:
 *  - Upbit WS tickers for every KRW spot market → PriceCache (→ hub broadcast)
 *  - Hyperliquid WS allMids → perp tickers + engine mark prices (throttled)
 *  - 24h perp stats refreshed from real Hyperliquid 1h candles every 5 minutes
 *  - Upbit REST ticker poll every 30s as a WS-gap fallback
 */
import {
  HyperliquidWs,
  UpbitWs,
  INTERVAL_MS,
  spotMarketIdForUpbitCode,
  upbitCodeForSpotMarket,
  type HlTrade,
  type PublicTrade,
} from '@dex/market-data';
import { divUnits, maxBig, minBig, type Ticker } from '@dex/shared';
import { fetchTickersChunked, type Services, type Stoppable } from './services.js';

const MARK_THROTTLE_MS = 1000;
const STATS_REFRESH_MS = 5 * 60_000;
const SPOT_POLL_MS = 30_000;

interface PerpStats {
  prevClose: bigint;
  high: bigint;
  low: bigint;
  volume: bigint;
}

export function startFeeds(svc: Services): Stoppable {
  const { engine, pipeline, priceCache, hub, log } = svc;
  const markets = engine.getMarkets();
  const spots = markets.filter((m) => m.type === 'spot');
  // subscribe Upbit by its native USDT codes; relabel back to <base>-USDC
  const spotUpbitCodes = spots.map((m) => upbitCodeForSpotMarket(m.id));
  const perps = markets.filter((m) => m.type === 'perp');
  const perpByCoin = new Map(perps.map((m) => [m.base, m]));
  const stats = new Map<string, PerpStats>();
  const lastMark = new Map<string, { price: bigint; at: number }>();

  // ---- spot: Upbit websocket (tickers + REAL market prints) -------------------
  const upbitWs = new UpbitWs(spotUpbitCodes);
  upbitWs.on('ticker', (t: Ticker) =>
    priceCache.setTicker({ ...t, marketId: spotMarketIdForUpbitCode(t.marketId) }),
  );
  upbitWs.on('trade', (t: PublicTrade) =>
    hub.publishExternalTrade({
      id: `u${t.sequentialId}`,
      marketId: spotMarketIdForUpbitCode(t.marketId),
      price: t.price,
      qty: t.qty,
      takerSide: t.side,
      ts: t.ts,
    }),
  );
  upbitWs.on('wsError', () => {
    /* reconnect handles it */
  });
  upbitWs.connect();

  // ---- perp: Hyperliquid websocket (mids + REAL market prints) ----------------
  const hlWs = new HyperliquidWs({ tradeCoins: perps.map((m) => m.base) });
  hlWs.on('trades', (trades: HlTrade[]) => {
    for (const t of trades) {
      const m = perpByCoin.get(t.coin);
      if (!m) continue;
      hub.publishExternalTrade({
        id: `h${t.tid}`,
        marketId: m.id,
        price: t.price,
        qty: t.qty,
        takerSide: t.side,
        ts: t.ts,
      });
    }
  });
  hlWs.on('mids', (mids: Map<string, bigint>) => {
    const now = Date.now();
    for (const [coin, mid] of mids) {
      const m = perpByCoin.get(coin);
      if (!m || mid <= 0n) continue;
      const st = stats.get(m.id);
      priceCache.setTicker({
        marketId: m.id,
        price: mid,
        change24h: st && st.prevClose > 0n ? divUnits(mid - st.prevClose, st.prevClose) : 0n,
        high24h: st ? maxBig(st.high, mid) : mid,
        low24h: st ? minBig(st.low, mid) : mid,
        volume24h: st?.volume ?? 0n,
        ts: now,
      });
      const last = lastMark.get(m.id);
      if (!last || (now - last.at >= MARK_THROTTLE_MS && mid !== last.price)) {
        lastMark.set(m.id, { price: mid, at: now });
        void pipeline
          .exec(() => engine.setMarkPrice(m.id, mid, Date.now()))
          .catch((e: unknown) => log(`mark price ${m.id} failed: ${String(e)}`));
      }
    }
  });
  hlWs.connect();

  // ---- 24h perp stats from real 1h candles -----------------------------------
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const refreshStats = async (): Promise<void> => {
    for (const m of perps) {
      if (stopped) return;
      try {
        const end = Date.now();
        const candles = await svc.hl.candleSnapshot(m.base, '1h', end - 25 * INTERVAL_MS['1h'], end);
        if (candles.length === 0) continue;
        const window = candles.slice(-25);
        const first = window[0]!;
        let high = first.h;
        let low = first.l;
        let volume = 0n;
        for (const c of window) {
          high = maxBig(high, c.h);
          low = minBig(low, c.l);
          volume += c.v;
        }
        stats.set(m.id, { prevClose: first.c, high, low, volume });
      } catch (e) {
        log(`perp stats ${m.id} failed: ${String(e)}`);
      }
    }
  };
  const scheduleStats = (): void => {
    statsTimer = setTimeout(() => {
      void refreshStats().then(scheduleStats);
    }, STATS_REFRESH_MS);
    statsTimer.unref?.();
  };
  void refreshStats().then(scheduleStats);

  // ---- spot REST fallback poll ------------------------------------------------
  const pollTimer = setInterval(() => {
    void fetchTickersChunked(svc.upbit, spotUpbitCodes)
      .then((tickers) => {
        for (const t of tickers) {
          priceCache.setTicker({ ...t, marketId: spotMarketIdForUpbitCode(t.marketId) });
        }
      })
      .catch((e: unknown) => log(`spot ticker poll failed: ${String(e)}`));
  }, SPOT_POLL_MS);
  pollTimer.unref?.();

  return {
    stop() {
      stopped = true;
      upbitWs.close();
      hlWs.close();
      if (statsTimer !== null) clearTimeout(statsTimer);
      clearInterval(pollTimer);
    },
  };
}
