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

/**
 * Official Upbit KRW market tick table, effective 2025-07-31. `price` and
 * result are 1e8 units.
 * https://docs.upbit.com/kr/docs/krw-market-info_250731 (announced in the
 * `krw_tick_unit_change_250731` changelog). Rungs are listed one-per-band to
 * mirror the official table, even where adjacent bands share a tick
 * (>=2M and 1M–2M are both 1,000; 1K–5K and 100–1K are both 1).
 */
export function upbitKrwTick(price: bigint): bigint {
  if (price >= toUnits('2000000')) return toUnits('1000');
  if (price >= toUnits('1000000')) return toUnits('1000');
  if (price >= toUnits('500000')) return toUnits('500');
  if (price >= toUnits('100000')) return toUnits('100');
  if (price >= toUnits('50000')) return toUnits('50');
  if (price >= toUnits('10000')) return toUnits('10');
  if (price >= toUnits('5000')) return toUnits('5');
  if (price >= toUnits('1000')) return toUnits('1');
  if (price >= toUnits('100')) return toUnits('1');
  if (price >= toUnits('10')) return toUnits('0.1');
  if (price >= toUnits('1')) return toUnits('0.01');
  if (price >= toUnits('0.1')) return toUnits('0.001');
  if (price >= toUnits('0.01')) return toUnits('0.0001');
  if (price >= toUnits('0.001')) return toUnits('0.00001');
  if (price >= toUnits('0.0001')) return toUnits('0.000001');
  if (price >= toUnits('0.00001')) return toUnits('0.0000001');
  return toUnits('0.00000001'); // 1n — official "< 0.00001 KRW" band
}

/**
 * Spot market configs from the real Upbit market list (KRW-quoted only).
 * Tick size derives from the current price when a ticker is supplied.
 * WARNING: without a ticker it falls back to a 1-KRW tick, which is far too
 * coarse for sub-1,000-KRW coins — production boot paths must pass live
 * tickers to get faithful Upbit ticks.
 */
export function buildSpotMarkets(rawUpbitMarkets: UpbitMarket[], tickers?: Ticker[]): MarketConfig[] {
  const byMarket = new Map<string, Ticker>();
  for (const t of tickers ?? []) byMarket.set(t.marketId, t);
  const out: MarketConfig[] = [];
  for (const m of rawUpbitMarkets) {
    if (!m.market.startsWith('KRW-')) continue;
    const ticker = byMarket.get(m.market);
    out.push({
      id: m.market,
      type: 'spot',
      base: m.market.slice('KRW-'.length),
      quote: 'KRW',
      koreanName: m.korean_name,
      englishName: m.english_name,
      tickSize: ticker ? upbitKrwTick(ticker.price) : toUnits('1'),
      lotSize: 1n,
      minNotional: toUnits('5000'),
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
