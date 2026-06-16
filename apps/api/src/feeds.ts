/**
 * Live real-data feeds:
 *  - Upbit WS tickers for every USDC spot market → PriceCache (→ hub broadcast)
 *  - Hyperliquid WS allMids → perp tickers + engine mark prices (throttled)
 *  - 24h perp stats refreshed from real Hyperliquid 1h candles every 5 minutes
 *  - Upbit REST ticker poll every 30s as a WS-gap fallback
 */
import {
  HyperliquidWs,
  PriceOracle,
  UpbitWs,
  INTERVAL_MS,
  spotMarketIdForUpbitCode,
  upbitCodeForSpotMarket,
  type HlTrade,
  type PublicTrade,
} from '@dex/market-data';
import { divUnits, emaStep, maxBig, medianBig, minBig, toUnits, type MarketConfig, type Ticker } from '@dex/shared';
import { fetchTickersChunked, type Services, type Stoppable } from './services.js';

const MARK_THROTTLE_MS = 1000;
const STATS_REFRESH_MS = 5 * 60_000;
const SPOT_POLL_MS = 30_000;
/** how often to refresh the external oracle sources (OKX/Coinbase) */
const ORACLE_POLL_MS = 5_000;
/** EMA smoothing applied to the median-of-real-sources mark (damps spikes) */
const MARK_EMA_ALPHA = toUnits('0.3');
/**
 * Perp bases that get a manipulation-resistant multi-source mark (HL mid + OKX
 * swap + Coinbase spot → median + EMA). Long-tail HL-only perps keep the HL
 * venue mark. Kept to liquid majors so the Coinbase poll stays well under rate
 * limits and the median always has ≥2 independent real sources.
 */
const ORACLE_MAJORS = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'LTC', 'BCH', 'ADA',
  'DOT', 'MATIC', 'APT', 'ARB', 'OP', 'SUI', 'TIA', 'SEI', 'INJ', 'NEAR',
]);

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
  const markEma = new Map<string, bigint>(); // per-market EMA state for the robust mark

  // multi-source oracle: real OKX swap + Coinbase spot for the liquid majors
  const oracle = new PriceOracle();
  const oracleCoins = [...new Set(perps.map((m) => m.base).filter((b) => ORACLE_MAJORS.has(b)))];

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
      applyPerpMid(m, mid, now);
    }
  });
  hlWs.connect();

  /**
   * Robust mark for a perp: median of all independent REAL sources (the HL mid
   * we mirror + fresh OKX/Coinbase prices), smoothed by an EMA. A single
   * manipulated source cannot move a ≥3-source median; the EMA damps transient
   * spikes. Long-tail coins with no external source fall back to the HL mid
   * (the actual venue) — never a fabricated value.
   */
  function robustMark(m: MarketConfig, hlMid: bigint): bigint {
    const sources = [hlMid, ...oracle.externalPrices(m.base)];
    const med = medianBig(sources);
    const mark = emaStep(markEma.get(m.id) ?? null, med, MARK_EMA_ALPHA);
    markEma.set(m.id, mark);
    return mark;
  }

  /** Push a real HL mid into the ticker (only with real 24h stats) + the robust mark. */
  function applyPerpMid(m: MarketConfig, hlMid: bigint, now: number): void {
    const mark = robustMark(m, hlMid);
    const st = stats.get(m.id);
    // Do NOT publish fabricated 24h stats (0 / mid placeholders) before the
    // first real candle refresh — emit the ticker only once real stats exist.
    if (st !== undefined) {
      priceCache.setTicker({
        marketId: m.id,
        price: mark,
        change24h: st.prevClose > 0n ? divUnits(mark - st.prevClose, st.prevClose) : 0n,
        high24h: maxBig(st.high, mark),
        low24h: minBig(st.low, mark),
        volume24h: st.volume,
        ts: now,
      });
    }
    const last = lastMark.get(m.id);
    if (!last || (now - last.at >= MARK_THROTTLE_MS && mark !== last.price)) {
      lastMark.set(m.id, { price: mark, at: now });
      void pipeline
        .exec(() => engine.setMarkPrice(m.id, mark, Date.now()))
        .catch((e: unknown) => log(`mark price ${m.id} failed: ${String(e)}`));
    }
  }

  // ---- 24h perp stats from real 1h candles -----------------------------------
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const refreshOne = async (m: MarketConfig): Promise<void> => {
    try {
      const end = Date.now();
      const candles = await svc.hl.candleSnapshot(m.base, '1h', end - 25 * INTERVAL_MS['1h'], end);
      if (candles.length === 0) return;
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
  };
  // chunked-parallel so real 24h stats are ready within ~1s of boot (perp
  // tickers stay suppressed until then rather than showing placeholders)
  const refreshStats = async (): Promise<void> => {
    const CHUNK = 8;
    for (let i = 0; i < perps.length && !stopped; i += CHUNK) {
      await Promise.all(perps.slice(i, i + CHUNK).map(refreshOne));
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

  // ---- perp REST fallback poll: keeps marks/tickers fresh if the HL WS drops
  // (otherwise a frozen perp mark would be served as live indefinitely) -------
  const perpPollTimer = setInterval(() => {
    void svc.hl
      .allMids()
      .then((mids) => {
        const now = Date.now();
        for (const [coin, mid] of mids) {
          const m = perpByCoin.get(coin);
          if (m && mid > 0n) applyPerpMid(m, mid, now);
        }
      })
      .catch((e: unknown) => log(`perp mids poll failed: ${String(e)}`));
  }, SPOT_POLL_MS);
  perpPollTimer.unref?.();

  // ---- multi-source oracle poll: refresh real OKX/Coinbase prices for majors --
  let oracleTimer: ReturnType<typeof setInterval> | null = null;
  if (oracleCoins.length > 0) {
    const pollOracle = (): void => {
      void oracle.refresh(oracleCoins).catch((e: unknown) => log(`oracle refresh failed: ${String(e)}`));
    };
    pollOracle(); // prime immediately so the first marks are already multi-source
    oracleTimer = setInterval(pollOracle, ORACLE_POLL_MS);
    oracleTimer.unref?.();
  }

  return {
    stop() {
      stopped = true;
      upbitWs.close();
      hlWs.close();
      if (statsTimer !== null) clearTimeout(statsTimer);
      clearInterval(pollTimer);
      clearInterval(perpPollTimer);
      if (oracleTimer !== null) clearInterval(oracleTimer);
    },
  };
}
