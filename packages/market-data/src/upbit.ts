import type { Candle, CandleInterval, Side, Ticker } from '@dex/shared';
import {
  expectArray,
  expectBigIntId,
  expectNumber,
  expectObject,
  expectString,
  fetchJson,
  numToUnits,
} from './util.js';

export const UPBIT_REST_URL = 'https://api.upbit.com';

export interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
}

export interface PublicTrade {
  marketId: string;
  price: bigint;
  qty: bigint;
  /** taker side: Upbit ask_bid 'BID' = taker bought, 'ASK' = taker sold */
  side: Side;
  ts: number;
  /** Upbit sequential_id — exceeds 2^53, so it must stay a bigint, never a JS number. */
  sequentialId: bigint;
}

const CANDLE_PATH: Record<CandleInterval, string> = {
  '1m': '/v1/candles/minutes/1',
  '5m': '/v1/candles/minutes/5',
  '15m': '/v1/candles/minutes/15',
  '1h': '/v1/candles/minutes/60',
  '4h': '/v1/candles/minutes/240',
  '1d': '/v1/candles/days',
};

export interface UpbitRestOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class UpbitRest {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(opts: UpbitRestOptions = {}) {
    this.#baseUrl = opts.baseUrl ?? UPBIT_REST_URL;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async #get(path: string, bigIntFields?: string[]): Promise<unknown> {
    return fetchJson(`${this.#baseUrl}${path}`, { timeoutMs: this.#timeoutMs, bigIntFields });
  }

  /** GET /v1/market/all — full Upbit market list (KRW-, BTC-, USDT- quoted). */
  async fetchMarkets(): Promise<UpbitMarket[]> {
    const raw = expectArray(await this.#get('/v1/market/all?isDetails=false'), 'Upbit /v1/market/all');
    return raw.map((item, i) => {
      const o = expectObject(item, `Upbit /v1/market/all[${i}]`);
      return {
        market: expectString(o['market'], 'market', `Upbit /v1/market/all[${i}]`),
        korean_name: expectString(o['korean_name'], 'korean_name', `Upbit /v1/market/all[${i}]`),
        english_name: expectString(o['english_name'], 'english_name', `Upbit /v1/market/all[${i}]`),
      };
    });
  }

  /**
   * Candles for `market`, ASCENDING by open time (Upbit returns newest-first;
   * we reverse). `count` is clamped to Upbit's 200 max.
   */
  async fetchCandles(market: string, interval: CandleInterval, count: number): Promise<Candle[]> {
    const n = Math.max(1, Math.min(200, Math.trunc(count)));
    const path = `${CANDLE_PATH[interval]}?market=${encodeURIComponent(market)}&count=${n}`;
    const ctx = `Upbit ${CANDLE_PATH[interval]} (${market})`;
    const raw = expectArray(await this.#get(path), ctx);
    const candles = raw.map((item, i) => {
      const o = expectObject(item, `${ctx}[${i}]`);
      const utc = expectString(o['candle_date_time_utc'], 'candle_date_time_utc', `${ctx}[${i}]`);
      const t = Date.parse(`${utc}Z`);
      if (!Number.isFinite(t)) {
        throw new Error(`${ctx}[${i}]: unparseable candle_date_time_utc ${JSON.stringify(utc)}`);
      }
      return {
        t,
        o: numToUnits(o['opening_price'], 'opening_price'),
        h: numToUnits(o['high_price'], 'high_price'),
        l: numToUnits(o['low_price'], 'low_price'),
        c: numToUnits(o['trade_price'], 'trade_price'),
        v: numToUnits(o['candle_acc_trade_volume'], 'candle_acc_trade_volume'),
      };
    });
    candles.reverse();
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.t <= candles[i - 1]!.t) {
        throw new Error(`${ctx}: candles not strictly ascending after reverse (index ${i})`);
      }
    }
    return candles;
  }

  /** GET /v1/ticker — 24h ticker snapshot for the given markets. */
  async fetchTickers(markets: string[]): Promise<Ticker[]> {
    if (markets.length === 0) return [];
    const path = `/v1/ticker?markets=${encodeURIComponent(markets.join(','))}`;
    const ctx = 'Upbit /v1/ticker';
    const raw = expectArray(await this.#get(path), ctx);
    return raw.map((item, i) => {
      const o = expectObject(item, `${ctx}[${i}]`);
      return {
        marketId: expectString(o['market'], 'market', `${ctx}[${i}]`),
        price: numToUnits(o['trade_price'], 'trade_price'),
        change24h: numToUnits(o['signed_change_rate'], 'signed_change_rate'),
        high24h: numToUnits(o['high_price'], 'high_price'),
        low24h: numToUnits(o['low_price'], 'low_price'),
        volume24h: numToUnits(o['acc_trade_price_24h'], 'acc_trade_price_24h'),
        ts: expectNumber(o['timestamp'], 'timestamp', `${ctx}[${i}]`),
      };
    });
  }

  /** GET /v1/trades/ticks — most recent public trades, newest first (as Upbit returns). */
  async fetchRecentTrades(market: string, count: number): Promise<PublicTrade[]> {
    const n = Math.max(1, Math.min(500, Math.trunc(count)));
    const path = `/v1/trades/ticks?market=${encodeURIComponent(market)}&count=${n}`;
    const ctx = `Upbit /v1/trades/ticks (${market})`;
    // sequential_id exceeds 2^53 — re-quote it in the raw text to keep precision
    const raw = expectArray(await this.#get(path, ['sequential_id']), ctx);
    return raw.map((item, i) => {
      const o = expectObject(item, `${ctx}[${i}]`);
      const askBid = expectString(o['ask_bid'], 'ask_bid', `${ctx}[${i}]`);
      if (askBid !== 'ASK' && askBid !== 'BID') {
        throw new Error(`${ctx}[${i}]: unexpected ask_bid ${JSON.stringify(askBid)}`);
      }
      return {
        marketId: expectString(o['market'], 'market', `${ctx}[${i}]`),
        price: numToUnits(o['trade_price'], 'trade_price'),
        qty: numToUnits(o['trade_volume'], 'trade_volume'),
        side: askBid === 'BID' ? ('buy' as const) : ('sell' as const),
        ts: expectNumber(o['timestamp'], 'timestamp', `${ctx}[${i}]`),
        sequentialId: expectBigIntId(o['sequential_id'], 'sequential_id', `${ctx}[${i}]`),
      };
    });
  }
}
