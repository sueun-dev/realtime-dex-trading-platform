import type { Candle, CandleInterval } from '@dex/shared';
import type { HyperliquidRest } from './hyperliquid.js';
import type { UpbitRest } from './upbit.js';
import { upbitCodeForSpotMarket } from './universe.js';

export const INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

interface CacheEntry {
  at: number;
  limit: number;
  candles: Candle[];
}

interface InFlight {
  limit: number;
  promise: Promise<Candle[]>;
}

export interface CandleServiceOptions {
  /** cache TTL, default 5000ms */
  ttlMs?: number;
  /** injected clock (epoch ms), default system clock */
  now?: () => number;
}

/**
 * Routes candle requests: '*-USDC' → Upbit (USDT market), '*-PERP' → Hyperliquid.
 * 5s TTL cache keyed (market, interval) + in-flight promise dedupe.
 */
export class CandleService {
  readonly #upbit: Pick<UpbitRest, 'fetchCandles'>;
  readonly #hl: Pick<HyperliquidRest, 'candleSnapshot'>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, InFlight>();

  constructor(
    upbit: Pick<UpbitRest, 'fetchCandles'>,
    hl: Pick<HyperliquidRest, 'candleSnapshot'>,
    opts: CandleServiceOptions = {},
  ) {
    this.#upbit = upbit;
    this.#hl = hl;
    this.#ttlMs = opts.ttlMs ?? 5_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  async get(marketId: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    const key = `${marketId}|${interval}`;
    const cached = this.#cache.get(key);
    if (cached && this.#now() - cached.at < this.#ttlMs && cached.limit >= limit) {
      return cached.candles.slice(-limit);
    }
    const inFlight = this.#inFlight.get(key);
    if (inFlight && inFlight.limit >= limit) {
      const candles = await inFlight.promise;
      return candles.slice(-limit);
    }
    const promise: Promise<Candle[]> = this.#fetch(marketId, interval, limit).then(
      (candles) => {
        // Only clear our own in-flight entry — a concurrent larger fetch may
        // have replaced it, and deleting that one would force refetches.
        if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key);
        // Never replace a still-fresh, larger cached window with a smaller
        // one (both windows end "now", so the larger is a superset).
        const existing = this.#cache.get(key);
        const keepExisting =
          existing !== undefined && existing.limit > limit && this.#now() - existing.at < this.#ttlMs;
        if (!keepExisting) this.#cache.set(key, { at: this.#now(), limit, candles });
        return candles;
      },
      (err: unknown) => {
        if (this.#inFlight.get(key)?.promise === promise) this.#inFlight.delete(key);
        throw err;
      },
    );
    this.#inFlight.set(key, { limit, promise });
    const candles = await promise;
    return candles.slice(-limit);
  }

  async #fetch(marketId: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
    if (marketId.endsWith('-USDC')) {
      // spot: real candles from the corresponding Upbit USDT market
      return this.#upbit.fetchCandles(upbitCodeForSpotMarket(marketId), interval, limit);
    }
    if (marketId.endsWith('-PERP')) {
      const coin = marketId.slice(0, -'-PERP'.length);
      const endTime = this.#now();
      const startTime = endTime - limit * INTERVAL_MS[interval];
      const candles = await this.#hl.candleSnapshot(coin, interval, startTime, endTime);
      return candles.slice(-limit);
    }
    throw new Error(`CandleService: unsupported market id ${JSON.stringify(marketId)}`);
  }
}
