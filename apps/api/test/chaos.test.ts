/**
 * Failure injection: the server dies and comes back while the real-book
 * mirror and user orders are live. The restored state must reconcile cleanly —
 * stale mirror levels get replaced by the next real snapshot, user orders and
 * locks survive exactly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BookLevel } from '@dex/shared';
import { toUnits } from '@dex/shared';
import { MIRROR_USER, applyMirrorSnapshot } from '../src/bookMirror.js';
import { TEST_SPOT, loginAndFund, makeApp, placeOrder, type TestUser } from './helpers.js';

const M = TEST_SPOT.id;
const dataDir = mkdtempSync(join(tmpdir(), 'dex-chaos-'));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function lvls(...pairs: [string, string][]): BookLevel[] {
  return pairs.map(([p, q]) => ({ price: toUnits(p), qty: toUnits(q) }));
}

describe('kill the server under a live mirror + resting user order', () => {
  it('restores, reconciles the mirror, and keeps user money exact', async () => {
    // ---- session 1 -----------------------------------------------------------
    const t1 = await makeApp({ dataDir });
    let user: TestUser;
    let userOrderId: string;
    try {
      user = await loginAndFund(t1.app);
      const deps = { engine: t1.svc.engine, pipeline: t1.svc.pipeline, log: () => {} };
      await applyMirrorSnapshot(
        deps,
        TEST_SPOT,
        lvls(['9998000', '1.5'], ['9997000', '0.7']),
        lvls(['10002000', '0.9']),
      );
      // user bid inside the real spread
      const res = await placeOrder(t1.app, user, {
        marketId: M,
        side: 'buy',
        type: 'limit',
        price: '10000000',
        qty: '0.001',
        tif: 'GTC',
      });
      expect(res.statusCode).toBe(200);
      userOrderId = (res.json() as { id: string }).id;
    } finally {
      await t1.stop(); // hard stop mid-flight
    }

    // ---- session 2: fresh process, same data dir ------------------------------
    const t2 = await makeApp({ dataDir });
    try {
      const deps2 = { engine: t2.svc.engine, pipeline: t2.svc.pipeline, log: () => {} };

      // everything (mirror levels + user bid) survived the crash
      const restored = (
        await t2.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook?depth=10` })
      ).json() as { bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] };
      expect(restored.bids).toEqual([
        { price: '10000000', qty: '0.001' }, // the user's bid
        { price: '9998000', qty: '1.5' },
        { price: '9997000', qty: '0.7' },
      ]);
      expect(restored.asks).toEqual([{ price: '10002000', qty: '0.9' }]);

      // the next REAL snapshot replaces the stale mirror levels wholesale,
      // but never touches the user's order
      await applyMirrorSnapshot(deps2, TEST_SPOT, lvls(['9999000', '2']), lvls(['10003000', '1.1']));
      const reconciled = (
        await t2.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook?depth=10` })
      ).json() as { bids: { price: string; qty: string }[]; asks: { price: string; qty: string }[] };
      expect(reconciled.bids).toEqual([
        { price: '10000000', qty: '0.001' },
        { price: '9999000', qty: '2' },
      ]);
      expect(reconciled.asks).toEqual([{ price: '10003000', qty: '1.1' }]);

      // mirror's stale orders were cancelled, not orphaned: only the new
      // levels remain under the house account
      const mirrorOrders = t2.svc.engine.getOpenOrders(MIRROR_USER, M);
      expect(mirrorOrders).toHaveLength(2);

      // user cancels the survivor — the exact lock comes back
      const cancel = await t2.app.inject({
        method: 'DELETE',
        url: `/api/orders/${userOrderId}`,
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(cancel.statusCode).toBe(200);
      const acct = (
        await t2.app.inject({
          method: 'GET',
          url: '/api/account',
          headers: { authorization: `Bearer ${user.token}` },
        })
      ).json() as { balances: { asset: string; available: string; locked: string }[] };
      const krw = acct.balances.find((b) => b.asset === 'KRW');
      expect(krw).toMatchObject({ available: '100000000', locked: '0' });
    } finally {
      await t2.stop();
    }
  }, 30_000);
});
