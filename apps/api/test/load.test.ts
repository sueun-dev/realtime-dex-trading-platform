/**
 * Load: a burst of concurrent orders must all be processed without a single
 * 5xx, leave the book uncrossed, conserve every unit of money, and credit the
 * fee account with EXACTLY the sum of per-trade fees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FEE_ACCOUNT, toUnits } from '@dex/shared';
import {
  TEST_SPOT,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_SPOT.id;
const N = 150; // orders per side, fired concurrently

let t: TestApp;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  t = await makeApp();
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
  await t.svc.pipeline.exec(() => t.svc.engine.deposit(alice.address, 'TBT', u(10), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe(`${N * 2} concurrent orders`, () => {
  it('processes the burst with zero 5xx and consistent money', async () => {
    const started = Date.now();
    // 150 asks laddered upward + 150 bids laddered into them, all in flight at once
    const requests = [
      ...Array.from({ length: N }, (_, i) =>
        placeOrder(t.app, alice, {
          marketId: M,
          side: 'sell',
          type: 'limit',
          price: ((10_000 + (i % 50)) / 100).toFixed(2), // 100.00 .. 100.49 (tick 0.01)
          qty: '0.02',
          tif: 'GTC',
        }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        placeOrder(t.app, bob, {
          marketId: M,
          side: 'buy',
          type: 'limit',
          price: ((10_000 + (i % 30)) / 100).toFixed(2), // 100.00 .. 100.29
          qty: '0.02',
          tif: 'GTC',
        }),
      ),
    ];
    const responses = await Promise.all(requests);
    const elapsed = Date.now() - started;

    for (const r of responses) {
      expect(r.statusCode).toBe(200); // valid orders only — anything else is a bug
    }
    // throughput sanity: 300 full order→persist→broadcast cycles
    expect(elapsed).toBeLessThan(15_000);

    // book never crossed after the dust settles
    const book = (
      await t.app.inject({ method: 'GET', url: `/api/markets/${M}/orderbook?depth=50` })
    ).json() as { bids: { price: string }[]; asks: { price: string }[] };
    if (book.bids.length > 0 && book.asks.length > 0) {
      expect(toUnits(book.bids[0]!.price) < toUnits(book.asks[0]!.price)).toBe(true);
    }

    // EXACT conservation: per asset, Σ(available+locked) over every account
    // (incl. fee/clearing) equals what was deposited
    const totals = new Map<string, bigint>();
    for (const row of t.svc.engine.getAllBalances()) {
      totals.set(row.asset, (totals.get(row.asset) ?? 0n) + row.available + row.locked);
    }
    expect(totals.get('USDC')).toBe(u(200_000)); // 2 faucets, single USDC collateral
    expect(totals.get('TBT')).toBe(u(10));
    expect(totals.has('KRW')).toBe(false); // no fiat on the exchange

    // fee account holds EXACTLY the sum of all per-trade fees ever charged
    const feeRow = t.svc.engine
      .getBalances(FEE_ACCOUNT)
      .find((b) => b.asset === 'USDC');
    const dbSum = await t.svc.db.pglite.query<{ total: string | null }>(
      'select sum(maker_fee + taker_fee) as total from trades',
    );
    expect(feeRow?.available ?? 0n).toBe(BigInt(dbSum.rows[0]?.total ?? '0'));

    // and the DB projection caught up to the engine exactly
    await t.svc.pipeline.drain();
    const seqRow = await t.svc.db.pglite.query<{ value: string }>(
      `select value from meta where key = 'last_applied_seq'`,
    );
    expect(Number(seqRow.rows[0]?.value)).toBe(t.svc.engine.seq);
  }, 30_000);

  it('survives a concurrent cancel storm without leaking locks', async () => {
    const open = (
      await t.app.inject({
        method: 'GET',
        url: '/api/orders',
        headers: { authorization: `Bearer ${alice.token}` },
      })
    ).json() as { id: string }[];
    // cancel everything alice has open, all at once, plus double-cancels
    const targets = open.map((o) => o.id);
    const results = await Promise.all(
      [...targets, ...targets].map((id) =>
        t.app.inject({
          method: 'DELETE',
          url: `/api/orders/${id}`,
          headers: { authorization: `Bearer ${alice.token}` },
        }),
      ),
    );
    for (const r of results) expect([200, 404]).toContain(r.statusCode);

    // every lock alice held for those orders is released exactly
    const acct = (
      await t.app.inject({
        method: 'GET',
        url: '/api/account',
        headers: { authorization: `Bearer ${alice.token}` },
      })
    ).json() as { balances: { asset: string; locked: string }[] };
    for (const b of acct.balances) expect(b.locked).toBe('0');
  }, 30_000);
});
