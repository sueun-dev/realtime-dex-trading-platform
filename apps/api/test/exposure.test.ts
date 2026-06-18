import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import {
  TEST_PERP,
  TEST_SPOT,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  type TestApp,
  type TestUser,
} from './helpers.js';

const SPOT = TEST_SPOT.id;
const PERP = TEST_PERP.id;
let t: TestApp;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
});
afterAll(async () => {
  await t.stop();
});

describe('order lookup (gap #14)', () => {
  it('GET /api/orders/:id returns the owner’s order and 404s for non-owners', async () => {
    const placed = (await placeOrder(t.app, alice, {
      marketId: SPOT,
      side: 'buy',
      type: 'limit',
      price: '40',
      qty: '1',
      tif: 'GTC',
      clientOrderId: 'cid-lookup-1',
    })).json() as { id: string };

    const own = await authed(t.app, alice, 'GET', `/api/orders/${placed.id}`);
    expect(own.statusCode).toBe(200);
    expect((own.json() as { id: string }).id).toBe(placed.id);

    // another user cannot read it (no leakage) — looks like not-found
    const other = await authed(t.app, bob, 'GET', `/api/orders/${placed.id}`);
    expect(other.statusCode).toBe(404);
    expect((other.json() as { error?: { code?: string } }).error?.code).toBe('ORDER_NOT_FOUND');
  });

  it('GET /api/orders?clientOrderId= resolves the live order by client id', async () => {
    const res = await authed(t.app, alice, 'GET', '/api/orders?clientOrderId=cid-lookup-1');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { clientOrderId: string }).clientOrderId).toBe('cid-lookup-1');

    const miss = await authed(t.app, alice, 'GET', '/api/orders?clientOrderId=nope');
    expect(miss.statusCode).toBe(404);
  });
});

describe('cancel-all (gap #15)', () => {
  it('DELETE /api/orders cancels every open order, optionally scoped to a market', async () => {
    for (const price of ['38', '39', '41']) {
      await placeOrder(t.app, bob, { marketId: SPOT, side: 'buy', type: 'limit', price, qty: '1', tif: 'GTC' });
    }
    const before = (await authed(t.app, bob, 'GET', '/api/orders')).json() as unknown[];
    expect(before.length).toBeGreaterThanOrEqual(3);

    const res = await authed(t.app, bob, 'DELETE', `/api/orders?market=${SPOT}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { cancelled: number }).cancelled).toBeGreaterThanOrEqual(3);

    const after = (await authed(t.app, bob, 'GET', '/api/orders')).json() as unknown[];
    expect(after).toEqual([]);
  });
});

describe('funding + liquidation history (gaps #9, #10)', () => {
  it('records funding payments and exposes them via /api/account/funding', async () => {
    await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: PERP, leverage: 5 });
    await placeOrder(t.app, bob, { marketId: PERP, side: 'sell', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    await placeOrder(t.app, alice, { marketId: PERP, side: 'buy', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(PERP, toUnits('100'), Date.now()));
    await t.svc.pipeline.exec(() => t.svc.engine.applyFunding(PERP, toUnits('0.001'), Date.now()));

    const res = await authed(t.app, alice, 'GET', '/api/account/funding');
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { marketId: string; payment: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.marketId).toBe(PERP);
  });

  it('records liquidations and exposes them via /api/account/liquidations', async () => {
    // crater the mark so alice's 5x long is force-closed
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(PERP, toUnits('50'), Date.now()));
    const res = await authed(t.app, alice, 'GET', '/api/account/liquidations');
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { marketId: string; size: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.marketId).toBe(PERP);
  });

  it('exposes realized PnL summary + tape via /api/account/pnl (gap #1)', async () => {
    // the liquidation above crystallized realized PnL for alice on the perp
    const summary = (await authed(t.app, alice, 'GET', '/api/account/pnl')).json() as {
      total: string;
      byMarket: { marketId: string; amount: string }[];
    };
    expect(typeof summary.total).toBe('string');
    expect(summary.byMarket.some((m) => m.marketId === PERP)).toBe(true);

    const tape = (await authed(t.app, alice, 'GET', '/api/account/pnl?tape=1')).json() as {
      marketId: string;
      amount: string;
    }[];
    expect(tape.length).toBeGreaterThanOrEqual(1);
    expect(tape[0]).toHaveProperty('amount');
    expect(tape.some((r) => r.marketId === PERP)).toBe(true);
  });
});
