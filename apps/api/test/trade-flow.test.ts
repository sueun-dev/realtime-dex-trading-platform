import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_SPOT,
  authed,
  login,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_SPOT.id; // TBT-USDC, tick 0.01, lot 0.001, minNotional 1, maker 5bps / taker 10bps

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

describe('health, readiness & metrics', () => {
  it('health is liveness-only; readiness 503s until feeds/marks are warm', async () => {
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect((health.json() as { ok: boolean }).ok).toBe(true);
    // this synthetic app has no live feeds → not ready to take traffic
    const ready = await t.app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(503);
    expect((ready.json() as { ready: boolean }).ready).toBe(false);
  });

  it('exposes Prometheus-style metrics from real signals', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('dex_engine_seq ');
    expect(body).toContain('dex_orders_live ');
    expect(body).toContain('dex_ws_connections ');
    expect(body).toMatch(/dex_markets_total \d+/);
  });
});

describe('faucet', () => {
  it('concurrent claims deposit exactly once (atomic CAS, no double-spend)', async () => {
    const carol = await login(t.app); // unfunded — claims the faucet below
    // fire 8 faucet claims at once — only one may succeed
    const results = await Promise.all(
      Array.from({ length: 8 }, () => authed(t.app, carol, 'POST', '/api/account/faucet')),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    const conflict = results.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(7);
    // balance reflects exactly one faucet, not eight
    const acct = (await authed(t.app, carol, 'GET', '/api/account')).json() as Wire;
    expect(bal(acct, 'USDC').available).toBe('100000');
  });

  it('claims once, then 409 — a single USDC collateral, no fiat', async () => {
    const again = await authed(t.app, alice, 'POST', '/api/account/faucet');
    expect(again.statusCode).toBe(409);
    expect((again.json() as Wire)['error']).toMatchObject({ code: 'FAUCET_ALREADY_CLAIMED' });
    const account = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(account, 'USDC').available).toBe('100000');
    // no KRW (or any fiat) ever exists on the exchange
    expect((account['balances'] as { asset: string }[]).some((b) => b.asset === 'KRW')).toBe(false);
  });
});

describe('spot trade lifecycle (maker/taker, exact USDC fees)', () => {
  let makerOrderId = '';

  it('maker postOnly ask rests and shows in the book', async () => {
    const res = await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '100',
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
    expect(book.asks).toEqual([{ price: '100', qty: '0.5' }]);
    expect(book.bids).toEqual([]);

    const account = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(account, 'TBT')).toMatchObject({ available: '9.5', locked: '0.5' });
  });

  it('taker buy fills 0.3 at the maker price with exact balance math', async () => {
    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '100',
      qty: '0.3',
      tif: 'GTC',
    });
    expect(res.statusCode).toBe(200);
    const order = res.json() as Wire;
    expect(order['status']).toBe('filled');
    expect(order['filledQty']).toBe('0.3');

    // taker bob: pays 30 notional + 0.03 fee (10 bps)
    const bobAcct = (await authed(t.app, bob, 'GET', '/api/account')).json() as Wire;
    expect(bal(bobAcct, 'USDC')).toMatchObject({ available: '99969.97', locked: '0' });
    expect(bal(bobAcct, 'TBT')).toMatchObject({ available: '0.3', locked: '0' });

    // maker alice: receives 30 − 0.015 fee (5 bps); 0.2 TBT still locked
    const aliceAcct = (await authed(t.app, alice, 'GET', '/api/account')).json() as Wire;
    expect(bal(aliceAcct, 'USDC')).toMatchObject({ available: '100029.985', locked: '0' });
    expect(bal(aliceAcct, 'TBT')).toMatchObject({ available: '9.5', locked: '0.2' });
  });

  it('public trades + both users see the fill with correct roles and fees', async () => {
    const trades = (
      await t.app.inject({ method: 'GET', url: `/api/markets/${M}/trades` })
    ).json() as Wire[];
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ price: '100', qty: '0.3', takerSide: 'buy' });

    const aliceFills = (await authed(t.app, alice, 'GET', '/api/fills')).json() as Wire[];
    expect(aliceFills).toHaveLength(1);
    expect(aliceFills[0]).toMatchObject({ side: 'sell', role: 'maker', fee: '0.015', qty: '0.3' });

    const bobFills = (await authed(t.app, bob, 'GET', '/api/fills')).json() as Wire[];
    expect(bobFills[0]).toMatchObject({ side: 'buy', role: 'taker', fee: '0.03', qty: '0.3' });
  });

  it('house commission lands on the fee account (stats endpoint)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/stats/fees' });
    expect(res.statusCode).toBe(200);
    const fees = res.json() as { asset: string; available: string }[];
    // maker 0.015 + taker 0.03 from the single 0.3 @ 100 fill
    expect(fees.find((f) => f.asset === 'USDC')).toMatchObject({ available: '0.045' });
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

  it('order response carries the volume-weighted average fill price', async () => {
    // two resting asks at different prices, then a market buy sweeps both
    await placeOrder(t.app, alice, { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '0.01', tif: 'GTC' });
    await placeOrder(t.app, alice, { marketId: M, side: 'sell', type: 'limit', price: '102', qty: '0.01', tif: 'GTC' });
    const res = await placeOrder(t.app, bob, {
      marketId: M, side: 'buy', type: 'market', qty: '0.02', tif: 'IOC',
    });
    const order = res.json() as Wire;
    expect(order['filledQty']).toBe('0.02');
    // (0.01×100 + 0.01×102) / 0.02 = 101
    expect(order['avgFillPrice']).toBe('101');
  });

  it('duplicate clientOrderId retry is idempotent — returns the existing order, not an error', async () => {
    const body = { marketId: M, side: 'sell' as const, type: 'limit' as const, price: '100', qty: '0.01', tif: 'GTC' as const, clientOrderId: 'idem-1' };
    const first = await placeOrder(t.app, alice, body);
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as Wire)['id'];
    const retry = await placeOrder(t.app, alice, body);
    expect(retry.statusCode).toBe(200); // not 409 — idempotent replay
    expect((retry.json() as Wire)['id']).toBe(firstId); // the SAME order, no double-submit
  });

  it('market buy without a price gets an auto bound and fills', async () => {
    await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '100',
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

describe('order & fill history (status filter + cursor pagination)', () => {
  it('?status= is honored: open vs closed vs all, with a beforeSeq cursor', async () => {
    const app = await makeApp();
    try {
      const u = await loginAndFund(app.app);
      await app.svc.pipeline.exec(() => app.svc.engine.deposit(u.address, 'TBT', 100_000_000n, Date.now()));
      // place 3 sells, cancel 2 → 2 closed (cancelled) + 1 open
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await placeOrder(app.app, u, {
          marketId: M, side: 'sell', type: 'limit', price: String(100 + i), qty: '0.01', tif: 'GTC',
        });
        ids.push((r.json() as { id: string }).id);
      }
      await authed(app.app, u, 'DELETE', `/api/orders/${ids[0]}`);
      await authed(app.app, u, 'DELETE', `/api/orders/${ids[1]}`);

      const open = (await authed(app.app, u, 'GET', '/api/orders?status=open')).json() as Wire[];
      expect(open.map((o) => o['id'])).toEqual([ids[2]]); // only the resting one

      const closed = (await authed(app.app, u, 'GET', '/api/orders?status=closed')).json() as Wire[];
      expect(closed.map((o) => o['id']).sort()).toEqual([ids[0], ids[1]].sort());
      expect(closed.every((o) => o['status'] === 'cancelled')).toBe(true);

      const all = (await authed(app.app, u, 'GET', '/api/orders?status=all')).json() as Wire[];
      expect(all).toHaveLength(3);

      // cursor: limit=1 then page with before=<seq of first>
      const page1 = (await authed(app.app, u, 'GET', '/api/orders?status=all&limit=1')).json() as Wire[];
      expect(page1).toHaveLength(1);
      const cursor = page1[0]!['seq'] as number;
      const page2 = (await authed(app.app, u, 'GET', `/api/orders?status=all&limit=5&before=${cursor}`)).json() as Wire[];
      expect(page2.every((o) => (o['seq'] as number) < cursor)).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe('order validation (engine + zod, exact error codes)', () => {
  const cases: { name: string; body: Record<string, unknown>; status: number; code: string }[] = [
    {
      name: 'off-tick price',
      body: { marketId: M, side: 'buy', type: 'limit', price: '100.005', qty: '0.1', tif: 'GTC' },
      status: 400,
      code: 'TICK_SIZE',
    },
    {
      name: 'off-lot qty',
      body: { marketId: M, side: 'buy', type: 'limit', price: '100', qty: '0.00005', tif: 'GTC' },
      status: 400,
      code: 'LOT_SIZE',
    },
    {
      name: 'below min notional',
      body: { marketId: M, side: 'buy', type: 'limit', price: '0.01', qty: '0.001', tif: 'GTC' },
      status: 400,
      code: 'MIN_NOTIONAL',
    },
    {
      name: 'unknown market',
      body: { marketId: 'NOPE-USDC', side: 'buy', type: 'limit', price: '1', qty: '1', tif: 'GTC' },
      status: 404,
      code: 'MARKET_NOT_FOUND',
    },
    {
      name: 'fiat market no longer exists',
      body: { marketId: 'KRW-BTC', side: 'buy', type: 'limit', price: '1', qty: '1', tif: 'GTC' },
      status: 404,
      code: 'MARKET_NOT_FOUND',
    },
    {
      name: 'market order with GTC',
      body: { marketId: M, side: 'buy', type: 'market', price: '100', qty: '0.1', tif: 'GTC' },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'postOnly market order',
      body: { marketId: M, side: 'buy', type: 'market', price: '100', qty: '0.1', tif: 'IOC', postOnly: true },
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
      body: { marketId: M, side: 'buy', type: 'limit', price: '100', qty: '-1', tif: 'GTC' },
      status: 422,
      code: 'INVALID_ORDER',
    },
    {
      name: 'insufficient balance',
      body: { marketId: M, side: 'sell', type: 'limit', price: '100', qty: '5000', tif: 'GTC' },
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
      price: '100',
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
      price: '100',
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
