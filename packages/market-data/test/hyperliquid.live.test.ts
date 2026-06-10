/** LIVE tests — real Hyperliquid public API. Run via `pnpm test:live`. */
import { describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import { HyperliquidRest } from '../src/hyperliquid.js';
import { HyperliquidWs } from '../src/hyperliquidWs.js';
import { LIVE_TIMEOUT, withNetRetry } from './live.helpers.js';

const rest = new HyperliquidRest();

describe('Hyperliquid REST (live)', () => {
  it(
    'meta contains BTC and ETH with sane szDecimals/maxLeverage',
    async () => {
      const universe = await withNetRetry(() => rest.meta());
      expect(universe.length).toBeGreaterThanOrEqual(50);
      for (const name of ['BTC', 'ETH']) {
        const asset = universe.find((a) => a.name === name);
        expect(asset, `missing ${name}`).toBeDefined();
        expect(Number.isInteger(asset!.szDecimals)).toBe(true);
        expect(asset!.szDecimals).toBeGreaterThanOrEqual(0);
        expect(asset!.szDecimals).toBeLessThanOrEqual(8);
        expect(Number.isInteger(asset!.maxLeverage)).toBe(true);
        expect(asset!.maxLeverage).toBeGreaterThanOrEqual(10);
        expect(asset!.maxLeverage).toBeLessThanOrEqual(200);
        expect(asset!.isDelisted).not.toBe(true);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'allMids has BTC > 0 and no @/# index keys',
    async () => {
      const mids = await withNetRetry(() => rest.allMids());
      expect(mids.size).toBeGreaterThanOrEqual(100);
      const btc = mids.get('BTC');
      expect(btc).toBeDefined();
      expect(btc! > 0n).toBe(true);
      expect(btc! > toUnits('1000'), 'BTC mid should be > $1000').toBe(true);
      for (const k of mids.keys()) {
        expect(k.startsWith('@') || k.startsWith('#'), `index key leaked: ${k}`).toBe(false);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'BTC 1h candleSnapshot over the last 24h is valid',
    async () => {
      const end = Date.now();
      const start = end - 24 * 3_600_000;
      const candles = await withNetRetry(() => rest.candleSnapshot('BTC', '1h', start, end));
      expect(candles.length).toBeGreaterThanOrEqual(20);
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]!;
        if (i > 0) expect(c.t).toBeGreaterThan(candles[i - 1]!.t);
        expect(c.o > 0n && c.h > 0n && c.l > 0n && c.c > 0n).toBe(true);
        expect(c.l <= c.o && c.l <= c.c, `l <= min(o,c) at ${c.t}`).toBe(true);
        expect(c.h >= c.o && c.h >= c.c, `h >= max(o,c) at ${c.t}`).toBe(true);
        expect(c.v >= 0n).toBe(true);
      }
      const newest = candles[candles.length - 1]!;
      expect(end - newest.t, 'newest 1h candle should be < 2h old').toBeLessThan(2 * 3_600_000);
    },
    LIVE_TIMEOUT,
  );

  it(
    'fundingHistory for BTC parses signed hourly rates',
    async () => {
      const start = Date.now() - 12 * 3_600_000;
      const points = await withNetRetry(() => rest.fundingHistory('BTC', start));
      expect(points.length).toBeGreaterThanOrEqual(6); // hourly funding
      for (let i = 0; i < points.length; i++) {
        const p = points[i]!;
        expect(typeof p.fundingRate).toBe('bigint');
        // |hourly rate| sane: < 1% (1e6 in 1e8 units)
        expect(p.fundingRate > -1_000_000n && p.fundingRate < 1_000_000n, `rate sane: ${p.fundingRate}`).toBe(true);
        expect(p.time).toBeGreaterThanOrEqual(start - 3_600_000);
        if (i > 0) expect(p.time).toBeGreaterThan(points[i - 1]!.time);
      }
    },
    LIVE_TIMEOUT,
  );
});

describe('Hyperliquid WS (live)', () => {
  it(
    'receives an allMids snapshot with BTC within 25s',
    async () => {
      const ws = new HyperliquidWs();
      try {
        const mids = await new Promise<Map<string, bigint>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no allMids within 25s')), 25_000);
          ws.on('mids', (m: Map<string, bigint>) => {
            if (m.has('BTC')) {
              clearTimeout(timer);
              resolve(m);
            }
          });
          ws.on('wsError', () => {
            /* transient socket errors handled by reconnect */
          });
          ws.connect();
        });
        expect(mids.get('BTC')! > 0n).toBe(true);
        expect(mids.size).toBeGreaterThanOrEqual(50);
      } finally {
        ws.close();
      }
    },
    LIVE_TIMEOUT,
  );
});
