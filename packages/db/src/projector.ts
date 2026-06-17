/**
 * Write-behind projector: applies engine events to the relational projection.
 *
 * Idempotency: meta.last_applied_seq records the highest applied event seq.
 * Events with seq <= last_applied_seq are skipped, so replaying any prefix /
 * overlapping window of the event stream is a no-op for already-applied
 * events. Within the new (not-yet-applied) portion of a batch, seqs MUST be
 * strictly ascending — a descending/duplicate seq within the new portion
 * indicates a corrupted stream and throws (the whole batch rolls back).
 * Likewise, a duplicate trade id or order id WITHIN the new portion (a row
 * that already exists even though the event's seq is above the watermark)
 * is stream corruption and throws — it is never silently swallowed.
 * applyBatch runs inside a single transaction (all-or-nothing).
 *
 * Concurrency: the watermark read takes a SELECT ... FOR UPDATE row lock on
 * meta.last_applied_seq (the row is seeded by migrations so it always
 * exists), so concurrent applyBatch transactions serialize on the lock even
 * on a multi-connection / pooled Postgres under READ COMMITTED — the
 * read-modify-write of the watermark (and the funding margin mirror behind
 * it) cannot double-apply. On PGlite (single connection) the lock is free.
 *
 * Seq GAPS are NOT detectable here: ARCHITECTURE.md only guarantees that the
 * engine's seq is monotonically increasing, not contiguous, so a batch that
 * starts above the watermark cannot be distinguished from a legitimately
 * sparse stream. The delivery layer (the api package feeding this projector)
 * is therefore responsible for lossless, in-order delivery of every emitted
 * event — a dropped delivery window silently loses the dropped rows.
 *
 * Exact-margin handling (money-path correctness): the engine's isolated
 * `position.margin` CANNOT be re-derived from size/entry/leverage — it
 * diverges by fill fees taken from the released lock, funding payments
 * applied directly to margin, and PnL/rounding on partial reduces. So
 * `PositionChangedEvent` carries the engine's EXACT margin (`margin: bigint`),
 * persisted verbatim for full boot-restore fidelity. Funding payments are
 * mirrored onto the projected margin so it stays exact between position
 * changes.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  BalanceChangedEvent,
  EngineEvent,
  FundingAppliedEvent,
  LiquidationEvent,
  MarkPriceEvent,
  Order,
  OrderCancelledEvent,
  PositionChangedEvent,
  TradeEvent,
} from '@dex/shared';
import type { Db, DbExecutor } from './client.js';
import * as s from './schema.js';

export const LAST_APPLIED_SEQ_KEY = 'last_applied_seq';
export const MARK_PRICE_KEY_PREFIX = 'mark:';


async function readLastAppliedSeq(ex: DbExecutor): Promise<number> {
  // FOR UPDATE: serializes concurrent applyBatch transactions on the
  // watermark row (seeded by migrations, so it always exists to be locked).
  // Without it the read-modify-write below would race under READ COMMITTED
  // on a multi-connection Postgres and double-apply events.
  const rows = await ex
    .select({ value: s.meta.value })
    .from(s.meta)
    .where(eq(s.meta.key, LAST_APPLIED_SEQ_KEY))
    .for('update');
  const value = rows[0]?.value;
  return value === undefined ? 0 : Number(value);
}

async function writeLastAppliedSeq(ex: DbExecutor, seq: number): Promise<void> {
  await ex
    .insert(s.meta)
    .values({ key: LAST_APPLIED_SEQ_KEY, value: String(seq) })
    .onConflictDoUpdate({ target: s.meta.key, set: { value: String(seq) } });
}

function orderRow(o: Order): typeof s.orders.$inferInsert {
  return {
    id: o.id,
    userId: o.userId,
    marketId: o.marketId,
    side: o.side,
    type: o.type,
    price: o.price,
    qty: o.qty,
    filledQty: o.filledQty,
    status: o.status,
    tif: o.tif,
    postOnly: o.postOnly,
    reduceOnly: o.reduceOnly,
    clientOrderId: o.clientOrderId,
    triggerPrice: o.trigger ? o.trigger.price : null,
    triggerDirection: o.trigger ? o.trigger.direction : null,
    seq: o.seq,
    ts: o.ts,
  };
}

/** Insert-or-overwrite an order row with its latest engine state. */
async function upsertOrder(ex: DbExecutor, o: Order): Promise<void> {
  const row = orderRow(o);
  await ex
    .insert(s.orders)
    .values(row)
    .onConflictDoUpdate({
      target: s.orders.id,
      set: {
        price: row.price,
        qty: row.qty,
        filledQty: row.filledQty,
        status: row.status,
        clientOrderId: row.clientOrderId,
      },
    });
}

async function applyTrade(ex: DbExecutor, e: TradeEvent): Promise<void> {
  const t = e.trade;
  // Replay of an already-applied trade is filtered by the seq watermark
  // before we get here, so a conflicting trade id WITHIN the new portion of
  // a batch can only mean a corrupted stream (the engine never reuses trade
  // ids) — fail loudly instead of silently swallowing the row.
  const inserted = await ex
    .insert(s.trades)
    .values({
      id: t.id,
      marketId: t.marketId,
      price: t.price,
      qty: t.qty,
      takerSide: t.takerSide,
      makerOrderId: t.makerOrderId,
      takerOrderId: t.takerOrderId,
      makerUserId: t.makerUserId,
      takerUserId: t.takerUserId,
      makerFee: t.makerFee,
      takerFee: t.takerFee,
      seq: t.seq,
      ts: t.ts,
    })
    .onConflictDoNothing()
    .returning({ id: s.trades.id });
  if (inserted.length === 0) {
    throw new Error(
      `trade seq=${e.seq}: duplicate trade id ${t.id} above the applied watermark (corrupted event stream)`,
    );
  }
  await upsertOrder(ex, e.makerOrder);
  await upsertOrder(ex, e.takerOrder);
}

async function applyOrderCancelled(ex: DbExecutor, e: OrderCancelledEvent): Promise<void> {
  // The engine always emits orderAccepted before any cancel, so the row must
  // exist; a missing row means a corrupted/partial stream — fail loudly.
  const updated = await ex
    .update(s.orders)
    .set({ status: 'cancelled' })
    .where(eq(s.orders.id, e.orderId))
    .returning({ id: s.orders.id });
  if (updated.length === 0) {
    throw new Error(
      `orderCancelled seq=${e.seq}: order ${e.orderId} not found in projection (corrupted or partial event stream)`,
    );
  }
}

async function applyBalanceChanged(ex: DbExecutor, e: BalanceChangedEvent): Promise<void> {
  await ex
    .insert(s.balances)
    .values({ userId: e.userId, asset: e.asset, available: e.available, locked: e.locked })
    .onConflictDoUpdate({
      target: [s.balances.userId, s.balances.asset],
      set: { available: e.available, locked: e.locked },
    });
}

async function applyPositionChanged(ex: DbExecutor, e: PositionChangedEvent): Promise<void> {
  if (e.size === 0n) {
    await ex
      .delete(s.positions)
      .where(and(eq(s.positions.userId, e.userId), eq(s.positions.marketId, e.marketId)));
    return;
  }
  await ex
    .insert(s.positions)
    .values({
      userId: e.userId,
      marketId: e.marketId,
      size: e.size,
      entryPrice: e.entryPrice,
      leverage: e.leverage,
      margin: e.margin, // engine's exact isolated margin, verbatim
    })
    .onConflictDoUpdate({
      target: [s.positions.userId, s.positions.marketId],
      set: { size: e.size, entryPrice: e.entryPrice, leverage: e.leverage, margin: e.margin },
    });
}

async function applyLiquidation(ex: DbExecutor, e: LiquidationEvent): Promise<void> {
  await ex.insert(s.liquidations).values({
    userId: e.userId,
    marketId: e.marketId,
    size: e.size,
    markPrice: e.markPrice,
    seq: e.seq,
    ts: e.ts,
  });
}

async function applyFunding(ex: DbExecutor, e: FundingAppliedEvent): Promise<void> {
  await ex.insert(s.fundingPayments).values({
    marketId: e.marketId,
    userId: e.userId,
    rate: e.rate,
    payment: e.payment,
    markPrice: e.markPrice,
    seq: e.seq,
    ts: e.ts,
  });
  // Funding is applied directly to the position's isolated margin
  // (ARCHITECTURE.md "Funding": eroded margin can trigger liquidation).
  // Mirror it onto the projection so a funding-eroded margin survives a boot
  // restore exactly instead of snapping back to its last positionChanged
  // value.
  // fundingApplied is emitted per position holder, so the row must exist — a
  // missing row means a corrupted/partial stream. NOTE for the engine
  // (cross-package assumption): the per-market funding rounding remainder
  // absorbed by FEE_ACCOUNT (ARCHITECTURE.md) must be emitted as a
  // `balanceChanged` event, NOT as a `fundingApplied` for an account with no
  // position — the latter is rejected here as corruption.
  const updated = await ex
    .update(s.positions)
    .set({ margin: sql`${s.positions.margin} + ${e.payment.toString()}::numeric` })
    .where(and(eq(s.positions.userId, e.userId), eq(s.positions.marketId, e.marketId)))
    .returning({ userId: s.positions.userId });
  if (updated.length === 0) {
    throw new Error(
      `fundingApplied seq=${e.seq}: no open position for ${e.userId} on ${e.marketId} (corrupted or partial event stream)`,
    );
  }
}

async function applyMarkPrice(ex: DbExecutor, e: MarkPriceEvent): Promise<void> {
  const key = MARK_PRICE_KEY_PREFIX + e.marketId;
  const value = e.price.toString();
  await ex
    .insert(s.meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: s.meta.key, set: { value } });
}

async function applyEvent(ex: DbExecutor, e: EngineEvent): Promise<void> {
  switch (e.kind) {
    case 'orderAccepted': {
      // The engine emits orderAccepted exactly once per order id, before any
      // trade/cancel referencing it, and a restore never re-emits events —
      // so an existing row for an above-watermark accept is stream
      // corruption, not a replay (replays are filtered by seq). Fail loudly.
      const inserted = await ex
        .insert(s.orders)
        .values(orderRow(e.order))
        .onConflictDoNothing()
        .returning({ id: s.orders.id });
      if (inserted.length === 0) {
        throw new Error(
          `orderAccepted seq=${e.seq}: duplicate order id ${e.order.id} above the applied watermark (corrupted event stream)`,
        );
      }
      return;
    }
    case 'trade':
      await applyTrade(ex, e);
      return;
    case 'orderCancelled':
      await applyOrderCancelled(ex, e);
      return;
    case 'balanceChanged':
      await applyBalanceChanged(ex, e);
      return;
    case 'positionChanged':
      await applyPositionChanged(ex, e);
      return;
    case 'liquidation':
      await applyLiquidation(ex, e);
      return;
    case 'fundingApplied':
      await applyFunding(ex, e);
      return;
    case 'markPrice':
      await applyMarkPrice(ex, e);
      return;
    case 'orderRejected':
      // Rejections are never persisted (nothing changed in the engine).
      return;
    default: {
      // Compile-time exhaustiveness: a new EngineEvent kind added to
      // @dex/shared fails typecheck here instead of being silently dropped.
      const unhandled: never = e;
      throw new Error(`unhandled engine event: ${JSON.stringify(unhandled)}`);
    }
  }
}

export class Projector {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Apply a single event (idempotent; own transaction). */
  async apply(e: EngineEvent): Promise<void> {
    await this.applyBatch([e]);
  }

  /**
   * Apply a batch of events in one transaction. Events whose seq has already
   * been applied are skipped, making replays and overlapping windows safe.
   * New events must arrive in strictly ascending seq order (the engine emits
   * them that way); a descending or duplicate seq within the new portion is
   * stream corruption and throws, rolling the whole batch back.
   *
   * GAPS above the watermark are accepted, not detected: the contract only
   * guarantees monotonically increasing (not contiguous) seqs, so this layer
   * cannot tell a dropped delivery window from a sparse stream. The caller
   * MUST deliver every emitted event exactly in order (losslessly) — events
   * skipped by the delivery layer are permanently missing from the
   * projection.
   */
  async applyBatch(events: EngineEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.#db.transaction(async (tx) => {
      const last = await readLastAppliedSeq(tx);
      let cursor = last;
      for (const e of events) {
        if (e.seq <= last) continue; // already applied — idempotent replay/overlap
        if (e.seq <= cursor) {
          throw new Error(
            `out-of-order event stream: seq ${e.seq} (${e.kind}) after seq ${cursor} — batch must be ascending`,
          );
        }
        await applyEvent(tx, e);
        cursor = e.seq;
      }
      if (cursor > last) await writeLastAppliedSeq(tx, cursor);
    });
  }
}
