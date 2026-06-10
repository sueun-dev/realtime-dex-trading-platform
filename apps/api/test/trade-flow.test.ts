import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const M = TEST_SPOT.id;

let t: TestApp;
let alice: TestUser; // maker (seeded with TBT)
let bob: TestUser; // taker

interface Wire {
  [k: string]: unknown;
}

function bal(account: Wire, asset: string): { available: string; locked: string } {
  const list = account['balances'] as { asset: string; available: string; locked: string }[];
  const row = list.find((b) => b.asset === asset);
  return row ?? { available: '0', locked: '0' };
}

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
  // base coins enter the demo system via the liquidity bot in production;
  // tests seed the maker directly through the same pipeline
  await t.svc.pipeline.exec(() => t.svc.engine.deposit(alice.address, 'TBT', u(10), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe('faucet', () => {
  it('claims once, then 409', async () => {
    const again = await authed(t.app, alice, 'POST', '/api/account/faucet');
    expect(again.statusCode).toBe(409);
    expect((again.json() as Wire)['error']).toMatchObject({ code: 'FAUCET_ALREADY_CLAIMED' });
    const account = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(account, 'KRW').available).toBe('100000000');
    expect(bal(account, 'USDC').available).toBe('100000');
  });
});

describe('spot trade lifecycle (maker/taker, exact fees)', () => {
  let makerOrderId = '';

  it('maker postOnly ask rests and shows in the book', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '10000000',
      qty: '0.5',
      tif: 'GTC',
      postOnly: true,
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as Wire;
    expect(order['status']).toBe('open');
    makerOrderId = order['id'] as string;

    const book = (
      await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook?depth=5` })
    ).json() as { asks: { price: string; qty: string }[]; bids: unknown[] };
    expect(book.asks).toEqual([{ price: '10000000', qty: '0.5' }]);
    expect(book.bids).toEqual([]);

    const account = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(account, 'TBT')).toMatchObject({ available: '9.5', locked: '0.5' });
  });

  it('taker buy fills 0.3 at the maker price with exact balance math', async () => {
    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '10000000',
      qty: '0.3',
      tif: 'GTC',
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as Wire;
    expect(order['status']).toBe('filled');
    expect(order['filledQty']).toBe('0.3');

    // taker bob: pays 3,000,000 notional + 3,000 fee (10 bps)
    const bobAcct = (await authed(t.app, bob, 'GET', '/api/account')).json() as Wire;
    expect(bal(bobAcct, 'KRW')).toMatchObject({ available: '96997000', locked: '0' });
    expect(bal(bobAcct, 'TBT')).toMatchObject({ available: '0.3', locked: '0' });

    // maker alice: receives 3,000,000 − 1,500 fee (5 bps); 0.2 TBT still locked
    const aliceAcct = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(aliceAcct, 'KRW')).toMatchObject({ available: '102998500', locked: '0' });
    expect(bal(aliceAcct, 'TBT')).toMatchObject({ available: '9.5', locked: '0.2' });
  });

  it('public trades + both users see the fill with correct roles and fees', async () => {
    const trades = (
      await t.app.inject({ method: 'GET', url: `/api/markets/${M}/trades` })
    ).json() as Wire[];
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ price: '10000000', qty: '0.3', takerSide: 'buy' });

    const aliceFills = (await authed(t.app, alice, 'GET', '/api/fills')).json() as Wire[];
    expect(aliceFills).toHaveLength(1);
    expect(aliceFills[0]).toMatchObject({ side: 'sell', role: 'maker', fee: '1500', qty: '0.3' });

    const bobFills = (await authed(t.app, bob, 'GET', '/api/fills')).json() as Wire[];
    expect(bobFills[0]).toMatchObject({ side: 'buy', role: 'taker', fee: '3000', qty: '0.3' });
  });

  it('open orders list shows the remainder; cancel releases the exact lock', async () => {
    const open = (await authed(t.app, alice, 'GET', '/api/orders')).json() as Wire[];
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: makerOrderId, filledQty: '0.3', qty: '0.5' });

    // someone else cannot cancel it
    const stranger = await authed(t.app, bob, 'DELETE', `/api/orders/${makerOrderId}`);
    expect(stranger.statusCode).toBe(401);

    const res = await authed(t.app, alice, 'DELETE', `/api/orders/${makerOrderId}`);
    expect(res.statusCode).toBe(200);
    const acct = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(acct, 'TBT')).toMatchObject({ available: '9.7', locked: '0' });

    const again = await authed(t.app, alice, 'DELETE', `/api/orders/${makerOrderId}`);
    expect(again.statusCode).toBe(404);
  });

  it('market buy without a price gets an auto bound and fills', async () => {
    await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '10000000',
      qty: '0.2',
      tif: 'GTC',
    });
    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'market',
      qty: '0.1',
      tif: 'IOC',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Wire)['filledQty']).toBe('0.1');
  });
});

describe('order validation (engine + zod, exact error codes)', () => {
  const cases: { name: string; body: Record<string, unknown>; status: number; code: string }[] = [
    {
      name: 'off-tick price',
      body: { marketId: M, side: 'buy', type: 'limit', price: '10000500', qty: '0.1', tif: 'GTC' },
      status: 400,
      code: 'TICK_SIZE',
    },
    {
      name: 'off-lot qty',
      body: { marketId: M, side: 'buy', type: 'limit', price: '10000000', qty: '0.00005', tif: 'GTC' },
      status: 400,
      code: 'LOT_SIZE',
    },
    {
      name: 'below min notional',
      body: { marketId: M, side: 'buy', type: 'limit', price: '1000', qty: '0.0001', tif: 'GTC' },
      status: 400,
      code: 'MIN_NOTIONAL',
    },
    {
      name: 'unknown market',
      body: { marketId: 'KRW-NOPE', side: 'buy', type: 'limit', price: '1000', qty: '1', tif: 'GTC' },
      status: 404,
      code: 'MARKET_NOT_FOUND',
    },
    {
      name: 'market order with GTC',
      body: { marketId: M, side: 'buy', type: 'market', price: '10000000', qty: '0.1', tif: 'GTC' },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'postOnly market order',
      body: { marketId: M, side: 'buy', type: 'market', price: '10000000', qty: '0.1', tif: 'IOC', postOnly: true },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'limit without price',
      body: { marketId: M, side: 'buy', type: 'limit', qty: '0.1', tif: 'GTC' },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'negative qty',
      body: { marketId: M, side: 'buy', type: 'limit', price: '10000000', qty: '-1', tif: 'GTC' },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'insufficient balance',
      body: { marketId: M, side: 'sell', type: 'limit', price: '10000000', qty: '5000', tif: 'GTC' },
      status: 400,
      code: 'INSUFFICIENT_BALANCE',
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const res = await placeOrder(t.app, bob, c.body as never);
      expect(res.statusCode).toBe(c.status);
      expect(((res.json() as Wire)['error'] as Wire)['code']).toBe(c.code);
    });
  }

  it('FOK that cannot fill fully rejects with zero side effects', async () => {
    const before = (
      await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook` })
    ).body;
    // book holds only 0.1 — affordable but not fully fillable
    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '10000000',
      qty: '0.2',
      tif: 'FOK',
    });
    expect(res.statusCode).toBe(400);
    expect(((res.json() as Wire)['error'] as Wire)['code']).toBe('FOK_NOT_FILLED');
    const after = (await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook` })).body;
    // seq is a global event counter (the rejection event bumps it) — compare levels
    const levels = (body: string): unknown => {
      const b = JSON.parse(body) as { bids: unknown; asks: unknown };
      return { bids: b.bids, asks: b.asks };
    };
    expect(levels(after)).toEqual(levels(before));
  });

  it('postOnly that would cross rejects', async () => {
    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '10000000',
      qty: '0.1',
      tif: 'GTC',
      postOnly: true,
    });
    expect(res.statusCode).toBe(400);
    expect(((res.json() as Wire)['error'] as Wire)['code']).toBe('POST_ONLY_WOULD_CROSS');
  });

  it('market order with empty book and no ticker rejects', async () => {
    const empty = await makeApp();
    try {
      const user = await loginAndFund(empty.app);
      const res = await placeOrder(empty.app, user, {
        marketId: M,
        side: 'buy',
        type: 'market',
        qty: '0.1',
        tif: 'IOC',
      });
      expect(res.statusCode).toBe(400);
      expect(((res.json() as Wire)['error'] as Wire)['code']).toBe('INVALID_ORDER');
    } finally {
      await empty.stop();
    }
  });
});
