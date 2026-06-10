/**
 * Boots the API against the REAL Upbit + Hyperliquid universes (network).
 * Verifies the served market list, tickers, and candles are real data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import { makeApp, type TestApp } from './helpers.js';

let t: TestApp;

interface MarketWire {
  id: string;
  type: string;
  quote: string;
  koreanName: string | null;
  tickSize: string;
  lotSize: string;
  maxLeverage: number;
  ticker: { price: string } | null;
}

beforeAll(async () => {
  t = await makeApp({ universe: 'live' });
}, 90_000);
afterAll(async () => {
  await t.stop();
});

describe('live universe boot (real Upbit + Hyperliquid data)', () => {
  it('serves the real USDC spot universe + perps, with NO fiat', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets' });
    expect(res.statusCode).toBe(200);
    const markets = res.json() as MarketWire[];
    const spot = markets.filter((m) => m.type === 'spot');
    const perp = markets.filter((m) => m.type === 'perp');
    expect(spot.length).toBeGreaterThanOrEqual(80);
    expect(perp.length).toBeGreaterThanOrEqual(15);
    // a DEX has no fiat — every market quotes in USDC, no KRW anywhere
    for (const m of markets) {
      expect(m.quote).toBe('USDC');
      expect(m.id.includes('KRW')).toBe(false);
    }

    const btc = markets.find((m) => m.id === 'BTC-USDC');
    expect(btc).toBeDefined();
    expect(btc!.koreanName).toBe('비트코인');
    expect(toUnits(btc!.tickSize)).toBeGreaterThan(0n);
    // boot seeds real tickers — BTC must have a live USD price (tens of thousands)
    expect(btc!.ticker).not.toBeNull();
    expect(toUnits(btc!.ticker!.price)).toBeGreaterThan(toUnits('1000')); // > $1,000

    const btcPerp = markets.find((m) => m.id === 'BTC-PERP');
    expect(btcPerp).toBeDefined();
    expect(btcPerp!.maxLeverage).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it('serves real BTC-USDC candles (Upbit USDT book) with sane OHLC', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/markets/BTC-USDC/candles?interval=1m&limit=50',
    });
    expect(res.statusCode).toBe(200);
    const candles = res.json() as { t: number; o: string; h: string; l: string; c: string }[];
    expect(candles.length).toBeGreaterThanOrEqual(45);
    for (let i = 1; i < candles.length; i++) expect(candles[i]!.t).toBeGreaterThan(candles[i - 1]!.t);
    for (const c of candles) {
      const o = toUnits(c.o);
      const h = toUnits(c.h);
      const l = toUnits(c.l);
      const cl = toUnits(c.c);
      expect(h >= o && h >= cl).toBe(true);
      expect(l <= o && l <= cl).toBe(true);
      expect(l > 0n).toBe(true);
    }
    // recent live data (not a stale fixture). The Upbit USDT-BTC book trades
    // less often than KRW-BTC, so minute buckets can have gaps — allow 2h.
    expect(Date.now() - candles.at(-1)!.t).toBeLessThan(2 * 60 * 60_000);
  }, 30_000);

  it('serves real BTC-PERP candles (Hyperliquid)', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/markets/BTC-PERP/candles?interval=1h&limit=24',
    });
    expect(res.statusCode).toBe(200);
    const candles = res.json() as { t: number; c: string }[];
    expect(candles.length).toBeGreaterThanOrEqual(20);
    expect(toUnits(candles.at(-1)!.c)).toBeGreaterThan(toUnits('1000')); // BTC > $1,000
  }, 30_000);

  it('404s for a market that does not exist', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets/KRW-NOPE/candles' });
    expect(res.statusCode).toBe(404);
  });
});
