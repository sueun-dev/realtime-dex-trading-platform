import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_PERP,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_PERP.id;
let t: TestApp;
let alice: TestUser; // TWAP buyer
let bob: TestUser; // resting liquidity

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
  await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: M, leverage: 5 });
});
afterAll(async () => {
  await t.stop();
});

describe('TWAP parent orders (gap #3)', () => {
  it('slices a parent order into equal children fired on each tick, summing to totalQty', async () => {
    // deep resting ask so every market child fills
    await placeOrder(t.app, bob, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '10', tif: 'GTC' });

    // create directly for deterministic tick timing (route wiring is covered below)
    const job = t.svc.twap.create(
      {
        userId: alice.address,
        marketId: M,
        side: 'buy',
        totalQty: 600_000_000n, // 6.0
        durationMs: 6_000,
        slices: 3,
        type: 'market',
        reduceOnly: false,
      },
      1_000,
    );
    // create()/listFor() return engine-native bigints (only the HTTP layer stringifies)
    expect(job.status).toBe('running');
    expect(job.slicesTotal).toBe(3);
    expect(job.sliceQty).toBe(u('2')); // 6 / 3

    await t.svc.twap.tick(1_000); // slice 1 (nextRun was 1000)
    await t.svc.twap.tick(3_000); // slice 2
    await t.svc.twap.tick(5_000); // slice 3 → done

    const [done] = t.svc.twap.listFor(alice.address);
    expect(done?.status).toBe('done');
    expect(done?.slicesDone).toBe(3);
    expect(done?.filledQty).toBe(u('6')); // children summed to the full parent qty

    // alice holds a 6.0 long built up from the three slices
    const acct = (await authed(t.app, alice, 'GET', '/api/account')).json() as {
      positions: { marketId: string; size: string }[];
    };
    expect(acct.positions.find((p) => p.marketId === M)?.size).toBe('6');
  });

  it('overlapping ticks never double-fire the same slice (re-entrancy guard)', async () => {
    await placeOrder(t.app, bob, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '10', tif: 'GTC' });
    const job = t.svc.twap.create(
      { userId: alice.address, marketId: M, side: 'buy', totalQty: 300_000_000n, durationMs: 9_000, slices: 3, type: 'market', reduceOnly: false },
      10_000,
    );
    // fire two ticks for the same instant concurrently: the second must be a
    // no-op (the first reserved the slot + holds the #ticking guard)
    const p1 = t.svc.twap.tick(10_000);
    const p2 = t.svc.twap.tick(10_000);
    await Promise.all([p1, p2]);
    const after = t.svc.twap.listFor(alice.address).find((j) => j.id === job.id);
    expect(after?.slicesDone).toBe(1); // exactly one slice fired, not two
  });

  it('POST creates, GET lists, DELETE cancels remaining slices (routes + ownership)', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/twap', {
      marketId: M,
      side: 'buy',
      totalQty: '3',
      durationMs: 60_000,
      slices: 3,
    });
    expect(res.statusCode).toBe(200);
    const created = res.json() as { id: string; status: string; sliceQty: string };
    expect(created.status).toBe('running');
    expect(created.sliceQty).toBe('1');

    // bob cannot see or cancel alice's TWAP
    const bobList = (await authed(t.app, bob, 'GET', '/api/twap')).json() as { id: string }[];
    expect(bobList.some((j) => j.id === created.id)).toBe(false);
    const bobCancel = await authed(t.app, bob, 'DELETE', `/api/twap/${created.id}`);
    expect(bobCancel.statusCode).toBe(404);

    // alice cancels her own
    const cancel = await authed(t.app, alice, 'DELETE', `/api/twap/${created.id}`);
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelled');
    // a cancelled TWAP fires no further slices
    const before = (t.svc.twap.listFor(alice.address).find((j) => j.id === created.id)?.slicesDone) ?? 0;
    await t.svc.twap.tick(1e12);
    const after = t.svc.twap.listFor(alice.address).find((j) => j.id === created.id)?.slicesDone ?? 0;
    expect(after).toBe(before);
  });

  it('rejects a TWAP whose slice qty would fall below the lot size', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/twap', {
      marketId: M,
      side: 'buy',
      totalQty: '0.001', // lot is 0.001; over 3 slices each slice rounds to 0
      durationMs: 30_000,
      slices: 3,
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates the request (slices >= 2, duration bounds)', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/twap', {
      marketId: M,
      side: 'buy',
      totalQty: '3',
      durationMs: 60_000,
      slices: 1, // below the minimum of 2
    });
    expect(res.statusCode).toBe(422);
  });
});
