/** Bracket orders (market entry + OCO take-profit/stop-loss) via the API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PERP, TEST_SPOT, authed, loginAndFund, makeApp, placeOrder, u, type TestApp, type TestUser } from './helpers.js';

const M = TEST_PERP.id;
let t: TestApp;
let alice: TestUser;
let maker: TestUser;

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  maker = await loginAndFund(t.app);
  await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: M, leverage: 5 });
  await authed(t.app, maker, 'POST', '/api/account/leverage', { marketId: M, leverage: 5 });
  await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(100), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe('bracket orders via the API (gap #6)', () => {
  it('fills a market entry and attaches an OCO TP/SL pair that protect the position', async () => {
    // resting asks so the market entry fills, plus a bid for the TP to lift later
    await placeOrder(t.app, maker, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '5', tif: 'GTC' });

    const res = await authed(t.app, alice, 'POST', '/api/bracket', {
      marketId: M,
      side: 'buy',
      qty: '1',
      takeProfitPrice: '110',
      stopLossPrice: '90',
    });
    expect(res.statusCode).toBe(200);
    const bracket = res.json() as {
      ocoGroup: string;
      entry: { status: string };
      takeProfit: { id: string; ocoGroup: string; status: string; price: string };
      stopLoss: { id: string; ocoGroup: string; status: string; trigger: { price: string; direction: string } };
    };
    expect(bracket.entry.status).toBe('filled');
    expect(bracket.takeProfit.ocoGroup).toBe(bracket.ocoGroup);
    expect(bracket.takeProfit.price).toBe('110');
    expect(bracket.stopLoss.ocoGroup).toBe(bracket.ocoGroup);
    expect(bracket.stopLoss.trigger).toEqual({ price: '90', direction: 'below' });

    // both protective legs are live (TP resting + SL untriggered)
    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { id: string }[];
    expect(open.length).toBe(2);

    // take-profit fires → it fills → the stop-loss leg cancels via OCO, position closes
    await placeOrder(t.app, maker, { marketId: M, side: 'buy', type: 'limit', price: '110', qty: '1', tif: 'GTC' });
    const after = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { id: string }[];
    expect(after.length).toBe(0);
    const acct = (await authed(t.app, alice, 'GET', '/api/account')).json() as { positions: { marketId: string }[] };
    expect(acct.positions.some((p) => p.marketId === M)).toBe(false); // flat
  });

  it('rejects a bracket on a spot market (legs are reduce-only / perp-only)', async () => {
    const res = await authed(t.app, alice, 'POST', '/api/bracket', {
      marketId: TEST_SPOT.id,
      side: 'buy',
      qty: '1',
      takeProfitPrice: '110',
      stopLossPrice: '90',
    });
    expect(res.statusCode).toBe(400);
  });
});
