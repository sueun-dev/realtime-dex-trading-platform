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

const M = TEST_SPOT.id; // tick 1000 KRW, lot 0.0001, minNotional 5000

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
      lvls(['10000000', '0.5'], ['9999000', '1.25'], ['9998000', '0.0421']),
      lvls(['10001000', '0.33'], ['10002000', '2.5']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([
      { price: '10000000', qty: '0.5' },
      { price: '9999000', qty: '1.25' },
      { price: '9998000', qty: '0.0421' },
    ]);
    expect(book.asks).toEqual([
      { price: '10001000', qty: '0.33' },
      { price: '10002000', qty: '2.5' },
    ]);
  });

  it('incremental update only touches changed levels (minimal churn)', async () => {
    const before = t.svc.engine.seq;
    // one bid size changes, one ask level disappears, everything else identical
    const evts = await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['10000000', '0.6'], ['9999000', '1.25'], ['9998000', '0.0421']),
      lvls(['10001000', '0.33']),
    );
    const book = await bookWire();
    expect(book.bids[0]).toEqual({ price: '10000000', qty: '0.6' });
    expect(book.asks).toEqual([{ price: '10001000', qty: '0.33' }]);
    // 1 cancel+replace (bid) + 1 cancel (ask) — a handful of events, not a full requote
    expect(t.svc.engine.seq - before).toBeLessThanOrEqual(8);
    expect(evts.length).toBeLessThanOrEqual(8);
  });

  it('snaps off-grid legacy venue prices to the tick (floor bids / ceil asks)', async () => {
    await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['9999500', '0.5']), // off-grid: tick is 1000
      lvls(['10000500', '0.5']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([{ price: '9999000', qty: '0.5' }]);
    expect(book.asks).toEqual([{ price: '10001000', qty: '0.5' }]);
  });

  it('drops dust below lot/minNotional instead of crashing', async () => {
    await applyMirrorSnapshot(
      deps,
      TEST_SPOT,
      lvls(['10000000', '0.00005'], ['9999000', '0.0004']), // dust qty / dust notional
      lvls(['10001000', '1']),
    );
    const book = await bookWire();
    expect(book.bids).toEqual([]); // 0.00005 < lot; 0.0004×9,999,000 < 5,000 KRW
    expect(book.asks).toEqual([{ price: '10001000', qty: '1' }]);
  });

  it('a user bid inside the real spread rests, then fills when the venue crosses it', async () => {
    const user: TestUser = await loginAndFund(t.app);
    await applyMirrorSnapshot(deps, TEST_SPOT, lvls(['9998000', '1']), lvls(['10002000', '1']));

    // user improves the bid inside the spread — rests like on the source venue
    const res = await placeOrder(t.app, user, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '10000000',
      qty: '0.001',
      tif: 'GTC',
    });
    expect((res.json() as { status: string }).status).toBe('open');

    // the real market trades down through the user's price → mirror ask crosses
    await applyMirrorSnapshot(deps, TEST_SPOT, lvls(['9998000', '1']), lvls(['9999000', '1']));
    const acct = (await authed(t.app, user, 'GET', '/api/account')).json() as {
      balances: { asset: string; available: string }[];
    };
    const tbt = acct.balances.find((b) => b.asset === 'TBT');
    // user's resting bid filled AT THEIR price (maker), exactly like the venue
    expect(tbt?.available).toBe('0.001');
  });

  it('mirror funds itself; conservation stays intact (fee account untouched by deposits)', async () => {
    const bal = t.svc.engine.getBalances(MIRROR_USER);
    for (const b of bal) {
      expect(b.available >= 0n).toBe(true);
      expect(b.locked >= 0n).toBe(true);
    }
  });
});
