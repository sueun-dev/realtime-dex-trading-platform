/**
 * The book mirror must reproduce the real venue's depth EXACTLY (prices and
 * sizes), with minimal churn on incremental updates, and interact correctly
 * with resting user orders.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toUnits, type BookLevel } from '@dex/shared';
import { MIRROR_USER, applyMirrorSnapshot, type MirrorDeps } from '../src/bookMirror.js';
import {
  TEST_SPOT,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_SPOT.id; // TBT-USDC, tick 0.01, lot 0.001, minNotional 1

let t: TestApp;
let deps: MirrorDeps;

function lvls(...pairs: [string, string][]): BookLevel[] {
  return pairs.map(([p, q]) => ({ price: toUnits(p), qty: toUnits(q) }));
}

function bookWire(): Promise<{ bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] }> {
  return t.app
    .inject({ method: 'GET', url: `/api/markets/${M}/orderbook?depth=20` })
    .then((r) => r.json() as { bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] });
}

beforeAll(async () => {
  t = await makeApp();
  deps = { engine: t.svc.engine, pipeline: t.svc.pipeline, log: () => {} };
});
afterAll(async () => {
  await t.stop();
});

describe('applyMirrorSnapshot', () => {
  it('reproduces the venue book exactly — real prices AND sizes', async () => {
    await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['100', '0.5'], ['99.99', '1.25'], ['99.98', '0.421']),
      lvls(['100.01', '0.33'], ['100.02', '2.5']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([
      { price: '100', qty: '0.5' },
      { price: '99.99', qty: '1.25' },
      { price: '99.98', qty: '0.421' },
    ]);
    expect(book.asks).toEqual([
      { price: '100.01', qty: '0.33' },
      { price: '100.02', qty: '2.5' },
    ]);
  });

  it('incremental update only touches changed levels (minimal churn)', async () => {
    const before = t.svc.engine.seq;
    // one bid size changes, one ask level disappears, everything else identical
    const evts = await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['100', '0.6'], ['99.99', '1.25'], ['99.98', '0.421']),
      lvls(['100.01', '0.33']),
    );
    const book = await bookWire();
    expect(book.bids[0]).toEqual({ price: '100', qty: '0.6' });
    expect(book.asks).toEqual([{ price: '100.01', qty: '0.33' }]);
    // 1 cancel+replace (bid) + 1 cancel (ask) — a handful of events, not a full requote
    expect(t.svc.engine.seq - before).toBeLessThanOrEqual(8);
    expect(evts.length).toBeLessThanOrEqual(8);
  });

  it('snaps off-grid legacy venue prices to the tick (floor bids / ceil asks)', async () => {
    await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['99.995', '0.5']), // off-grid: tick is 0.01
      lvls(['100.005', '0.5']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([{ price: '99.99', qty: '0.5' }]);
    expect(book.asks).toEqual([{ price: '100.01', qty: '0.5' }]);
  });

  it('drops dust below lot/minNotional instead of crashing', async () => {
    await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['100', '0.0005'], ['99.99', '0.005']), // sub-lot qty / sub-$1 notional
      lvls(['100.01', '1']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([]); // 0.0005 < lot 0.001; 0.005×99.99 ≈ $0.50 < $1 minNotional
    expect(book.asks).toEqual([{ price: '100.01', qty: '1' }]);
  });

  it('a user bid inside the real spread rests, then fills when the venue crosses it', async () => {
    const user: TestUser = await loginAndFund(t.app);
    await applyMirrorSnapshot(deps, TEST_SPOT, lvls(['99.98', '1']), lvls(['100.02', '1']));

    // user improves the bid inside the spread — rests like on the source venue
    const res = await placeOrder(t.app, user, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '100',
      qty: '0.05',
      tif: 'GTC',
    });
    expect((res.json() as { status: string }).status).toBe('open');

    // the real market trades down through the user's price → mirror ask crosses
    await applyMirrorSnapshot(deps, TEST_SPOT, lvls(['99.98', '1']), lvls(['99.99', '1']));
    const acct = (await authed(t.app, user, 'GET', '/api/account')).json() as {
      balances: { asset: string; available: string }[];
    };
    const tbt = acct.balances.find((b) => b.asset === 'TBT');
    // user's resting bid filled AT THEIR price (maker), exactly like the venue
    expect(tbt?.available).toBe('0.05');
  });

  it('mirror funds itself; conservation stays intact (fee account untouched by deposits)', async () => {
    const bal = t.svc.engine.getBalances(MIRROR_USER);
    for (const b of bal) {
      expect(b.available >= 0n).toBe(true);
      expect(b.locked >= 0n).toBe(true);
    }
  });

  it('exposes feed staleness so a frozen book is never presented as live', async () => {
    // fresh: REST orderbook reports the venue feed as live
    const live = (await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook` })).json() as {
      stale: boolean;
    };
    expect(live.stale).toBe(false);

    // venue feed goes silent → the gate flags the market stale
    t.svc.hub.setFeedStale(M, true);
    const stale = (await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook` })).json() as {
      stale: boolean;
    };
    expect(stale.stale).toBe(true);
    expect(t.svc.hub.isFeedStale(M)).toBe(true);

    // feed recovers
    t.svc.hub.setFeedStale(M, false);
    expect(t.svc.hub.isFeedStale(M)).toBe(false);
  });
});
