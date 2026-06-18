/**
 * Perp position store + isolated-margin math helpers.
 */
import {
  absBig,
  divRound,
  divUnits,
  maxBig,
  mulUnits,
  toUnits,
  type MarketConfig,
  type Position,
} from '@dex/shared';

const SCALE = toUnits('1'); // 1e8 fixed-point unit

/**
 * Tiered maintenance-margin RATE floor by position notional (USDC), like a real
 * derivatives venue: bigger positions carry more gap risk, so they require a
 * higher maintenance margin and liquidate with more buffer. Below the first
 * tier the rate floor is 0, so the base `1/(2·maxLeverage)` rate applies
 * unchanged (small positions behave exactly as before). 1e8-scaled rate.
 */
const MM_TIERS: { upTo: bigint; rate: bigint }[] = [
  { upTo: toUnits('50000'), rate: 0n }, //                ≤ $50k   → base rate
  { upTo: toUnits('250000'), rate: toUnits('0.01') }, //  ≤ $250k  → ≥ 1%
  { upTo: toUnits('1000000'), rate: toUnits('0.02') }, // ≤ $1M    → ≥ 2%
  { upTo: toUnits('5000000'), rate: toUnits('0.05') }, // ≤ $5M    → ≥ 5%
];
const MM_TIER_TOP = toUnits('0.1'); //                     > $5M    → ≥ 10%

export function tieredMmRate(notional: bigint): bigint {
  for (const t of MM_TIERS) if (notional <= t.upTo) return t.rate;
  return MM_TIER_TOP;
}

export class PositionBook {
  /** userId -> marketId -> Position (insertion-ordered, deterministic iteration) */
  private readonly byUser = new Map<string, Map<string, Position>>();

  get(userId: string, marketId: string): Position | undefined {
    return this.byUser.get(userId)?.get(marketId);
  }

  set(pos: Position): void {
    let markets = this.byUser.get(pos.userId);
    if (!markets) {
      markets = new Map();
      this.byUser.set(pos.userId, markets);
    }
    markets.set(pos.marketId, pos);
  }

  remove(userId: string, marketId: string): void {
    this.byUser.get(userId)?.delete(marketId);
  }

  ofUser(userId: string): Position[] {
    const markets = this.byUser.get(userId);
    return markets ? [...markets.values()] : [];
  }

  /**
   * All positions on a market, in canonical (userId-sorted) order so that
   * live and restored engines iterate identically.
   */
  ofMarket(marketId: string): Position[] {
    const out: Position[] = [];
    for (const markets of this.byUser.values()) {
      const pos = markets.get(marketId);
      if (pos) out.push(pos);
    }
    return out.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  clear(): void {
    this.byUser.clear();
  }
}

/** Signed unrealized PnL at `mark` (long gains when price rises). */
export function unrealizedPnl(pos: Position, mark: bigint): bigint {
  return pos.size > 0n
    ? mulUnits(mark - pos.entryPrice, pos.size)
    : mulUnits(pos.entryPrice - mark, -pos.size);
}

/** MM = notionalAtMark / (2 * maxLeverage), rounded up. */
export function maintenanceMargin(pos: Position, mark: bigint, m: MarketConfig): bigint {
  const notional = mulUnits(mark, absBig(pos.size));
  // base = notional / (2·maxLeverage) — unchanged below the first tier
  const base = divRound(notional, 2n * BigInt(m.maxLeverage), 'ceil');
  const rate = tieredMmRate(notional);
  if (rate === 0n) return base;
  return maxBig(base, mulUnits(notional, rate, 'ceil'));
}

/**
 * Isolated liquidation price: the mark at which equity (margin + uPnL) falls to
 * the maintenance margin. Solved closed-form using the maintenance-margin tier
 * at the position's ENTRY notional (the standard fixed-bracket approximation —
 * the live tier could differ slightly near the boundary). Returns null when an
 * adverse move to a positive price can never liquidate the position (e.g. a long
 * whose margin already exceeds its entry notional).
 *
 *   long:  P = (s·entry − margin) / (s·(1 − r))
 *   short: P = (s·entry + margin) / (s·(1 + r))   with s = |size|, r = MM rate
 */
export function liquidationPrice(pos: Position, m: MarketConfig): bigint | null {
  const s = absBig(pos.size);
  if (s === 0n) return null;
  const notional = mulUnits(pos.entryPrice, s);
  const baseRate = divRound(SCALE, 2n * BigInt(m.maxLeverage), 'ceil');
  const r = maxBig(baseRate, tieredMmRate(notional)); // effective MM rate (1e8)
  if (pos.size > 0n) {
    const den = mulUnits(s, SCALE - r);
    if (den <= 0n) return null;
    const liq = divUnits(notional - pos.margin, den);
    return liq > 0n ? liq : null;
  }
  const den = mulUnits(s, SCALE + r);
  if (den <= 0n) return null;
  const liq = divUnits(notional + pos.margin, den);
  return liq > 0n ? liq : null;
}

/** Volume-weighted entry after adding `q` at price `p` to `oldAbs` at `oldEntry`. */
export function vwapEntry(oldEntry: bigint, oldAbs: bigint, p: bigint, q: bigint): bigint {
  return divRound(oldEntry * oldAbs + p * q, oldAbs + q, 'half-up');
}
