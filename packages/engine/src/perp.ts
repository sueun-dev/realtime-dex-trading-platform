/**
 * Perp position store + isolated-margin math helpers.
 */
import {
  absBig,
  divRound,
  mulUnits,
  type MarketConfig,
  type Position,
} from '@dex/shared';

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
  return divRound(mulUnits(mark, absBig(pos.size)), 2n * BigInt(m.maxLeverage), 'ceil');
}

/** Volume-weighted entry after adding `q` at price `p` to `oldAbs` at `oldEntry`. */
export function vwapEntry(oldEntry: bigint, oldAbs: bigint, p: bigint, q: bigint): bigint {
  return divRound(oldEntry * oldAbs + p * q, oldAbs + q, 'half-up');
}
