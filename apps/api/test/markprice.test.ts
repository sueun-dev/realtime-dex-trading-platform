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

const M = TEST_PERP.id;
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

describe('mark price exposure', () => {
  it('404s before any mark has been observed', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/markets/${M}/mark` });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/markets/:id/mark returns the engine mark as a decimal string', async () => {
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, toUnits('100'), Date.now()));
    const res = await t.app.inject({ method: 'GET', url: `/api/markets/${M}/mark` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ marketId: M, price: '100' });
  });

  it('MARKET_NOT_FOUND for an unknown market mark', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets/NOPE-PERP/mark' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('MARKET_NOT_FOUND');
  });

  it('GET /api/markets carries mark on perp rows and null on spot rows', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets' });
    const rows = res.json() as Record<string, unknown>[];
    expect(rows.find((r) => r['id'] === M)?.['mark']).toBe('100');
    expect(rows.find((r) => r['id'] === TEST_SPOT.id)?.['mark']).toBeNull();
  });

  it('account positions carry markPrice, unrealizedPnl, and liquidationPrice', async () => {
    // alice opens a 10x long; bob provides the other side
    await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: M, leverage: 10 });
    await placeOrder(t.app, bob, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    await placeOrder(t.app, alice, { marketId: M, side: 'buy', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, toUnits('105'), Date.now()));

    const acct = (await authed(t.app, alice, 'GET', '/api/account')).json() as {
      positions: { marketId: string; size: string; markPrice: string; unrealizedPnl: string; liquidationPrice: string | null }[];
    };
    const pos = acct.positions.find((p) => p.marketId === M)!;
    expect(pos.markPrice).toBe('105');
    expect(pos.unrealizedPnl).toBe('5'); // long 1 @100, mark 105 → +5
    // 10x long: liquidation price sits below entry and is a positive number
    expect(pos.liquidationPrice).not.toBeNull();
    expect(Number(pos.liquidationPrice)).toBeGreaterThan(0);
    expect(Number(pos.liquidationPrice)).toBeLessThan(100);
  });
});
