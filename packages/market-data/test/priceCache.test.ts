import { describe, expect, it } from 'vitest';
import { toUnits, type Ticker } from '@dex/shared';
import { PriceCache } from '../src/priceCache.js';

function mkTicker(marketId: string, price: string, ts: number): Ticker {
  return {
    marketId,
    price: toUnits(price),
    change24h: 0n,
    high24h: toUnits(price),
    low24h: toUnits(price),
    volume24h: 0n,
    ts,
  };
}

describe('PriceCache', () => {
  it('stores tickers, emits "ticker" per update, and lists all', () => {
    const cache = new PriceCache();
    const seen: Ticker[] = [];
    cache.on('ticker', (t: Ticker) => seen.push(t));

    const btc1 = mkTicker('KRW-BTC', '93151000', 1000);
    const eth = mkTicker('KRW-ETH', '2471000', 1001);
    cache.setTicker(btc1);
    cache.setTicker(eth);
    expect(seen).toEqual([btc1, eth]);
    expect(cache.get('KRW-BTC')).toBe(btc1);
    expect(cache.get('KRW-ETH')).toBe(eth);
    expect(cache.get('KRW-NOPE')).toBeUndefined();
    expect(cache.all()).toHaveLength(2);

    const btc2 = mkTicker('KRW-BTC', '93200000', 2000);
    cache.setTicker(btc2);
    expect(cache.get('KRW-BTC')).toBe(btc2);
    expect(seen).toHaveLength(3);
    expect(cache.all()).toHaveLength(2); // still two markets
  });

  it('ignores stale updates (older ts) and does not emit for them', () => {
    const cache = new PriceCache();
    let events = 0;
    cache.on('ticker', () => {
      events += 1;
    });
    const fresh = mkTicker('KRW-BTC', '93200000', 2000);
    const stale = mkTicker('KRW-BTC', '93000000', 1500);
    cache.setTicker(fresh);
    cache.setTicker(stale);
    expect(cache.get('KRW-BTC')).toBe(fresh);
    expect(events).toBe(1);
  });
});
