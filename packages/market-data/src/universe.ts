import {
  PERP_MAKER_FEE_BPS,
  PERP_TAKER_FEE_BPS,
  SPOT_MAKER_FEE_BPS,
  SPOT_TAKER_FEE_BPS,
  toUnits,
  type MarketConfig,
  type Ticker,
} from '@dex/shared';
import type { HlAsset } from './hyperliquid.js';
import type { UpbitMarket } from './upbit.js';

/** Upbit source code (`USDT-BTC`) for an internal spot market id (`BTC-USDC`). */
export function upbitCodeForSpotMarket(marketId: string): string {
  const base = marketId.slice(0, marketId.lastIndexOf('-'));
  return `USDT-${base}`;
}

/** Internal spot market id (`BTC-USDC`) for an Upbit USDT code (`USDT-BTC`). */
export function spotMarketIdForUpbitCode(code: string): string {
  return `${code.slice('USDT-'.length)}-USDC`;
}

/**
 * Spot market configs from the real Upbit market list — a DEX settles in a
 * stablecoin, so we mirror Upbit's USDT order books (real stablecoin-quoted
 * depth) and present them as `<BASE>-USDC` (USDT and USDC are both $1 pegs;
 * the price reference is identical). Tick derives from the live price (5
 * significant figures); the book mirror snaps any off-grid venue prices.
 */
export function buildSpotMarkets(rawUpbitMarkets: UpbitMarket[], tickers?: Ticker[]): MarketConfig[] {
  const byMarket = new Map<string, Ticker>();
  for (const t of tickers ?? []) byMarket.set(t.marketId, t);
  const out: MarketConfig[] = [];
  for (const m of rawUpbitMarkets) {
    if (!m.market.startsWith('USDT-')) continue;
    if (m.market === 'USDT-USDT') continue;
    const ticker = byMarket.get(m.market);
    out.push({
      id: spotMarketIdForUpbitCode(m.market),
      type: 'spot',
      base: m.market.slice('USDT-'.length),
      quote: 'USDC',
      koreanName: m.korean_name,
      englishName: m.english_name,
      tickSize: ticker ? perpTickFromMid(ticker.price) : toUnits('0.0001'),
      lotSize: 1n,
      minNotional: toUnits('1'),
      makerFeeBps: SPOT_MAKER_FEE_BPS,
      takerFeeBps: SPOT_TAKER_FEE_BPS,
      maxLeverage: 1,
    });
  }
  return out;
}

/**
 * Price tick derived from the current mid (1e8 units), modeling Hyperliquid's
 * perp price rules: at most 5 significant figures, and — when `szDecimals` is
 * supplied — at most `6 - szDecimals` decimal places. Without `szDecimals`
 * only the 5-significant-figure rule applies (pure derived tick).
 */
export function perpTickFromMid(mid: bigint, szDecimals?: number): bigint {
  if (mid <= 0n) return 1n;
  let digits = 0;
  for (let v = mid; v > 0n; v /= 10n) digits += 1;
  const exp = digits - 1 - 4; // floor(log10(mid units)) - 4
  let tick = exp <= 0 ? 1n : 10n ** BigInt(exp);
  if (szDecimals !== undefined) {
    // HL perps: prices have at most 6 - szDecimals decimal places.
    const maxDp = Math.min(8, Math.max(0, 6 - Math.trunc(szDecimals)));
    const minTick = 10n ** BigInt(8 - maxDp);
    if (tick < minTick) tick = minTick;
  }
  return tick;
}

/**
 * Perp market configs from the real Hyperliquid universe, limited to the
 * first `topN` listed assets that have a live mid (delisted/mid-less skipped).
 */
export function buildPerpMarkets(hlUniverse: HlAsset[], mids: Map<string, bigint>, topN = 30): MarketConfig[] {
  const out: MarketConfig[] = [];
  for (const asset of hlUniverse) {
    if (out.length >= topN) break;
    if (asset.isDelisted) continue;
    const mid = mids.get(asset.name);
    if (mid === undefined || mid <= 0n) continue; // skip coins without a mid
    const szDecimals = Math.min(8, Math.max(0, Math.trunc(asset.szDecimals)));
    out.push({
      id: `${asset.name}-PERP`,
      type: 'perp',
      base: asset.name,
      quote: 'USDC',
      koreanName: null,
      englishName: asset.name,
      tickSize: perpTickFromMid(mid, szDecimals),
      lotSize: 10n ** BigInt(8 - szDecimals),
      minNotional: toUnits('10'),
      makerFeeBps: PERP_MAKER_FEE_BPS,
      takerFeeBps: PERP_TAKER_FEE_BPS,
      maxLeverage: asset.maxLeverage,
    });
  }
  return out;
}
