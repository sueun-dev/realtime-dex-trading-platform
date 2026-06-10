import type { Candle, CandleInterval } from '@dex/shared';
import { expectArray, expectNumber, expectObject, expectString, fetchJson, numToUnits } from './util.js';

export const HYPERLIQUID_REST_URL = 'https://api.hyperliquid.xyz';

export interface HlAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export interface HlFundingPoint {
  /** funding timestamp, epoch ms */
  time: number;
  /** signed hourly funding rate, 1e8 units */
  fundingRate: bigint;
}

export interface HyperliquidRestOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class HyperliquidRest {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(opts: HyperliquidRestOptions = {}) {
    this.#baseUrl = opts.baseUrl ?? HYPERLIQUID_REST_URL;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async #info(body: unknown): Promise<unknown> {
    return fetchJson(`${this.#baseUrl}/info`, { method: 'POST', body, timeoutMs: this.#timeoutMs });
  }

  /** POST /info {"type":"meta"} — perp universe. */
  async meta(): Promise<HlAsset[]> {
    const ctx = 'Hyperliquid info:meta';
    const root = expectObject(await this.#info({ type: 'meta' }), ctx);
    const universe = expectArray(root['universe'], `${ctx}.universe`);
    return universe.map((item, i) => {
      const o = expectObject(item, `${ctx}.universe[${i}]`);
      const asset: HlAsset = {
        name: expectString(o['name'], 'name', `${ctx}.universe[${i}]`),
        szDecimals: expectNumber(o['szDecimals'], 'szDecimals', `${ctx}.universe[${i}]`),
        maxLeverage: expectNumber(o['maxLeverage'], 'maxLeverage', `${ctx}.universe[${i}]`),
      };
      if (typeof o['isDelisted'] === 'boolean') asset.isDelisted = o['isDelisted'];
      return asset;
    });
  }

  /** POST /info {"type":"allMids"} — coin → mid price (skips '@'/'#' index keys). */
  async allMids(): Promise<Map<string, bigint>> {
    const ctx = 'Hyperliquid info:allMids';
    const root = expectObject(await this.#info({ type: 'allMids' }), ctx);
    const mids = new Map<string, bigint>();
    for (const [coin, raw] of Object.entries(root)) {
      if (coin.startsWith('@') || coin.startsWith('#')) continue;
      mids.set(coin, numToUnits(raw, `allMids[${coin}]`));
    }
    return mids;
  }

  /** POST /info {"type":"candleSnapshot"} — candles ASCENDING by open time. */
  async candleSnapshot(
    coin: string,
    interval: CandleInterval,
    startTimeMs: number,
    endTimeMs: number,
  ): Promise<Candle[]> {
    const ctx = `Hyperliquid info:candleSnapshot (${coin} ${interval})`;
    const raw = expectArray(
      await this.#info({
        type: 'candleSnapshot',
        req: { coin, interval, startTime: startTimeMs, endTime: endTimeMs },
      }),
      ctx,
    );
    const candles = raw.map((item, i) => {
      const o = expectObject(item, `${ctx}[${i}]`);
      return {
        t: expectNumber(o['t'], 't', `${ctx}[${i}]`),
        o: numToUnits(o['o'], 'o'),
        h: numToUnits(o['h'], 'h'),
        l: numToUnits(o['l'], 'l'),
        c: numToUnits(o['c'], 'c'),
        v: numToUnits(o['v'], 'v'),
      };
    });
    candles.sort((a, b) => a.t - b.t);
    for (let i = 1; i < candles.length; i++) {
      if (candles[i]!.t <= candles[i - 1]!.t) {
        throw new Error(`${ctx}: duplicate candle bucket at t=${candles[i]!.t}`);
      }
    }
    return candles;
  }

  /** POST /info {"type":"fundingHistory"} — signed hourly funding rates since startTimeMs. */
  async fundingHistory(coin: string, startTimeMs: number): Promise<HlFundingPoint[]> {
    const ctx = `Hyperliquid info:fundingHistory (${coin})`;
    const raw = expectArray(await this.#info({ type: 'fundingHistory', coin, startTime: startTimeMs }), ctx);
    return raw.map((item, i) => {
      const o = expectObject(item, `${ctx}[${i}]`);
      return {
        time: expectNumber(o['time'], 'time', `${ctx}[${i}]`),
        fundingRate: numToUnits(o['fundingRate'], 'fundingRate'),
      };
    });
  }
}
