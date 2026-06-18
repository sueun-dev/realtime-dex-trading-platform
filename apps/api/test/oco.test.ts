/** OCO (one-cancels-other) orders end-to-end through the API + engine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PERP, authed, loginAndFund, makeApp, placeOrder, u, type TestApp, type TestUser } from './helpers.js';

const M = TEST_PERP.id;
let t: TestApp;
let alice: TestUser;
let maker: TestUser;

beforeAll(async () => {
  t = await makeApp(); // a fresh engine so the book has no leftover orders
  alice = await loginAndFund(t.app);
  maker = await loginAndFund(t.app);
  await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: M, leverage: 5 });
  await authed(t.app, maker, 'POST', '/api/account/leverage', { marketId: M, leverage: 5 });
  await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(100), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe('OCO orders via the API (gap #5)', () => {
  it('a filled leg carries its ocoGroup and cancels the sibling leg', async () => {
    // alice opens a long so the reduce-only exit legs are valid
    await placeOrder(t.app, maker, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    const buy = await placeOrder(t.app, alice, { marketId: M, side: 'buy', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    expect(buy.statusCode).toBe(200);
    const acct = (await authed(t.app, alice, 'GET', '/api/account')).json() as { positions: { marketId: string }[] };
    expect(acct.positions.some((p) => p.marketId === M)).toBe(true);

    // OCO exit: take-profit limit @110 + stop-market @90, linked by group 'exit'
    const tp = (await placeOrder(t.app, alice, {
      marketId: M, side: 'sell', type: 'limit', price: '110', qty: '1', tif: 'GTC', reduceOnly: true, ocoGroup: 'exit',
    })).json() as { id: string; ocoGroup: string };
    expect(tp.ocoGroup).toBe('exit');
    await placeOrder(t.app, alice, {
      marketId: M, side: 'sell', type: 'market', qty: '1', tif: 'IOC', reduceOnly: true,
      triggerPrice: '90', triggerDirection: 'below', ocoGroup: 'exit',
    });

    let open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { id: string }[];
    expect(open.length).toBe(2); // TP limit + SL stop both resting/untriggered

    // maker lifts the take-profit → it fills → the stop leg cancels via OCO
    await placeOrder(t.app, maker, { marketId: M, side: 'buy', type: 'limit', price: '110', qty: '1', tif: 'GTC' });
    open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { id: string }[];
    expect(open.length).toBe(0); // both legs gone (TP filled, SL OCO-cancelled)
  });
});
