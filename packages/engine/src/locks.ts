/**
 * Deterministic lock formulas. The engine maintains the invariant
 * `order.lockRemaining === lockFor(order, remainingQty)` at all times, which
 * makes restoreState's recomputed locks exactly equal to live locks.
 */
import { divRound, feeOn, mulUnits } from '@dex/shared';

/** SPOT buy: remaining notional at limit price + taker-fee reserve, in quote. */
export function spotBuyLock(limitPrice: bigint, rem: bigint, takerFeeBps: number): bigint {
  const n = mulUnits(limitPrice, rem);
  return n + feeOn(n, takerFeeBps);
}

/** SPOT sell: remaining base qty. */
export function spotSellLock(rem: bigint): bigint {
  return rem;
}

/** PERP (non-reduceOnly): remaining IM at limit price + taker-fee reserve, USDC. */
export function perpLock(
  limitPrice: bigint,
  rem: bigint,
  leverage: number,
  takerFeeBps: number,
): bigint {
  const n = mulUnits(limitPrice, rem);
  return divRound(n, BigInt(leverage), 'ceil') + feeOn(n, takerFeeBps);
}
