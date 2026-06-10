import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import {
  TEST_PERP,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_PERP.id;

let t: TestApp;
let alice: TestUser; // long, 5x
let bob: TestUser; // short, 1x

interface Wire {
  [k: string]: unknown;
}

async function account(user: TestUser): Promise<Wire> {
  return (await authed(t.app, user, 'GET', '/api/account')).json() as Wire;
}

function usdc(acct: Wire): { available: string; locked: string } {
  const list = acct['balances'] as { asset: string; available: string; locked: string }[];
  return list.find((b) => b.asset === 'USDC') ?? { available: '0', locked: '0' };
}

function position(acct: Wire): Wire | undefined {
  return (acct['positions'] as Wire[]).find((p) => p['marketId'] === M);
}

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
});
afterAll(async () => {
  await t.stop();
});

describe('perp lifecycle: leverage, open, mark, reduce, liquidate', () => {
  it('sets leverage before trading', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/account/leverage', {
      marketId: M,
      leverage: 5,
    });
    expect(res.statusCode).toBe(200);
    const over = await authed(t.app, alice, 'POST', '/api/account/leverage', {
      marketId: M,
      leverage: 21,
    });
    expect(over.statusCode).toBe(400);
    expect(((over.json() as Wire)['error'] as Wire)['code']).toBe('LEVERAGE_EXCEEDED');
  });

  it('opens 1.0 long(5x) vs short(1x) at 100 with exact margins and fees', async () => {
    const maker = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '100',
      qty: '1',
      tif: 'GTC',
    });
    expect(maker.statusCode).toBe(200);
    const taker = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '100',
      qty: '1',
      tif: 'GTC',
    });
    expect(taker.statusCode).toBe(200);
    expect((taker.json() as Wire)['status']).toBe('filled');

    const a = await account(alice);
    // margin 100/5 = 20, maker fee 2 bps of 100 = 0.02
    expect(position(a)).toMatchObject({ size: '1', entryPrice: '100', leverage: 5, margin: '20' });
    expect(usdc(a)).toMatchObject({ available: '99979.98', locked: '0' });

    const b = await account(bob);
    // margin 100/1 = 100, taker fee 5 bps of 100 = 0.05
    expect(position(b)).toMatchObject({ size: '-1', entryPrice: '100', margin: '100' });
    expect(usdc(b)).toMatchObject({ available: '99899.95', locked: '0' });
  });

  it('mark price moves unrealized PnL in opposite directions', async () => {
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, toUnits('110'), Date.now()));
    const a = await account(alice);
    const b = await account(bob);
    const aEquity = toUnits(a['perpEquity'] as string);
    const bEquity = toUnits(b['perpEquity'] as string);
    // long gains exactly what the short loses (zero-sum at the mark)
    expect(aEquity - toUnits(usdc(a).available) - toUnits('20')).toBe(toUnits('10'));
    expect(bEquity - toUnits(usdc(b).available) - toUnits('100')).toBe(toUnits('-10'));
  });

  it('reduceOnly close releases proportional margin + realized PnL', async () => {
    const ro = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '110',
      qty: '0.5',
      tif: 'GTC',
      reduceOnly: true,
    });
    expect(ro.statusCode).toBe(200);
    const cross = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'market',
      qty: '0.5',
      tif: 'IOC',
    });
    expect(cross.statusCode).toBe(200);
    expect((cross.json() as Wire)['filledQty']).toBe('0.5');

    const a = await account(alice);
    // half closed at 110: released margin 10 + realized +5 − maker fee 0.011
    expect(position(a)).toMatchObject({ size: '0.5', entryPrice: '100', margin: '10' });
    expect(usdc(a).available).toBe('99994.969');

    const b = await account(bob);
    // bob reduced his short: -1 → -0.5, margin 100 → 50
    expect(position(b)).toMatchObject({ size: '-0.5', margin: '50' });
  });

  it('rejects leverage change while a position is open', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/account/leverage', {
      marketId: M,
      leverage: 10,
    });
    expect(res.statusCode).toBe(400);
    expect(((res.json() as Wire)['error'] as Wire)['code']).toBe('LEVERAGE_IN_USE');
  });

  it('reduceOnly larger than the position rejects', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '110',
      qty: '5',
      tif: 'GTC',
      reduceOnly: true,
    });
    expect(res.statusCode).toBe(400);
    expect(((res.json() as Wire)['error'] as Wire)['code']).toBe('REDUCE_ONLY_VIOLATION');
  });

  it('a hopeless mark move liquidates the underwater short', async () => {
    // bob: short 0.5 @100, margin 50, 1x. At mark 200 equity hits 0 < MM.
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, toUnits('200'), Date.now()));
    const b = await account(bob);
    expect(position(b)).toBeUndefined();
    // wiped margin: payout was max(0, 50 + (100−200)×0.5) = 0
    const a = await account(alice);
    expect(position(a)).toBeDefined(); // alice (long) survives
  });
});
