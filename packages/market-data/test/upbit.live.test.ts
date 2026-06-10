/** LIVE tests — real Upbit public API. Run via `pnpm test:live`. */
import { describe, expect, it } from 'vitest';
import type { CandleInterval, Ticker } from '@dex/shared';
import { UpbitRest } from '../src/upbit.js';
import { UpbitWs } from '../src/upbitWs.js';
import { INTERVAL_MS } from '../src/candles.js';
import { LIVE_TIMEOUT, sleep, withNetRetry } from './live.helpers.js';

const rest = new UpbitRest();

describe('Upbit REST (live)', () => {
  it(
    'market list has >=80 KRW markets incl. BTC/ETH/XRP with Korean names',
    async () => {
      const markets = await withNetRetry(() => rest.fetchMarkets());
      const krw = markets.filter((m) => m.market.startsWith('KRW-'));
      expect(krw.length).toBeGreaterThanOrEqual(80);
      for (const id of ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']) {
        const m = krw.find((x) => x.market === id);
        expect(m, `missing ${id}`).toBeDefined();
        expect(m!.korean_name.length).toBeGreaterThan(0);
        expect(/[가-힣]/.test(m!.korean_name), `${id} korean_name should contain Hangul`).toBe(true);
        expect(m!.english_name.length).toBeGreaterThan(0);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'KRW-BTC candles are valid for ALL 6 intervals (ascending, OHLC-sane, recent)',
    async () => {
      const intervals: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
      for (const interval of intervals) {
        const candles = await withNetRetry(() => rest.fetchCandles('KRW-BTC', interval, 30));
        expect(candles.length, `${interval}: expected 30 candles`).toBe(30);
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i]!;
          if (i > 0) expect(c.t, `${interval}: ascending t`).toBeGreaterThan(candles[i - 1]!.t);
          expect(c.o > 0n && c.h > 0n && c.l > 0n && c.c > 0n, `${interval}: positive OHLC`).toBe(true);
          expect(c.v >= 0n, `${interval}: non-negative volume`).toBe(true);
          expect(c.l <= c.o && c.l <= c.c, `${interval}: l <= min(o,c) at ${c.t}`).toBe(true);
          expect(c.h >= c.o && c.h >= c.c, `${interval}: h >= max(o,c) at ${c.t}`).toBe(true);
        }
        // newest candle must be recent: within 2 buckets of now
        const newest = candles[candles.length - 1]!;
        expect(Date.now() - newest.t, `${interval}: stale newest candle`).toBeLessThan(2 * INTERVAL_MS[interval]);
        await sleep(250); // stay under Upbit rate limits
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'tickers for 5 markets parse with sane values',
    async () => {
      const ids = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'];
      const tickers = await withNetRetry(() => rest.fetchTickers(ids));
      expect(tickers).toHaveLength(5);
      for (const t of tickers) {
        expect(ids).toContain(t.marketId);
        expect(t.price > 0n, `${t.marketId}: price > 0`).toBe(true);
        expect(t.high24h >= t.low24h, `${t.marketId}: high >= low`).toBe(true);
        expect(t.price >= t.low24h && t.price <= t.high24h, `${t.marketId}: price within 24h range`).toBe(true);
        expect(t.volume24h > 0n, `${t.marketId}: 24h volume > 0`).toBe(true);
        expect(Math.abs(Date.now() - t.ts), `${t.marketId}: recent ts`).toBeLessThan(24 * 3_600_000);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'recent trades for KRW-BTC parse with positive price/qty',
    async () => {
      const trades = await withNetRetry(() => rest.fetchRecentTrades('KRW-BTC', 20));
      expect(trades.length).toBe(20);
      for (const t of trades) {
        expect(t.marketId).toBe('KRW-BTC');
        expect(t.price > 0n).toBe(true);
        expect(t.qty > 0n).toBe(true);
        expect(['buy', 'sell']).toContain(t.side);
        expect(typeof t.sequentialId).toBe('bigint');
        expect(t.sequentialId > 0n).toBe(true);
      }
      // sequential_id is parsed with full >2^53 precision → ids must be unique
      expect(new Set(trades.map((t) => t.sequentialId)).size).toBe(trades.length);
    },
    LIVE_TIMEOUT,
  );
});

describe('Upbit WS (live)', () => {
  it(
    'receives a KRW-BTC ticker within 25s',
    async () => {
      const ws = new UpbitWs(['KRW-BTC']);
      try {
        const ticker = await new Promise<Ticker>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no KRW-BTC ticker within 25s')), 25_000);
          ws.on('ticker', (t: Ticker) => {
            if (t.marketId === 'KRW-BTC') {
              clearTimeout(timer);
              resolve(t);
            }
          });
          ws.on('wsError', () => {
            /* transient socket errors are fine; reconnect logic handles them */
          });
          ws.connect();
        });
        expect(ticker.marketId).toBe('KRW-BTC');
        expect(ticker.price > 0n).toBe(true);
        expect(ticker.high24h >= ticker.low24h).toBe(true);
        expect(ticker.volume24h > 0n).toBe(true);
      } finally {
        ws.close();
      }
    },
    LIVE_TIMEOUT,
  );
});
