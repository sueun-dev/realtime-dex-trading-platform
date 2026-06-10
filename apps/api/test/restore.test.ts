import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  TEST_PERP,
  TEST_SPOT,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestUser,
} from './helpers.js';

const dataDir = mkdtempSync(join(tmpdir(), 'dex-restore-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface Wire {
  [k: string]: unknown;
}

describe('durable restart: engine state rebuilt from the PGlite projection', () => {
  it('open orders, balances, positions and locks survive a full restart', async () => {
    // ---- session 1: trade, leave resting state, shut down -------------------
    const t1 = await makeApp({ dataDir });
    let alice: TestUser;
    let bob: TestUser;
    let restingOrderId: string;
    try {
      alice = await loginAndFund(t1.app);
      bob = await loginAndFund(t1.app);
      await t1.svc.pipeline.exec(() =>
        t1.svc.engine.deposit(alice.address, 'TBT', u(10), Date.now()),
      );
      // resting spot ask
      const rest = await placeOrder(t1.app, alice, {
        marketId: TEST_SPOT.id,
        side: 'sell',
        type: 'limit',
        price: '100',
        qty: '0.4',
        tif: 'GTC',
      });
      restingOrderId = (rest.json() as Wire)['id'] as string;
      // open perp position 1 long / 1 short at 100
      await placeOrder(t1.app, alice, {
        marketId: TEST_PERP.id,
        side: 'buy',
        type: 'limit',
        price: '100',
        qty: '1',
        tif: 'GTC',
      });
      await placeOrder(t1.app, bob, {
        marketId: TEST_PERP.id,
        side: 'sell',
        type: 'limit',
        price: '100',
        qty: '1',
        tif: 'GTC',
      });
      await t1.svc.pipeline.exec(() =>
        t1.svc.engine.setMarkPrice(TEST_PERP.id, u(105), Date.now()),
      );
    } finally {
      await t1.stop();
    }

    // ---- session 2: same data dir, fresh process -----------------------------
    const t2 = await makeApp({ dataDir });
    try {
      expect(t2.svc.engine.seq).toBeGreaterThan(0);

      // the resting ask is back in the book with the same id
      const book = (
        await t2.app.inject({ method: 'GET', url: `/api/markets/${TEST_SPOT.id}/orderbook` })
      ).json() as { asks: unknown[] };
      expect(book.asks).toEqual([{ price: '100', qty: '0.4' }]);

      // JWT from session 1 still works (same secret), state identical
      const acct = (await authed(t2.app, alice, 'GET', '/api/account')).json() as Wire;
      const balances = acct['balances'] as { asset: string; available: string; locked: string }[];
      expect(balances.find((b) => b.asset === 'TBT')).toMatchObject({
        available: '9.6',
        locked: '0.4',
      });
      const pos = (acct['positions'] as Wire[]).find((p) => p['marketId'] === TEST_PERP.id);
      expect(pos).toMatchObject({ size: '1', entryPrice: '100', leverage: 1, margin: '100' });

      // restored mark price still drives equity
      expect(t2.svc.engine.getMarkPrice(TEST_PERP.id)).toBe(u(105));

      // open orders endpoint sees the restored order; cancelling it releases
      // EXACTLY the restored lock
      const open = (await authed(t2.app, alice, 'GET', '/api/orders')).json() as Wire[];
      expect(open.map((o) => o['id'])).toEqual([restingOrderId]);
      const cancel = await authed(t2.app, alice, 'DELETE', `/api/orders/${restingOrderId}`);
      expect(cancel.statusCode).toBe(200);
      const after = (await authed(t2.app, alice, 'GET', '/api/account')).json() as Wire;
      const tbt = (after['balances'] as { asset: string; available: string; locked: string }[]).find(
        (b) => b.asset === 'TBT',
      );
      expect(tbt).toMatchObject({ available: '10', locked: '0' });

      // trading continues seamlessly after restore
      const trade = await placeOrder(t2.app, bob, {
        marketId: TEST_PERP.id,
        side: 'buy',
        type: 'limit',
        price: '105',
        qty: '0.5',
        tif: 'GTC',
        reduceOnly: true,
      });
      expect(trade.statusCode).toBe(200);
    } finally {
      await t2.stop();
    }
  });
});
