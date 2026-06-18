/** Conditional (stop / take-profit) orders end-to-end through the API + engine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PERP, authed, loginAndFund, makeApp, placeOrder, u, type TestApp, type TestUser } from './helpers.js';

const M = TEST_PERP.id;
let t: TestApp;
let alice: TestUser;
let maker: TestUser;

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  maker = await loginAndFund(t.app);
  // warm a mark price so triggers have a reference
  await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(100), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe('stop / take-profit orders via the API', () => {
  it('places a stop order that rests untriggered and shows in open orders', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'market',
      qty: '1',
      tif: 'IOC',
      triggerPrice: '90',
      triggerDirection: 'below',
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as { status: string; trigger: { price: string; direction: string } | null };
    expect(order.status).toBe('untriggered');
    expect(order.trigger).toEqual({ price: '90', direction: 'below' });

    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { status: string }[];
    expect(open.some((o) => o.status === 'untriggered')).toBe(true);
  });

  it('a validation error (non-tick trigger price) is rejected with 400', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'market',
      qty: '1',
      tif: 'IOC',
      triggerPrice: '90.5', // tick is 1
      triggerDirection: 'below',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('TICK_SIZE');
  });

  it('the stop fires when the mark crosses it, producing a real fill', async () => {
    // a resting bid for the triggered market-sell to hit
    await placeOrder(t.app, maker, { marketId: M, side: 'buy', type: 'limit', price: '89', qty: '1', tif: 'GTC' });
    // drive the mark down through 90 → the stop activates and sells into the bid
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(89), Date.now()));

    const fills = (await authed(t.app, alice, 'GET', '/api/fills')).json() as unknown[];
    expect(fills.length).toBeGreaterThanOrEqual(1);
    // the untriggered order is gone from the open set
    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { status: string }[];
    expect(open.some((o) => o.status === 'untriggered')).toBe(false);
  });

  it('an untriggered order can be cancelled before it fires', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '120',
      qty: '1',
      triggerPrice: '110',
      triggerDirection: 'above',
    });
    const id = (res.json() as { id: string }).id;
    const cancel = await authed(t.app, alice, 'DELETE', `/api/orders/${id}`);
    expect(cancel.statusCode).toBe(200);
    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as { id: string }[];
    expect(open.some((o) => o.id === id)).toBe(false);
  });

  it('places a trailing stop that seeds its stop from the mark and carries the trail (gap #4)', async () => {
    // reset the mark to 100 (earlier tests moved it); a sell trailing stop with
    // trail 10 then seeds its stop at 90
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(100), Date.now()));
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'market',
      qty: '1',
      tif: 'IOC',
      reduceOnly: true,
      triggerDirection: 'below',
      trailDistance: '10',
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as {
      status: string;
      trigger: { price: string; direction: string; trail?: string } | null;
    };
    expect(order.status).toBe('untriggered');
    expect(order.trigger).toEqual({ price: '90', direction: 'below', trail: '10' });

    // the stop ratchets up as the mark rises (100 → 150 ⇒ stop 90 → 140)
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M, u(150), Date.now()));
    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as {
      trigger: { price: string; trail?: string } | null;
    }[];
    const trailing = open.find((o) => o.trigger?.trail === '10');
    expect(trailing?.trigger?.price).toBe('140');
  });

  it('rejects trailDistance without a triggerDirection (422)', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'market',
      qty: '1',
      tif: 'IOC',
      trailDistance: '10',
    });
    expect(res.statusCode).toBe(422);
  });
});
