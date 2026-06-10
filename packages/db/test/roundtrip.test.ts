import { afterEach, describe, expect, it } from 'vitest';
import { SCALE, type MarketConfig } from '@dex/shared';
import { Projector, createDb, createRepos, type DbHandle } from '../src/index.js';
import { ALICE, PERP, PERP_MARKET, SPOT_MARKET, positionChanged } from './fixtures.js';

let handle: DbHandle | undefined;

async function setup() {
  handle = await createDb();
  return {
    db: handle.db,
    pglite: handle.pglite,
    projector: new Projector(handle.db),
    repos: createRepos(handle.db),
  };
}

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('bigint round-trips through numeric(38,0)', () => {
  it('10n**24n and (10n**24n - 1n) survive exactly', async () => {
    const { projector, repos } = await setup();
    const huge = 10n ** 24n;
    await projector.apply({
      kind: 'balanceChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      asset: 'KRW',
      available: huge,
      locked: huge - 1n,
      reason: 'deposit',
    });
    const [row] = await repos.balances.forUser(ALICE);
    expect(row?.available).toBe(huge);
    expect(row?.locked).toBe(huge - 1n);
    expect(typeof row?.available).toBe('bigint');
  });

  it('zero round-trips exactly (and is not null/undefined)', async () => {
    const { projector, repos } = await setup();
    await projector.apply({
      kind: 'balanceChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      asset: 'USDC',
      available: 0n,
      locked: 0n,
      reason: 'withdraw',
    });
    const [row] = await repos.balances.forUser(ALICE);
    expect(row?.available).toBe(0n);
    expect(row?.locked).toBe(0n);
  });

  it('negative position sizes, huge entry prices and huge exact margins survive exactly', async () => {
    const { projector, repos } = await setup();
    const size = -(10n ** 20n) - 7n;
    const entry = 12_345_678_901_234_567n;
    const margin = 10n ** 21n + 13n; // exact engine margin, persisted verbatim
    await projector.apply(
      positionChanged({
        seq: 1,
        ts: 1,
        userId: ALICE,
        marketId: PERP,
        size,
        entryPrice: entry,
        leverage: 7,
        margin,
        realizedPnl: -42n,
      }),
    );
    const [pos] = await repos.positions.forUser(ALICE);
    expect(pos?.size).toBe(size);
    expect(pos?.entryPrice).toBe(entry);
    expect(pos?.leverage).toBe(7);
    expect(pos?.margin).toBe(margin);
  });

  it('negative funding rates/payments round-trip via raw rows (and hit the margin)', async () => {
    const { projector, repos, pglite } = await setup();
    const margin = 10n ** 20n;
    await projector.apply(
      positionChanged({
        seq: 1,
        ts: 98,
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 50_000n * SCALE,
        leverage: 10,
        margin,
      }),
    );
    await projector.apply({
      kind: 'fundingApplied',
      seq: 2,
      ts: 99,
      marketId: PERP,
      userId: ALICE,
      rate: -10_000n,
      payment: -(10n ** 19n),
      markPrice: 50_000n * SCALE,
    });
    const res = await pglite.query<{ rate: string; payment: string }>(
      'select rate, payment from funding_payments',
    );
    expect(res.rows[0]?.rate).toBe('-10000');
    expect(BigInt(res.rows[0]?.payment ?? '0')).toBe(-(10n ** 19n));
    const [pos] = await repos.positions.forUser(ALICE);
    expect(pos?.margin).toBe(margin - 10n ** 19n);
  });

  it('MarketConfig round-trips exactly, including nulls and 1n tick', async () => {
    const { repos } = await setup();
    const extreme: MarketConfig = {
      id: 'XRP-PERP',
      type: 'perp',
      base: 'XRP',
      quote: 'USDC',
      koreanName: null,
      englishName: null,
      tickSize: 1n,
      lotSize: 1n,
      minNotional: 10n ** 18n,
      makerFeeBps: 2,
      takerFeeBps: 5,
      maxLeverage: 50,
    };
    await repos.markets.upsertAll([SPOT_MARKET, PERP_MARKET, extreme]);
    const listed = await repos.markets.list();
    expect(listed).toEqual([PERP_MARKET, SPOT_MARKET, extreme]); // ordered by id
  });

  it('markets.upsertAll chunks batches > 200 configs and upserts every row across chunk boundaries', async () => {
    const { repos } = await setup();
    const mk = (i: number, maxLeverage: number): MarketConfig => ({
      id: `M${String(i).padStart(3, '0')}-PERP`, // zero-padded → id sort == index sort
      type: 'perp',
      base: `M${String(i).padStart(3, '0')}`,
      quote: 'USDC',
      koreanName: null,
      englishName: null,
      tickSize: SCALE / 10n,
      lotSize: SCALE / 100_000n,
      minNotional: 10n * SCALE,
      makerFeeBps: 2,
      takerFeeBps: 5,
      maxLeverage,
    });

    // 450 configs → 3 chunks (200 + 200 + 50): exercises the CHUNK=200 loop
    const configs = Array.from({ length: 450 }, (_, i) => mk(i, 10));
    await repos.markets.upsertAll(configs);
    let listed = await repos.markets.list();
    expect(listed).toHaveLength(450);
    expect(listed.map((m) => m.id)).toEqual(configs.map((c) => c.id));
    expect(listed.every((m) => m.maxLeverage === 10)).toBe(true);

    // second pass overwrites every row, again across all chunk boundaries
    await repos.markets.upsertAll(Array.from({ length: 450 }, (_, i) => mk(i, 25)));
    listed = await repos.markets.list();
    expect(listed).toHaveLength(450);
    expect(listed.every((m) => m.maxLeverage === 25)).toBe(true);
  });

  it('markets.upsertAll overwrites existing rows (upsert semantics)', async () => {
    const { repos } = await setup();
    await repos.markets.upsertAll([SPOT_MARKET]);
    const changed: MarketConfig = {
      ...SPOT_MARKET,
      tickSize: 500n * SCALE,
      koreanName: '비트코인(변경)',
      maxLeverage: 3,
    };
    await repos.markets.upsertAll([changed]);
    const listed = await repos.markets.list();
    expect(listed).toEqual([changed]);
  });
});
