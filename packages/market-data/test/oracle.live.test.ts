/** LIVE: the multi-source price oracle against REAL OKX + Coinbase APIs. */
import { describe, expect, it } from 'vitest';
import { medianBig } from '@dex/shared';
import { PriceOracle, fetchCoinbaseSpot, fetchOkxSwapMids } from '../src/oracle.js';
import { LIVE_TIMEOUT, withNetRetry } from './live.helpers.js';

describe('multi-source oracle (live, real venues)', () => {
  it(
    'OKX batch returns real swap mids for the majors',
    async () => {
      const mids = await withNetRetry(() => fetchOkxSwapMids());
      expect(mids.size).toBeGreaterThan(50);
      const btc = mids.get('BTC');
      const eth = mids.get('ETH');
      expect(btc !== undefined && btc > 0n).toBe(true);
      expect(eth !== undefined && eth > 0n).toBe(true);
      // sanity: BTC in a plausible live range (tens of thousands USD, 1e8-scaled)
      expect(btc! > 1000n * 10n ** 8n).toBe(true);
    },
    LIVE_TIMEOUT,
  );

  it(
    'Coinbase returns a real BTC-USD spot price; unlisted coin → null (never fabricated)',
    async () => {
      const btc = await withNetRetry(() => fetchCoinbaseSpot('BTC'));
      expect(btc !== null && btc > 1000n * 10n ** 8n).toBe(true);
      const nope = await fetchCoinbaseSpot('NOTAREALCOIN123');
      expect(nope).toBeNull();
    },
    LIVE_TIMEOUT,
  );

  it(
    'oracle aggregates ≥2 independent real sources per major; OKX and Coinbase agree within 1%',
    async () => {
      const oracle = new PriceOracle();
      await withNetRetry(() => oracle.refresh(['BTC', 'ETH', 'SOL']));
      for (const coin of ['BTC', 'ETH', 'SOL']) {
        const prices = oracle.externalPrices(coin);
        expect(prices.length, `${coin}: ≥2 real sources`).toBeGreaterThanOrEqual(2);
        const med = medianBig(prices);
        // independent real venues must agree closely (no source is fabricated/garbage)
        for (const p of prices) {
          const diff = p > med ? p - med : med - p;
          expect((diff * 100n) / med < 1n, `${coin}: source within 1% of median`).toBe(true);
        }
      }
    },
    LIVE_TIMEOUT,
  );
});
