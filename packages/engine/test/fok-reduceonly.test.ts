/**
 * FOK all-or-none vs book qty that evaporates mid-match.
 *
 * A static depth sum over-counts fillable qty: filling a maker's non-reduceOnly
 * order shrinks their position, which auto-trims their deeper resting
 * reduceOnly orders before the taker reaches them; own resting orders are
 * STP-cancelled, not filled. The FOK pre-check must dry-run the real matching
 * loop so a FOK either fills entirely or rejects with ZERO side effects.
 */
import { describe, expect, it } from 'vitest';
import { PERP, newExchange, req, u } from './helpers.js';
import type { Exchange } from '../src/index.js';

const M = PERP.id;

/** carol long 1.0 @100 against erin; dave is the FOK taker. */
function setup(): Exchange {
  const ex = newExchange();
  ex.deposit('carol', 'USDC', u(100_000), 1);
  ex.deposit('dave', 'USDC', u(100_000), 2);
  ex.deposit('erin', 'USDC', u(100_000), 3);
  ex.submitOrder('erin', req(M, 'sell', 'limit', u(100), u(1)), 4);
  ex.submitOrder('carol', req(M, 'buy', 'limit', u(100), u(1)), 5);
  return ex;
}

describe('FOK pre-check dry-runs the matching loop', () => {
  it('rejects when book qty would evaporate via the reduceOnly auto-trim', () => {
    const ex = setup();
    // carol rests RO sell 1.0 @101 and non-RO sell 0.5 @100
    expect(
      ex
        .submitOrder('carol', req(M, 'sell', 'limit', u(101), u(1), { reduceOnly: true }), 6)
        .some((e) => e.kind === 'orderAccepted'),
    ).toBe(true);
    expect(
      ex
        .submitOrder('carol', req(M, 'sell', 'limit', u(100), u('0.5')), 7)
        .some((e) => e.kind === 'orderAccepted'),
    ).toBe(true);

    // static depth within 101 = 1.5, but filling 0.5@100 shrinks carol's
    // position to 0.5 long and trims her RO 1.0@101 — true fillable is 0.5
    const evts = ex.submitOrder('dave', req(M, 'buy', 'limit', u(101), u('1.5'), { tif: 'FOK' }), 8);
    expect(evts.some((e) => e.kind === 'orderRejected' && e.code === 'FOK_NOT_FILLED')).toBe(true);
    expect(evts.filter((e) => e.kind === 'trade')).toHaveLength(0);

    // zero side effects: dave has no orders, carol's book is untouched
    expect(ex.getOpenOrders('dave', M)).toEqual([]);
    expect(ex.getOpenOrders('carol', M)).toHaveLength(2);
    expect(ex.getOrderbook(M, 10).asks).toEqual([
      { price: u(100), qty: u('0.5') },
      { price: u(101), qty: u(1) },
    ]);
  });

  it('fills fully when the surviving reduceOnly qty still covers the order', () => {
    const ex = setup();
    // RO sell 0.4 @101 survives the trim (0.4 <= post-fill position 0.5)
    ex.submitOrder('carol', req(M, 'sell', 'limit', u(101), u('0.4'), { reduceOnly: true }), 6);
    ex.submitOrder('carol', req(M, 'sell', 'limit', u(100), u('0.5')), 7);

    const evts = ex.submitOrder('dave', req(M, 'buy', 'limit', u(101), u('0.9'), { tif: 'FOK' }), 8);
    expect(evts.some((e) => e.kind === 'orderRejected')).toBe(false);
    expect(evts.filter((e) => e.kind === 'trade')).toHaveLength(2);
    expect(ex.getOpenOrders('dave', M)).toEqual([]);
    expect(ex.getOrderbook(M, 10).asks).toEqual([]);
  });

  it('does not count own resting orders (they STP-cancel, not fill)', () => {
    const ex = newExchange();
    ex.deposit('frank', 'USDC', u(100_000), 1);
    ex.deposit('gina', 'USDC', u(100_000), 2);
    ex.submitOrder('gina', req(M, 'sell', 'limit', u(100), u('0.5')), 3);
    ex.submitOrder('frank', req(M, 'sell', 'limit', u(100), u('0.5')), 4);

    // static depth at 100 = 1.0, but frank's own 0.5 cannot fill him
    const evts = ex.submitOrder('frank', req(M, 'buy', 'limit', u(100), u(1), { tif: 'FOK' }), 5);
    expect(evts.some((e) => e.kind === 'orderRejected' && e.code === 'FOK_NOT_FILLED')).toBe(true);
    expect(evts.filter((e) => e.kind === 'trade')).toHaveLength(0);
    // the rejected pre-check must not have cancelled his resting order
    expect(ex.getOpenOrders('frank', M)).toHaveLength(1);
  });
});
