/**
 * Multi-source price oracle — real prices from independent venues so the perp
 * mark price is a manipulation-resistant median rather than a single feed.
 *
 * Sources (all real, public):
 *  - OKX USDT perpetual swaps (one batch call returns every coin)
 *  - Coinbase spot (per-product, used for the actively-traded coins)
 * Combined upstream with the Hyperliquid mid (the venue we mirror) to form a
 * median of ≥2–3 independent real sources per coin. No synthetic fallback: a
 * coin with no external listing simply contributes no extra source.
 */
import { fetchJson, numToUnits } from './util.js';

export const OKX_REST_URL = 'https://www.okx.com';
export const COINBASE_REST_URL = 'https://api.exchange.coinbase.com';

export type OracleSource = 'okx' | 'coinbase';

interface Sample {
  price: bigint;
  at: number;
}

export interface OracleOptions {
  okxUrl?: string;
  coinbaseUrl?: string;
  /** epoch-ms clock (injectable for tests) */
  now?: () => number;
}

/** Every OKX USDT-swap mid, keyed by coin (e.g. 'BTC'), in one request. */
export async function fetchOkxSwapMids(baseUrl = OKX_REST_URL): Promise<Map<string, bigint>> {
  const url = `${baseUrl}/api/v5/market/tickers?instType=SWAP`;
  const body = (await fetchJson(url)) as { code?: string; data?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  const out = new Map<string, bigint>();
  for (const row of data) {
    const r = row as Record<string, unknown>;
    const inst = r['instId'];
    const last = r['last'];
    if (typeof inst !== 'string' || !inst.endsWith('-USDT-SWAP')) continue;
    if (typeof last !== 'string' || last.length === 0) continue;
    const coin = inst.slice(0, inst.length - '-USDT-SWAP'.length);
    const px = numToUnits(last, `OKX ${inst} last`);
    if (px > 0n) out.set(coin, px);
  }
  if (out.size === 0) throw new Error('OKX swap tickers: empty/unexpected payload');
  return out;
}

/** Coinbase spot price for one coin ({COIN}-USD), or null if not listed. */
export async function fetchCoinbaseSpot(coin: string, baseUrl = COINBASE_REST_URL): Promise<bigint | null> {
  const url = `${baseUrl}/products/${coin}-USD/ticker`;
  try {
    const body = (await fetchJson(url, { headers: { 'User-Agent': 'dex-oracle/1.0' } })) as {
      price?: unknown;
    };
    if (typeof body.price !== 'string') return null;
    const px = numToUnits(body.price, `Coinbase ${coin} price`);
    return px > 0n ? px : null;
  } catch {
    return null; // not listed / transient — just omit this source (never fabricate)
  }
}

/**
 * Maintains the freshest real external price per (coin, source). Call
 * `refresh(coins)` on a timer; read fresh samples with `externalPrices`.
 */
export class PriceOracle {
  readonly #okxUrl: string;
  readonly #coinbaseUrl: string;
  readonly #now: () => number;
  readonly #samples = new Map<string, Map<OracleSource, Sample>>();

  constructor(opts: OracleOptions = {}) {
    this.#okxUrl = opts.okxUrl ?? OKX_REST_URL;
    this.#coinbaseUrl = opts.coinbaseUrl ?? COINBASE_REST_URL;
    this.#now = opts.now ?? (() => Date.now());
  }

  #set(coin: string, source: OracleSource, price: bigint): void {
    let m = this.#samples.get(coin);
    if (m === undefined) {
      m = new Map();
      this.#samples.set(coin, m);
    }
    m.set(source, { price, at: this.#now() });
  }

  /**
   * Refresh external prices for `coins`. OKX is one batched call (all coins);
   * Coinbase is fetched per coin (bounded — pass only the active set). Failures
   * of one source/coin never fabricate data; they just leave the prior sample
   * to age out.
   */
  async refresh(coins: readonly string[]): Promise<void> {
    const wanted = new Set(coins);
    const [okx] = await Promise.allSettled([fetchOkxSwapMids(this.#okxUrl)]);
    if (okx.status === 'fulfilled') {
      for (const [coin, px] of okx.value) if (wanted.has(coin)) this.#set(coin, 'okx', px);
    }
    await Promise.all(
      [...wanted].map(async (coin) => {
        const px = await fetchCoinbaseSpot(coin, this.#coinbaseUrl);
        if (px !== null) this.#set(coin, 'coinbase', px);
      }),
    );
  }

  /** Fresh (within maxAgeMs) real external prices for a coin. */
  externalPrices(coin: string, maxAgeMs = 15_000): bigint[] {
    const m = this.#samples.get(coin);
    if (m === undefined) return [];
    const now = this.#now();
    const out: bigint[] = [];
    for (const s of m.values()) if (now - s.at <= maxAgeMs) out.push(s.price);
    return out;
  }
}
