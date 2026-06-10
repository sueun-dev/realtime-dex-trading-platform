/**
 * Liquidity bot: quotes N levels each side around the REAL market price
 * (Upbit ticker for spot, Hyperliquid mark for perps) so the books are alive
 * and takers can actually fill. Prices are real; the liquidity is the house's.
 * Re-quotes only when the reference price moves >0.1% (or quotes are missing).
 */
import {
  divUnits,
  feeOn,
  maxBig,
  mulUnits,
  roundToLot,
  roundToTick,
  toUnits,
  type EngineEvent,
  type MarketConfig,
} from '@dex/shared';
import type { Services, Stoppable } from './services.js';

export const MM_USER = 'mm-bot';

export interface MarketMakerOptions {
  /** market ids to quote; defaults to liquid majors present in the universe */
  markets: string[];
  intervalMs: number;
  levels: number;
  /** quote notional per level (in quote currency units, 1e8) */
  spotNotional: bigint;
  perpNotional: bigint;
}

const DEFAULT_SPOT = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA'];
const DEFAULT_PERP = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'XRP-PERP'];
/** re-quote when price moved more than 5 bps */
const REQUOTE_BPS = 5n;
/** per-level half-spread: 5 bps × level */
const LEVEL_BPS = 5n;

export function startMarketMaker(svc: Services, opts: Partial<MarketMakerOptions> = {}): Stoppable {
  const { engine, pipeline, priceCache, log } = svc;
  const wanted = opts.markets ?? [...DEFAULT_SPOT, ...DEFAULT_PERP];
  const markets = wanted
    .map((id) => engine.getMarket(id))
    .filter((m): m is MarketConfig => m !== undefined);
  const intervalMs = opts.intervalMs ?? 1000;
  const levels = opts.levels ?? 4;
  const spotNotional = opts.spotNotional ?? toUnits('3000000'); // ₩3,000,000
  const perpNotional = opts.perpNotional ?? toUnits('3000'); // $3,000
  const lastQuoted = new Map<string, bigint>();

  const refPrice = (m: MarketConfig): bigint | undefined => {
    if (m.type === 'perp') return engine.getMarkPrice(m.id) ?? priceCache.get(m.id)?.price;
    return priceCache.get(m.id)?.price;
  };

  const quoteMarket = async (m: MarketConfig): Promise<void> => {
    const price = refPrice(m);
    if (price === undefined || price <= 0n) return;
    const last = lastQuoted.get(m.id);
    const hasQuotes = engine.getOpenOrders(MM_USER, m.id).length > 0;
    if (last !== undefined && hasQuotes) {
      const move = ((price > last ? price - last : last - price) * 10_000n) / last;
      if (move < REQUOTE_BPS) return;
    }
    lastQuoted.set(m.id, price);
    const notional = m.type === 'spot' ? spotNotional : perpNotional;

    await pipeline.exec(() => {
      const now = Date.now();
      const evts: EngineEvent[] = [];
      for (const o of engine.getOpenOrders(MM_USER, m.id)) {
        evts.push(...engine.cancelOrder(MM_USER, o.id, now));
      }
      // size one level; ensure the bot has funds for all levels with headroom
      const qty = maxBig(roundToLot(divUnits(notional, price), m.lotSize), m.lotSize);
      const perLevelNotional = mulUnits(qty, price);
      const lots = BigInt(levels);
      const quoteNeed = (perLevelNotional + feeOn(perLevelNotional, m.takerFeeBps)) * lots * 2n;
      const baseNeed = qty * lots * 2n;
      const bal = new Map(engine.getBalances(MM_USER).map((b) => [b.asset, b.available]));
      if ((bal.get(m.quote) ?? 0n) < quoteNeed) {
        evts.push(...engine.deposit(MM_USER, m.quote, quoteNeed * 50n, now));
      }
      if (m.type === 'spot' && (bal.get(m.base) ?? 0n) < baseNeed) {
        evts.push(...engine.deposit(MM_USER, m.base, baseNeed * 50n, now));
      }
      for (let lvl = 1; lvl <= levels; lvl++) {
        const off = maxBig((price * LEVEL_BPS * BigInt(lvl)) / 10_000n, m.tickSize);
        const bid = roundToTick(price - off, m.tickSize, 'floor');
        const ask = roundToTick(price + off, m.tickSize, 'ceil');
        if (bid <= 0n || bid >= ask) continue;
        if (mulUnits(qty, bid) < m.minNotional) continue;
        evts.push(
          ...engine.submitOrder(
            MM_USER,
            { marketId: m.id, side: 'buy', type: 'limit', price: bid, qty, tif: 'GTC' },
            now,
          ),
          ...engine.submitOrder(
            MM_USER,
            { marketId: m.id, side: 'sell', type: 'limit', price: ask, qty, tif: 'GTC' },
            now,
          ),
        );
      }
      return evts;
    });
  };

  let stopped = false;
  const tick = async (): Promise<void> => {
    for (const m of markets) {
      if (stopped) return;
      try {
        await quoteMarket(m);
      } catch (e) {
        log(`market maker ${m.id} failed: ${String(e)}`);
      }
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  log(`market maker quoting ${markets.map((m) => m.id).join(', ')}`);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
