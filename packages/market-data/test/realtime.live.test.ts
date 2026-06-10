/** Live streams from the REAL venues — requires internet. */
import { afterAll, describe, expect, it } from 'vitest';
import type { BookLevel } from '@dex/shared';
import { UpbitWs, type ExternalOrderbook } from '../src/upbitWs.js';
import { HyperliquidWs, type HlL2Book, type HlTrade } from '../src/hyperliquidWs.js';

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const fn of cleanups) fn();
});

function within<T>(ms: number, what: string, arm: (resolve: (v: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    arm((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

function assertBook(bids: BookLevel[], asks: BookLevel[]): void {
  expect(bids.length).toBeGreaterThan(3);
  expect(asks.length).toBeGreaterThan(3);
  expect(bids[0]!.price < asks[0]!.price).toBe(true); // never crossed
  for (const l of [...bids, ...asks]) {
    expect(l.price > 0n).toBe(true);
    expect(l.qty > 0n).toBe(true);
  }
}

describe('live real-venue depth and prints', () => {
  it('Upbit streams the real KRW-BTC orderbook (prices AND sizes)', async () => {
    const ws = new UpbitWs(['KRW-BTC'], { types: ['orderbook'] });
    cleanups.push(() => ws.close());
    ws.connect();
    const ob = await within<ExternalOrderbook>(25_000, 'Upbit orderbook frame', (resolve) =>
      ws.once('orderbook', resolve),
    );
    expect(ob.marketId).toBe('KRW-BTC');
    assertBook(ob.bids, ob.asks);
  }, 30_000);

  it('Hyperliquid streams the real BTC l2Book and trades', async () => {
    const ws = new HyperliquidWs({ l2Coins: ['BTC'], tradeCoins: ['BTC'] });
    cleanups.push(() => ws.close());
    ws.connect();
    const book = await within<HlL2Book>(25_000, 'HL l2Book frame', (resolve) =>
      ws.once('l2book', resolve),
    );
    expect(book.coin).toBe('BTC');
    assertBook(book.bids, book.asks);

    const trades = await within<HlTrade[]>(45_000, 'HL trades frame', (resolve) =>
      ws.once('trades', resolve),
    );
    expect(trades.length).toBeGreaterThan(0);
    expect(trades[0]!.price > 0n).toBe(true);
    expect(['buy', 'sell']).toContain(trades[0]!.side);
  }, 75_000);

  it('UpbitWs.setCodes retargets the live subscription', async () => {
    const ws = new UpbitWs(['KRW-BTC'], { types: ['orderbook'] });
    cleanups.push(() => ws.close());
    ws.connect();
    await within(25_000, 'first orderbook frame', (resolve) => ws.once('orderbook', resolve));
    ws.setCodes(['KRW-ETH']);
    const eth = await within<ExternalOrderbook>(25_000, 'KRW-ETH frame after setCodes', (resolve) => {
      const handler = (ob: ExternalOrderbook): void => {
        if (ob.marketId === 'KRW-ETH') {
          ws.off('orderbook', handler);
          resolve(ob);
        }
      };
      ws.on('orderbook', handler);
    });
    assertBook(eth.bids, eth.asks);
  }, 60_000);
});
