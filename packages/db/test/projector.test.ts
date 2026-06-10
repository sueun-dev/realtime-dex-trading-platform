import { afterEach, describe, expect, it } from 'vitest';
import { SCALE, type EngineEvent, type PositionChangedEvent } from '@dex/shared';
import { Projector, createDb, createRepos, type DbHandle } from '../src/index.js';
import {
  ALICE,
  ALICE_PERP_FINAL_MARGIN,
  BOB,
  PERP,
  SPOT,
  buildStream,
  dumpAll,
  mkOrder,
  positionChanged,
} from './fixtures.js';

const handles: DbHandle[] = [];

async function freshDb(): Promise<DbHandle> {
  const h = await createDb();
  handles.push(h);
  return h;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

describe('projector', () => {
  it('consumes the full synthetic stream and projects every event kind', async () => {
    const events = buildStream();
    expect(events.length).toBeGreaterThanOrEqual(200);
    // every kind is present in the stream
    const kinds = new Set(events.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      'balanceChanged',
      'fundingApplied',
      'liquidation',
      'markPrice',
      'orderAccepted',
      'orderCancelled',
      'orderRejected',
      'positionChanged',
      'trade',
    ]);
    // seq is contiguous 1..N (slices map onto seq windows)
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));

    const { db, pglite } = await freshDb();
    const projector = new Projector(db);
    await projector.applyBatch(events);
    const repos = createRepos(db);

    // meta cursor
    const state = await repos.loadRestoreState();
    expect(state.lastSeq).toBe(events.length);

    // mark prices projected to meta (latest value wins)
    expect(state.markPrices).toEqual([
      { marketId: PERP, price: 53_000n * SCALE },
      { marketId: SPOT, price: 93_037_000n * SCALE },
    ]);

    // trades: 38 spot full fills + 1 partial + 1 perp
    const tradeCount = await pglite.query<{ n: number }>(
      'select count(*)::int4 as n from trades',
    );
    expect(tradeCount.rows[0]?.n).toBe(40);

    // orders: a filled maker order carries its post-fill state
    const o7 = await repos.orders.byId('o7');
    expect(o7?.status).toBe('filled');
    expect(o7?.filledQty).toBe(SCALE / 100n);

    // cancelled order
    const cancelled = events.find((e) => e.kind === 'orderCancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.kind === 'orderCancelled') {
      const row = await repos.orders.byId(cancelled.orderId);
      expect(row?.status).toBe('cancelled');
    }

    // partially-filled maker remains open with its fill recorded
    const open = await repos.orders.openAllAscSeq();
    const partial = open.find((o) => o.filledQty > 0n);
    expect(partial).toBeDefined();
    expect(partial?.filledQty).toBe(SCALE / 100n);
    expect(partial?.qty).toBe(SCALE / 50n);

    // balances are absolute (last write wins)
    const aliceBalances = await repos.balances.forUser(ALICE);
    const aliceKrw = aliceBalances.find((b) => b.asset === 'KRW');
    expect(aliceKrw).toBeDefined();
    // 38 buys of 0.01 BTC each at 93_000_000 + i*1000 KRW + maker fee 5bps
    let expectedKrw = 100_000_000n * SCALE;
    for (let i = 0; i < 38; i++) {
      const price = (93_000_000n + BigInt(i) * 1000n) * SCALE;
      const notional = (price * (SCALE / 100n)) / SCALE;
      expectedKrw -= notional + (notional * 5n + 9999n) / 10_000n;
    }
    expect(aliceKrw?.available).toBe(expectedKrw);

    // positions: alice long row upserted with VWAP entry; margin is the
    // event's EXACT engine margin, verbatim (≠ |size|*entry/SCALE/leverage)
    const alicePos = await repos.positions.forUser(ALICE);
    expect(alicePos).toEqual([
      {
        userId: ALICE,
        marketId: PERP,
        size: 2n * SCALE,
        entryPrice: 51_000n * SCALE,
        leverage: 10,
        margin: ALICE_PERP_FINAL_MARGIN,
      },
    ]);
    expect(ALICE_PERP_FINAL_MARGIN).not.toBe((2n * SCALE * (51_000n * SCALE)) / SCALE / 10n);

    // bob's short was closed to size 0 -> row DELETED
    expect(await repos.positions.forUser(BOB)).toEqual([]);

    // funding + liquidation rows landed
    const funding = await pglite.query<{ n: number }>(
      'select count(*)::int4 as n from funding_payments',
    );
    expect(funding.rows[0]?.n).toBe(2);
    const liq = await pglite.query<{ user_id: string; size: string; mark_price: string }>(
      'select user_id, size, mark_price from liquidations',
    );
    expect(liq.rows).toEqual([
      { user_id: BOB, size: (-SCALE).toString(), mark_price: (53_000n * SCALE).toString() },
    ]);
  });

  it('replaying the exact same batch changes nothing (full dump compare)', async () => {
    const events = buildStream();
    const { db, pglite } = await freshDb();
    const projector = new Projector(db);

    await projector.applyBatch(events);
    const before = await dumpAll(pglite);

    await projector.applyBatch(events); // exact replay
    const afterOnce = await dumpAll(pglite);
    expect(afterOnce).toEqual(before);

    // and replaying one-by-one through apply() is also a no-op
    for (const e of events.slice(0, 25)) await projector.apply(e);
    const afterSingles = await dumpAll(pglite);
    expect(afterSingles).toEqual(before);
  });

  it('overlapping replay windows [0..120) then [100..200+) match a clean full apply', async () => {
    const events = buildStream();
    const a = await freshDb();
    const b = await freshDb();

    // a: single clean pass
    await new Projector(a.db).applyBatch(events);

    // b: overlapping windows — seqs 101..120 are delivered twice
    const pb = new Projector(b.db);
    await pb.applyBatch(events.slice(0, 120));
    await pb.applyBatch(events.slice(100));

    expect(await dumpAll(b.pglite)).toEqual(await dumpAll(a.pglite));
  });

  it('orderRejected is a strict no-op on every table', async () => {
    const { db, pglite } = await freshDb();
    const projector = new Projector(db);
    const events = buildStream();
    const rejectIdx = events.findIndex((e) => e.kind === 'orderRejected');
    expect(rejectIdx).toBeGreaterThan(0);

    await projector.applyBatch(events.slice(0, rejectIdx));
    const before = await dumpAll(pglite);
    const rejected = events[rejectIdx];
    expect(rejected).toBeDefined();
    await projector.apply(rejected!);
    const after = await dumpAll(pglite);

    // only the seq cursor moved — every other row identical
    expect(after['meta']).not.toEqual(before['meta']);
    const stripCursor = (d: Record<string, unknown[]>) => ({ ...d, meta: undefined });
    expect(stripCursor(after)).toEqual(stripCursor(before));
  });

  it('positionChanged with size 0 deletes the row; reopening re-creates it', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    await projector.apply(
      positionChanged({
        seq: 1,
        ts: 1,
        userId: ALICE,
        marketId: PERP,
        size: -3n * SCALE,
        entryPrice: 40_000n * SCALE,
        leverage: 5,
        margin: 23_988n * SCALE + 5n,
      }),
    );
    expect((await repos.positions.all()).length).toBe(1);

    await projector.apply(
      positionChanged({
        seq: 2,
        ts: 2,
        userId: ALICE,
        marketId: PERP,
        size: 0n,
        entryPrice: 0n,
        leverage: 5,
        margin: 0n,
        realizedPnl: 100n,
      }),
    );
    expect(await repos.positions.all()).toEqual([]);

    await projector.apply(
      positionChanged({
        seq: 3,
        ts: 3,
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 41_000n * SCALE,
        leverage: 5,
        margin: 8_191n * SCALE,
      }),
    );
    const reopened = await repos.positions.forUser(ALICE);
    expect(reopened.length).toBe(1);
    expect(reopened[0]?.size).toBe(SCALE);
    expect(reopened[0]?.margin).toBe(8_191n * SCALE); // verbatim
  });

  it('funding payments erode the projected margin exactly and survive a restore', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);
    const margin = 5_000n * SCALE;

    await projector.applyBatch([
      positionChanged({
        seq: 1,
        ts: 1,
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 50_000n * SCALE,
        leverage: 10,
        margin,
      }),
      {
        kind: 'fundingApplied',
        seq: 2,
        ts: 2,
        marketId: PERP,
        userId: ALICE,
        rate: 10_000n,
        payment: -7n * SCALE - 3n, // long pays
        markPrice: 50_000n * SCALE,
      },
      {
        kind: 'fundingApplied',
        seq: 3,
        ts: 3,
        marketId: PERP,
        userId: ALICE,
        rate: -2_000n,
        payment: 1n * SCALE + 1n, // next hour: long receives
        markPrice: 49_900n * SCALE,
      },
    ]);

    const expected = margin - 7n * SCALE - 3n + 1n * SCALE + 1n;
    const [pos] = await repos.positions.forUser(ALICE);
    expect(pos?.margin).toBe(expected);

    // restore feeds the funding-eroded margin verbatim — no snap-back
    const state = await repos.loadRestoreState();
    expect(state.positions).toEqual([
      {
        userId: ALICE,
        marketId: PERP,
        size: SCALE,
        entryPrice: 50_000n * SCALE,
        leverage: 10,
        margin: expected,
      },
    ]);
  });

  it('accepts a legacy margin-less positionChanged — persists NULL margin, never an approximation', async () => {
    const { db, pglite } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    // exactly the published @dex/shared shape — no `margin` field
    // legacy pre-addendum shape (margin was added to the published contract
    // later) — intentionally omits `margin`, hence the cast
    const contractOnly = {
      kind: 'positionChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      marketId: PERP,
      size: SCALE,
      entryPrice: 50_000n * SCALE,
      leverage: 10,
      realizedPnl: 0n,
    } as unknown as PositionChangedEvent;
    // MUST NOT throw: the projector may never reject a legacy stream
    await projector.apply(contractOnly);

    // raw row: margin is NULL ("engine never reported it"), NOT the IM formula
    const raw = await pglite.query<{ size: string; margin: string | null }>(
      'select size, margin from positions',
    );
    expect(raw.rows).toEqual([{ size: SCALE.toString(), margin: null }]);

    // cursor advanced — the event was applied, not dropped
    const seqRow = await pglite.query<{ value: string }>(
      `select value from meta where key = 'last_applied_seq'`,
    );
    expect(seqRow.rows[0]?.value).toBe('1');

    // reads that must produce an EXACT shared Position fail loudly instead
    // of fabricating a margin (restore would corrupt money state)
    await expect(repos.positions.forUser(ALICE)).rejects.toThrow(/unknown isolated margin/);
    await expect(repos.positions.all()).rejects.toThrow(/unknown isolated margin/);
    await expect(repos.loadRestoreState()).rejects.toThrow(/unknown isolated margin/);
  });

  it('a later positionChanged carrying the exact engine margin heals an unknown-margin row', async () => {
    const { db, pglite } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    // legacy pre-addendum shape (margin was added to the published contract
    // later) — intentionally omits `margin`, hence the cast
    const contractOnly = {
      kind: 'positionChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      marketId: PERP,
      size: SCALE,
      entryPrice: 50_000n * SCALE,
      leverage: 10,
      realizedPnl: 0n,
    } as unknown as PositionChangedEvent;
    await projector.apply(contractOnly);

    const exact = 4_991n * SCALE + 7n; // ≠ IM formula — must land verbatim
    await projector.apply(
      positionChanged({
        seq: 2,
        ts: 2,
        userId: ALICE,
        marketId: PERP,
        size: 2n * SCALE,
        entryPrice: 50_500n * SCALE,
        leverage: 10,
        margin: exact,
      }),
    );
    const [pos] = await repos.positions.forUser(ALICE);
    expect(pos?.margin).toBe(exact);
    expect((await repos.loadRestoreState()).positions[0]?.margin).toBe(exact);

    // and the reverse: a legacy margin-less update makes the margin unknown
    // again (the old exact margin is stale after a size/entry change —
    // keeping it WOULD be an approximation)
    await projector.apply({ ...contractOnly, seq: 3, ts: 3, size: 3n * SCALE });
    const raw = await pglite.query<{ margin: string | null }>('select margin from positions');
    expect(raw.rows).toEqual([{ margin: null }]);
  });

  it('funding on an unknown-margin position records the payment and keeps margin unknown (NULL)', async () => {
    const { db, pglite } = await freshDb();
    const projector = new Projector(db);

    // legacy pre-addendum shape (margin was added to the published contract
    // later) — intentionally omits `margin`, hence the cast
    const contractOnly = {
      kind: 'positionChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      marketId: PERP,
      size: SCALE,
      entryPrice: 50_000n * SCALE,
      leverage: 10,
      realizedPnl: 0n,
    } as unknown as PositionChangedEvent;
    await projector.applyBatch([
      contractOnly,
      {
        kind: 'fundingApplied',
        seq: 2,
        ts: 2,
        marketId: PERP,
        userId: ALICE,
        rate: 10_000n,
        payment: -5n * SCALE,
        markPrice: 50_000n * SCALE,
      },
    ]);

    // payment history is fully projected
    const fp = await pglite.query<{ payment: string }>('select payment from funding_payments');
    expect(fp.rows).toEqual([{ payment: (-5n * SCALE).toString() }]);
    // unknown + delta = unknown — never a fabricated number
    const pos = await pglite.query<{ margin: string | null }>('select margin from positions');
    expect(pos.rows).toEqual([{ margin: null }]);
  });

  it('rejects a malformed (non-bigint) margin and rolls the batch back', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    const corrupted = {
      kind: 'positionChanged',
      seq: 1,
      ts: 1,
      userId: ALICE,
      marketId: PERP,
      size: SCALE,
      entryPrice: 50_000n * SCALE,
      leverage: 10,
      realizedPnl: 0n,
      margin: 4990.00000003, // a float that already lost precision
    } as unknown as PositionChangedEvent;
    await expect(projector.apply(corrupted)).rejects.toThrow(/malformed margin/);
    // transaction rolled back: nothing persisted, cursor unmoved
    expect(await repos.positions.all()).toEqual([]);
    expect((await repos.loadRestoreState()).lastSeq).toBe(0);
  });

  it('throws on out-of-order new events within a batch and rolls the batch back', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    const bal = (seq: number, available: bigint) =>
      ({
        kind: 'balanceChanged',
        seq,
        ts: seq,
        userId: ALICE,
        asset: 'KRW',
        available,
        locked: 0n,
        reason: 'deposit',
      }) as const;

    await expect(projector.applyBatch([bal(5, 5n), bal(3, 3n), bal(7, 7n)])).rejects.toThrow(
      /out-of-order/,
    );
    // all-or-nothing: seq 5 must not have been half-applied
    expect(await repos.balances.forUser(ALICE)).toEqual([]);
    expect((await repos.loadRestoreState()).lastSeq).toBe(0);

    // a well-ordered batch still works afterwards
    await projector.applyBatch([bal(3, 3n), bal(5, 5n), bal(7, 7n)]);
    expect(await repos.balances.forUser(ALICE)).toEqual([
      { asset: 'KRW', available: 7n, locked: 0n },
    ]);
  });

  it('orderCancelled for an unknown order throws (corrupted stream made loud)', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    await expect(
      projector.apply({
        kind: 'orderCancelled',
        seq: 1,
        ts: 1,
        orderId: 'o-never-accepted',
        userId: ALICE,
        marketId: SPOT,
        remainingQty: SCALE,
        reason: 'user',
      }),
    ).rejects.toThrow(/not found in projection/);
  });

  it('a duplicate trade id above the watermark throws (corrupted stream made loud) and rolls back', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    const price = 90n * SCALE;
    const maker = mkOrder({
      id: 'm1',
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price,
      qty: SCALE,
      seq: 1,
      ts: 1,
    });
    const taker = mkOrder({
      id: 'k1',
      userId: BOB,
      marketId: SPOT,
      side: 'sell',
      price,
      qty: SCALE,
      seq: 2,
      ts: 2,
      tif: 'IOC',
    });
    const tradeEvent = (id: string, seq: number): EngineEvent => ({
      kind: 'trade',
      seq,
      ts: seq,
      trade: {
        id,
        marketId: SPOT,
        price,
        qty: SCALE / 2n,
        takerSide: 'sell',
        makerOrderId: maker.id,
        takerOrderId: taker.id,
        makerUserId: ALICE,
        takerUserId: BOB,
        makerFee: 1n,
        takerFee: 2n,
        seq,
        ts: seq,
      },
      makerOrder: { ...maker, filledQty: SCALE / 2n, status: 'open' },
      takerOrder: { ...taker, filledQty: SCALE / 2n, status: 'open' },
    });

    await projector.applyBatch([
      { kind: 'orderAccepted', seq: 1, ts: 1, order: maker },
      { kind: 'orderAccepted', seq: 2, ts: 2, order: taker },
      tradeEvent('t-dup', 3),
    ]);

    // same trade id at a NEW seq — above the watermark, so NOT a replay:
    // this is stream corruption and must not be silently swallowed
    await expect(projector.apply(tradeEvent('t-dup', 4))).rejects.toThrow(/duplicate trade id/);
    // batch rolled back: cursor unmoved
    expect((await repos.loadRestoreState()).lastSeq).toBe(3);
  });

  it('a duplicate order id above the watermark throws (corrupted stream made loud) and rolls back', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    const o = mkOrder({
      id: 'o-dup',
      userId: ALICE,
      marketId: SPOT,
      side: 'buy',
      price: 90n * SCALE,
      qty: SCALE,
      seq: 1,
      ts: 1,
    });
    await projector.apply({ kind: 'orderAccepted', seq: 1, ts: 1, order: o });

    // a second accept of the same order id above the watermark is corruption
    // (the engine emits orderAccepted exactly once per order id)
    await expect(
      projector.apply({ kind: 'orderAccepted', seq: 2, ts: 2, order: { ...o, seq: 2, ts: 2 } }),
    ).rejects.toThrow(/duplicate order id/);
    expect((await repos.loadRestoreState()).lastSeq).toBe(1);
  });

  it('fundingApplied without a projected position throws (corrupted stream made loud)', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    await expect(
      projector.apply({
        kind: 'fundingApplied',
        seq: 1,
        ts: 1,
        marketId: PERP,
        userId: ALICE,
        rate: 10_000n,
        payment: -5n * SCALE,
        markPrice: 50_000n * SCALE,
      }),
    ).rejects.toThrow(/no open position/);
  });

  it('events at or below the cursor are skipped even as singles', async () => {
    const { db } = await freshDb();
    const projector = new Projector(db);
    const repos = createRepos(db);

    await projector.apply({
      kind: 'balanceChanged',
      seq: 10,
      ts: 10,
      userId: ALICE,
      asset: 'KRW',
      available: 5n * SCALE,
      locked: 0n,
      reason: 'deposit',
    });
    // stale event (seq 9) must NOT overwrite the newer absolute value
    await projector.apply({
      kind: 'balanceChanged',
      seq: 9,
      ts: 9,
      userId: ALICE,
      asset: 'KRW',
      available: 1n * SCALE,
      locked: 0n,
      reason: 'deposit',
    });
    const balances = await repos.balances.forUser(ALICE);
    expect(balances).toEqual([{ asset: 'KRW', available: 5n * SCALE, locked: 0n }]);
    expect((await repos.loadRestoreState()).lastSeq).toBe(10);
  });
});
