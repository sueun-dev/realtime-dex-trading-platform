import { EventEmitter } from 'node:events';
import type { Ticker } from '@dex/shared';

/**
 * In-memory latest-ticker cache. `setTicker` stores the ticker and emits
 * 'ticker' (Ticker). Stale updates (older ts than the stored one for the same
 * market) are ignored.
 */
export class PriceCache extends EventEmitter {
  readonly #tickers = new Map<string, Ticker>();

  setTicker(t: Ticker): void {
    const prev = this.#tickers.get(t.marketId);
    if (prev && prev.ts > t.ts) return;
    this.#tickers.set(t.marketId, t);
    this.emit('ticker', t);
  }

  get(marketId: string): Ticker | undefined {
    return this.#tickers.get(marketId);
  }

  all(): Ticker[] {
    return [...this.#tickers.values()];
  }
}
