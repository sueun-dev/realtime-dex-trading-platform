/** LIVE test — full market universe built from real Upbit + Hyperliquid data. */
import { describe, expect, it } from 'vitest';
import { toUnits, type Ticker } from '@dex/shared';
import { HyperliquidRest } from '../src/hyperliquid.js';
import { UpbitRest } from '../src/upbit.js';
import { buildPerpMarkets, buildSpotMarkets } from '../src/universe.js';
import { LIVE_TIMEOUT, sleep, withNetRetry } from './live.helpers.js';

describe('Full universe build (live)', () => {
  it(
    'builds >=80 USDC spot configs from the real Upbit USDT universe with live ticks',
    async () => {
      const upbit = new UpbitRest();
      const markets = await withNetRetry(() => upbit.fetchMarkets());
      const usdtIds = markets
        .filter((m) => m.market.startsWith('USDT-') && m.market !== 'USDT-USDT')
        .map((m) => m.market);
      // fetch live tickers in chunks to keep URLs and rate limits comfortable
      const tickers: Ticker[] = [];
      for (let i = 0; i < usdtIds.length; i += 100) {
        const chunk = usdtIds.slice(i, i + 100);
        tickers.push(...(await withNetRetry(() => upbit.fetchTickers(chunk))));
        await sleep(250);
      }
      expect(tickers.length).toBe(usdtIds.length);

      const configs = buildSpotMarkets(markets, tickers);
      expect(configs.length).toBeGreaterThanOrEqual(80);
      const ids = new Set(configs.map((c) => c.id));
      expect(ids.has('BTC-USDC') && ids.has('ETH-USDC') && ids.has('XRP-USDC')).toBe(true);
      // no fiat — KRW must never appear as a market or quote
      for (const c of configs) {
        expect(c.id.endsWith('-USDC'), `${c.id}: spot id`).toBe(true);
        expect(c.id.includes('KRW'), `${c.id}: no KRW`).toBe(false);
        expect(c.type).toBe('spot');
        expect(c.quote).toBe('USDC');
        expect(c.tickSize > 0n, `${c.id}: tickSize > 0`).toBe(true);
        expect(c.lotSize > 0n, `${c.id}: lotSize > 0`).toBe(true);
        expect(c.minNotional > 0n).toBe(true);
        expect(c.maxLeverage).toBe(1);
        expect(c.koreanName === null || c.koreanName.length > 0).toBe(true);
      }
      // BTC ~ tens of thousands of USDC → 5-sig-fig tick of 1 USDC
      const btc = configs.find((c) => c.id === 'BTC-USDC')!;
      expect(btc.tickSize).toBe(toUnits('1'));
      // every tick is a clean power of ten (5-significant-figure rule)
      for (const c of configs) {
        let t = c.tickSize;
        while (t > 1n && t % 10n === 0n) t /= 10n;
        expect(t === 1n, `${c.id}: tick ${c.tickSize} is a power of ten`).toBe(true);
      }
    },
    LIVE_TIMEOUT,
  );

  it(
    'builds >=20 perp configs from the real Hyperliquid universe with live mids',
    async () => {
      const hl = new HyperliquidRest();
      const universe = await withNetRetry(() => hl.meta());
      const mids = await withNetRetry(() => hl.allMids());
      const configs = buildPerpMarkets(universe, mids, 30);
      expect(configs.length).toBeGreaterThanOrEqual(20);
      const ids = new Set(configs.map((c) => c.id));
      expect(ids.has('BTC-PERP') && ids.has('ETH-PERP')).toBe(true);
      for (const c of configs) {
        expect(c.id.endsWith('-PERP'), `${c.id}: perp id`).toBe(true);
        expect(c.type).toBe('perp');
        expect(c.quote).toBe('USDC');
        expect(c.tickSize > 0n, `${c.id}: tickSize > 0`).toBe(true);
        expect(c.lotSize > 0n, `${c.id}: lotSize > 0`).toBe(true);
        expect(c.lotSize <= 10n ** 8n, `${c.id}: lotSize <= 1`).toBe(true);
        expect(c.minNotional > 0n).toBe(true);
        expect(c.maxLeverage).toBeGreaterThanOrEqual(1);
        expect(c.makerFeeBps).toBe(2);
        expect(c.takerFeeBps).toBe(2);
      }
    },
    LIVE_TIMEOUT,
  );
});
