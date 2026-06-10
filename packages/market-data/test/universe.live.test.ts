/** LIVE test — full market universe built from real Upbit + Hyperliquid data. */
import { describe, expect, it } from 'vitest';
import { toUnits, type Ticker } from '@dex/shared';
import { HyperliquidRest } from '../src/hyperliquid.js';
import { UpbitRest } from '../src/upbit.js';
import { buildPerpMarkets, buildSpotMarkets } from '../src/universe.js';
import { LIVE_TIMEOUT, sleep, withNetRetry } from './live.helpers.js';

describe('Full universe build (live)', () => {
  it(
    'builds >=80 spot configs from the real Upbit universe with live ticks',
    async () => {
      const upbit = new UpbitRest();
      const markets = await withNetRetry(() => upbit.fetchMarkets());
      const krwIds = markets.filter((m) => m.market.startsWith('KRW-')).map((m) => m.market);
      // fetch live tickers in chunks to keep URLs and rate limits comfortable
      const tickers: Ticker[] = [];
      for (let i = 0; i < krwIds.length; i += 100) {
        const chunk = krwIds.slice(i, i + 100);
        tickers.push(...(await withNetRetry(() => upbit.fetchTickers(chunk))));
        await sleep(250);
      }
      expect(tickers.length).toBe(krwIds.length);

      const configs = buildSpotMarkets(markets, tickers);
      expect(configs.length).toBeGreaterThanOrEqual(80);
      const ids = new Set(configs.map((c) => c.id));
      expect(ids.has('KRW-BTC') && ids.has('KRW-ETH') && ids.has('KRW-XRP')).toBe(true);
      for (const c of configs) {
        expect(c.id.startsWith('KRW-'), `${c.id}: spot id`).toBe(true);
        expect(c.type).toBe('spot');
        expect(c.quote).toBe('KRW');
        expect(c.tickSize > 0n, `${c.id}: tickSize > 0`).toBe(true);
        expect(c.lotSize > 0n, `${c.id}: lotSize > 0`).toBe(true);
        expect(c.minNotional > 0n).toBe(true);
        expect(c.maxLeverage).toBe(1);
        expect(c.koreanName === null || c.koreanName.length > 0).toBe(true);
      }
      // BTC trades way above 2M KRW → tick must be 1000 KRW
      const btc = configs.find((c) => c.id === 'KRW-BTC')!;
      expect(btc.tickSize).toBe(1000n * 10n ** 8n);

      // Pin the post-2025-07-31 cheap-coin bands against live prices:
      // 100 <= p < 1,000 KRW → 1 KRW tick; 10 <= p < 100 KRW → 0.1 KRW tick.
      const tickerById = new Map(tickers.map((t) => [t.marketId, t] as const));
      const byId = new Map(configs.map((c) => [c.id, c] as const));
      const inBand = (lo: string, hi: string): Ticker[] =>
        [...tickerById.values()].filter((t) => t.price >= toUnits(lo) && t.price < toUnits(hi) && byId.has(t.marketId));
      const band100 = inBand('100', '1000');
      expect(band100.length, 'Upbit always lists coins trading at 100–1,000 KRW').toBeGreaterThan(0);
      for (const t of band100) {
        expect(byId.get(t.marketId)!.tickSize, `${t.marketId}: 100–1,000 KRW band tick`).toBe(toUnits('1'));
      }
      const band10 = inBand('10', '100');
      expect(band10.length, 'Upbit always lists coins trading at 10–100 KRW').toBeGreaterThan(0);
      for (const t of band10) {
        expect(byId.get(t.marketId)!.tickSize, `${t.marketId}: 10–100 KRW band tick`).toBe(toUnits('0.1'));
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
