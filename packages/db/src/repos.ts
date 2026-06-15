/**
 * Repository layer. All boundaries accept/return bigint for money values —
 * the numeric(38,0) <-> bigint conversion happens in the drizzle column
 * mapping (String()/BigInt()), never via JS floats. All queries are built by
 * drizzle and fully parameterized.
 */
import { and, asc, desc, eq, isNull, like, lt, lte, or, sql } from 'drizzle-orm';
import type {
  Balance,
  Candle,
  CandleInterval,
  MarketConfig,
  Order,
  Position,
  Trade,
} from '@dex/shared';
import type { Db } from './client.js';
import { LAST_APPLIED_SEQ_KEY, MARK_PRICE_KEY_PREFIX } from './projector.js';
import * as s from './schema.js';

export interface UserRow {
  id: string;
  createdAt: number;
  faucetClaimedAt: number | null;
}

/** Engine boot-time restore payload (Exchange.restoreState in @dex/engine). */
export interface RestoreState {
  balances: { userId: string; asset: string; available: bigint; locked: bigint }[];
  positions: Position[];
  leverages: { userId: string; marketId: string; leverage: number }[];
  /** ascending seq — reinsert FIFO */
  openOrders: Order[];
  markPrices: { marketId: string; price: bigint }[];
  lastSeq: number;
}

type OrderSelect = typeof s.orders.$inferSelect;
type TradeSelect = typeof s.trades.$inferSelect;
type PositionSelect = typeof s.positions.$inferSelect;
type MarketSelect = typeof s.markets.$inferSelect;

function toOrder(r: OrderSelect): Order {
  return {
    id: r.id,
    userId: r.userId,
    marketId: r.marketId,
    side: r.side,
    type: r.type,
    price: r.price,
    qty: r.qty,
    filledQty: r.filledQty,
    status: r.status,
    tif: r.tif,
    postOnly: r.postOnly,
    reduceOnly: r.reduceOnly,
    clientOrderId: r.clientOrderId,
    seq: r.seq,
    ts: r.ts,
  };
}

function toTrade(r: TradeSelect): Trade {
  return {
    id: r.id,
    marketId: r.marketId,
    price: r.price,
    qty: r.qty,
    takerSide: r.takerSide,
    makerOrderId: r.makerOrderId,
    takerOrderId: r.takerOrderId,
    makerUserId: r.makerUserId,
    takerUserId: r.takerUserId,
    makerFee: r.makerFee,
    takerFee: r.takerFee,
    seq: r.seq,
    ts: r.ts,
  };
}

/** Convert a projected row into a shared `Position` (margin is NOT NULL by schema). */
function toPosition(r: PositionSelect): Position {
  return {
    userId: r.userId,
    marketId: r.marketId,
    size: r.size,
    entryPrice: r.entryPrice,
    leverage: r.leverage,
    margin: r.margin,
  };
}

function toMarketConfig(r: MarketSelect): MarketConfig {
  return {
    id: r.id,
    type: r.type,
    base: r.base,
    quote: r.quote,
    koreanName: r.koreanName,
    englishName: r.englishName,
    tickSize: r.tickSize,
    lotSize: r.lotSize,
    minNotional: r.minNotional,
    makerFeeBps: r.makerFeeBps,
    takerFeeBps: r.takerFeeBps,
    maxLeverage: r.maxLeverage,
  };
}

export function createRepos(db: Db) {
  const users = {
    /**
     * Insert-if-missing by lowercase address; returns the row. `nowMs` is
     * required (no Date.now() default) so callers stay reproducible.
     */
    async getOrCreate(address: string, nowMs: number): Promise<UserRow> {
      const id = address.toLowerCase();
      await db.insert(s.users).values({ id, createdAt: nowMs }).onConflictDoNothing();
      const rows = await db.select().from(s.users).where(eq(s.users.id, id));
      const row = rows[0];
      if (row === undefined) throw new Error(`users.getOrCreate: row missing for ${id}`);
      return row;
    },

    async get(address: string): Promise<UserRow | undefined> {
      const rows = await db.select().from(s.users).where(eq(s.users.id, address.toLowerCase()));
      return rows[0];
    },

    /** `atMs` is required (no Date.now() default) so callers stay reproducible. */
    async setFaucetClaimed(address: string, atMs: number): Promise<void> {
      await db
        .update(s.users)
        .set({ faucetClaimedAt: atMs })
        .where(eq(s.users.id, address.toLowerCase()));
    },

    /**
     * Atomically claim the faucet: a single conditional UPDATE that only
     * succeeds while faucet_claimed_at IS NULL. Returns true iff THIS call won
     * the claim, so concurrent requests cannot both deposit (no double-spend).
     */
    async claimFaucet(address: string, atMs: number): Promise<boolean> {
      const won = await db
        .update(s.users)
        .set({ faucetClaimedAt: atMs })
        .where(and(eq(s.users.id, address.toLowerCase()), isNull(s.users.faucetClaimedAt)))
        .returning({ id: s.users.id });
      return won.length === 1;
    },
  };

  const markets = {
    async upsertAll(configs: MarketConfig[]): Promise<void> {
      if (configs.length === 0) return;
      // Chunk to keep parameter counts well below Postgres limits.
      const CHUNK = 200;
      for (let i = 0; i < configs.length; i += CHUNK) {
        const chunk = configs.slice(i, i + CHUNK);
        await db
          .insert(s.markets)
          .values(
            chunk.map((m) => ({
              id: m.id,
              type: m.type,
              base: m.base,
              quote: m.quote,
              koreanName: m.koreanName,
              englishName: m.englishName,
              tickSize: m.tickSize,
              lotSize: m.lotSize,
              minNotional: m.minNotional,
              makerFeeBps: m.makerFeeBps,
              takerFeeBps: m.takerFeeBps,
              maxLeverage: m.maxLeverage,
            })),
          )
          .onConflictDoUpdate({
            target: s.markets.id,
            set: {
              type: sql`excluded.type`,
              base: sql`excluded.base`,
              quote: sql`excluded.quote`,
              koreanName: sql`excluded.korean_name`,
              englishName: sql`excluded.english_name`,
              tickSize: sql`excluded.tick_size`,
              lotSize: sql`excluded.lot_size`,
              minNotional: sql`excluded.min_notional`,
              makerFeeBps: sql`excluded.maker_fee_bps`,
              takerFeeBps: sql`excluded.taker_fee_bps`,
              maxLeverage: sql`excluded.max_leverage`,
            },
          });
      }
    },

    async list(): Promise<MarketConfig[]> {
      const rows = await db.select().from(s.markets).orderBy(asc(s.markets.id));
      return rows.map(toMarketConfig);
    },
  };

  const balances = {
    async forUser(userId: string): Promise<Balance[]> {
      const rows = await db
        .select()
        .from(s.balances)
        .where(eq(s.balances.userId, userId))
        .orderBy(asc(s.balances.asset));
      return rows.map((r) => ({ asset: r.asset, available: r.available, locked: r.locked }));
    },
  };

  const orders = {
    async byId(id: string): Promise<Order | undefined> {
      const rows = await db.select().from(s.orders).where(eq(s.orders.id, id));
      const row = rows[0];
      return row === undefined ? undefined : toOrder(row);
    },

    async openForUser(userId: string, marketId?: string): Promise<Order[]> {
      const where =
        marketId === undefined
          ? and(eq(s.orders.userId, userId), eq(s.orders.status, 'open'))
          : and(
              eq(s.orders.userId, userId),
              eq(s.orders.status, 'open'),
              eq(s.orders.marketId, marketId),
            );
      const rows = await db.select().from(s.orders).where(where).orderBy(asc(s.orders.seq));
      return rows.map(toOrder);
    },

    /** Every open order across all users/markets, ascending seq (FIFO restore order). */
    async openAllAscSeq(): Promise<Order[]> {
      const rows = await db
        .select()
        .from(s.orders)
        .where(eq(s.orders.status, 'open'))
        .orderBy(asc(s.orders.seq));
      return rows.map(toOrder);
    },

    /**
     * Order history for a user, newest-first, with an optional status filter
     * and a `beforeSeq` cursor for pagination. `status`: 'open' (resting),
     * 'closed' (filled/cancelled/rejected), or 'all'.
     */
    async historyForUser(
      userId: string,
      opts: { status?: 'open' | 'closed' | 'all'; beforeSeq?: number; limit?: number } = {},
    ): Promise<Order[]> {
      const status = opts.status ?? 'all';
      const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
      const conds = [eq(s.orders.userId, userId)];
      if (status === 'open') conds.push(eq(s.orders.status, 'open'));
      else if (status === 'closed')
        conds.push(or(eq(s.orders.status, 'filled'), eq(s.orders.status, 'cancelled'), eq(s.orders.status, 'rejected'))!);
      if (opts.beforeSeq !== undefined) conds.push(lt(s.orders.seq, opts.beforeSeq));
      const rows = await db
        .select()
        .from(s.orders)
        .where(and(...conds))
        .orderBy(desc(s.orders.seq))
        .limit(limit);
      return rows.map(toOrder);
    },

    /** The user's fills (as maker or taker), newest-first, with optional cursor. */
    async fillsForUser(userId: string, opts: { beforeSeq?: number; limit?: number } = {}): Promise<Trade[]> {
      const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
      const conds = [or(eq(s.trades.makerUserId, userId), eq(s.trades.takerUserId, userId))!];
      if (opts.beforeSeq !== undefined) conds.push(lt(s.trades.seq, opts.beforeSeq));
      const rows = await db
        .select()
        .from(s.trades)
        .where(and(...conds))
        .orderBy(desc(s.trades.seq))
        .limit(limit);
      return rows.map(toTrade);
    },
  };

  const trades = {
    /** Most recent trades first. */
    async recentForMarket(marketId: string, limit = 50): Promise<Trade[]> {
      const rows = await db
        .select()
        .from(s.trades)
        .where(eq(s.trades.marketId, marketId))
        .orderBy(desc(s.trades.seq))
        .limit(limit);
      return rows.map(toTrade);
    },
  };

  const positions = {
    async forUser(userId: string): Promise<Position[]> {
      const rows = await db
        .select()
        .from(s.positions)
        .where(eq(s.positions.userId, userId))
        .orderBy(asc(s.positions.marketId));
      return rows.map(toPosition);
    },

    async all(): Promise<Position[]> {
      const rows = await db
        .select()
        .from(s.positions)
        .orderBy(asc(s.positions.userId), asc(s.positions.marketId));
      return rows.map(toPosition);
    },
  };

  const leverage = {
    /** User-chosen leverage for a market; defaults to 1 when never set. */
    async get(userId: string, marketId: string): Promise<number> {
      const rows = await db
        .select()
        .from(s.userMarketLeverage)
        .where(
          and(eq(s.userMarketLeverage.userId, userId), eq(s.userMarketLeverage.marketId, marketId)),
        );
      return rows[0]?.leverage ?? 1;
    },

    async set(userId: string, marketId: string, lev: number): Promise<void> {
      if (!Number.isInteger(lev) || lev < 1) throw new RangeError(`invalid leverage: ${lev}`);
      await db
        .insert(s.userMarketLeverage)
        .values({ userId, marketId, leverage: lev })
        .onConflictDoUpdate({
          target: [s.userMarketLeverage.userId, s.userMarketLeverage.marketId],
          set: { leverage: lev },
        });
    },
  };

  const nonces = {
    /** Issue (or refresh) a login nonce with absolute expiry nowMs + ttlMs. */
    async issue(address: string, nonce: string, ttlMs: number, nowMs: number): Promise<void> {
      const expiresAt = nowMs + ttlMs;
      await db
        .insert(s.authNonces)
        .values({ address: address.toLowerCase(), nonce, expiresAt })
        .onConflictDoUpdate({
          target: [s.authNonces.address, s.authNonces.nonce],
          set: { expiresAt },
        });
    },

    /**
     * Single-use consume: deletes the nonce row; returns true only when the
     * nonce existed AND had not expired. A second consume always fails.
     */
    async consume(address: string, nonce: string, nowMs: number): Promise<boolean> {
      const rows = await db
        .delete(s.authNonces)
        .where(
          and(eq(s.authNonces.address, address.toLowerCase()), eq(s.authNonces.nonce, nonce)),
        )
        .returning({ expiresAt: s.authNonces.expiresAt });
      const row = rows[0];
      return row !== undefined && row.expiresAt > nowMs;
    },

    /**
     * Garbage-collect nonces that expired without being consumed (the auth
     * path otherwise grows auth_nonces without bound). Returns the number of
     * rows deleted. Callers should run this periodically (e.g. on each nonce
     * issue, or on a timer).
     */
    async sweepExpired(nowMs: number): Promise<number> {
      const rows = await db
        .delete(s.authNonces)
        .where(lte(s.authNonces.expiresAt, nowMs))
        .returning({ address: s.authNonces.address });
      return rows.length;
    },
  };

  const candles = {
    /** Latest `limit` cached candles, ascending bucket time. */
    async get(marketId: string, interval: CandleInterval, limit: number): Promise<Candle[]> {
      const rows = await db
        .select()
        .from(s.candlesCache)
        .where(and(eq(s.candlesCache.marketId, marketId), eq(s.candlesCache.interval, interval)))
        .orderBy(desc(s.candlesCache.t))
        .limit(limit);
      rows.reverse();
      return rows.map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
    },

    /** Batch upsert (overwrites OHLCV + fetched_at on conflict). */
    async put(
      marketId: string,
      interval: CandleInterval,
      batch: Candle[],
      fetchedAtMs: number,
    ): Promise<void> {
      if (batch.length === 0) return;
      const CHUNK = 500;
      for (let i = 0; i < batch.length; i += CHUNK) {
        const chunk = batch.slice(i, i + CHUNK);
        await db
          .insert(s.candlesCache)
          .values(
            chunk.map((candle) => ({
              marketId,
              interval,
              t: candle.t,
              o: candle.o,
              h: candle.h,
              l: candle.l,
              c: candle.c,
              v: candle.v,
              fetchedAt: fetchedAtMs,
            })),
          )
          .onConflictDoUpdate({
            target: [s.candlesCache.marketId, s.candlesCache.interval, s.candlesCache.t],
            set: {
              o: sql`excluded.o`,
              h: sql`excluded.h`,
              l: sql`excluded.l`,
              c: sql`excluded.c`,
              v: sql`excluded.v`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          });
      }
    },
  };

  /**
   * Retention GC for the durable projection. The book mirror continuously
   * cancels+re-submits house quotes across every active market, so the orders
   * table (and, more slowly, trades/funding/liquidations) would grow without
   * bound. Pruning keeps the projection a bounded hot store; loadRestoreState
   * reads only status='open' orders, so pruning terminal rows never affects
   * restore correctness. MUST be called serialized through the pipeline.
   */
  /** Rolling cap: delete all but the most-recent `keep` rows, ordered by `seq`. */
  async function trimBySeq(
    table: typeof s.trades | typeof s.fundingPayments | typeof s.liquidations,
    keep: number,
  ): Promise<number> {
    const cutoff = await db
      .select({ seq: table.seq })
      .from(table)
      .orderBy(desc(table.seq))
      .limit(1)
      .offset(keep);
    const cut = cutoff[0]?.seq;
    if (cut === undefined) return 0;
    const del = await db.delete(table).where(lte(table.seq, cut)).returning({ seq: table.seq });
    return del.length;
  }

  const retention = {
    async prune(opts: {
      /** the house liquidity account whose high-churn terminal orders to prune */
      mirrorUserId: string;
      /** delete the mirror's terminal (cancelled/filled) orders with ts older than this */
      terminalOrdersBeforeTs: number;
      /** keep only the most recent N trades on the global tape */
      tradesKeep: number;
      /** keep only the most recent N funding / liquidation rows */
      eventsKeep: number;
    }): Promise<{ orders: number; trades: number; funding: number; liquidations: number }> {
      // Only the book MIRROR's terminal orders are pruned (it requotes ~thousands/min
      // and is the sole source of unbounded growth). Real users' terminal orders are
      // kept so order history stays available — users place comparatively nothing.
      const delOrders = await db
        .delete(s.orders)
        .where(
          and(
            eq(s.orders.userId, opts.mirrorUserId),
            or(eq(s.orders.status, 'cancelled'), eq(s.orders.status, 'filled')),
            lte(s.orders.ts, opts.terminalOrdersBeforeTs),
          ),
        )
        .returning({ id: s.orders.id });
      return {
        orders: delOrders.length,
        trades: await trimBySeq(s.trades, opts.tradesKeep),
        funding: await trimBySeq(s.fundingPayments, opts.eventsKeep),
        liquidations: await trimBySeq(s.liquidations, opts.eventsKeep),
      };
    },
  };

  /**
   * Build the exact `Exchange.restoreState` payload from the projection.
   * Runs in a single REPEATABLE READ (read-only) transaction: every SELECT
   * sees the same database snapshot, so balances/positions/orders/lastSeq
   * are consistent with each other even if a projector commit lands
   * concurrently. The explicit isolation level matters on a real
   * multi-connection Postgres — under the default READ COMMITTED each
   * statement would get its own snapshot and the multi-SELECT could tear;
   * on single-connection PGlite it is belt-and-braces.
   */
  async function loadRestoreState(): Promise<RestoreState> {
    return db.transaction(async (tx) => {
      const balanceRows = await tx
        .select()
        .from(s.balances)
        .orderBy(asc(s.balances.userId), asc(s.balances.asset));
      const positionRows = await tx
        .select()
        .from(s.positions)
        .orderBy(asc(s.positions.userId), asc(s.positions.marketId));
      const leverageRows = await tx
        .select()
        .from(s.userMarketLeverage)
        .orderBy(asc(s.userMarketLeverage.userId), asc(s.userMarketLeverage.marketId));
      const openOrderRows = await tx
        .select()
        .from(s.orders)
        .where(eq(s.orders.status, 'open'))
        .orderBy(asc(s.orders.seq));
      const metaRows = await tx
        .select()
        .from(s.meta)
        .where(like(s.meta.key, `${MARK_PRICE_KEY_PREFIX}%`))
        .orderBy(asc(s.meta.key));
      const lastSeqRows = await tx
        .select({ value: s.meta.value })
        .from(s.meta)
        .where(eq(s.meta.key, LAST_APPLIED_SEQ_KEY));

      return {
        balances: balanceRows.map((r) => ({
          userId: r.userId,
          asset: r.asset,
          available: r.available,
          locked: r.locked,
        })),
        // margin comes back verbatim from the projection, which persists the
        // engine's exact isolated margin (see projector.ts) — never an
        // approximation, so restoreState preserves the conservation invariant
        // and liquidation semantics across restarts. A position whose margin
        // the engine never reported (NULL) throws here (toPosition): exact
        // restore of such a position is impossible without corrupting money
        // state, and silently dropping or approximating it would be worse.
        positions: positionRows.map(toPosition),
        leverages: leverageRows.map((r) => ({
          userId: r.userId,
          marketId: r.marketId,
          leverage: r.leverage,
        })),
        openOrders: openOrderRows.map(toOrder),
        markPrices: metaRows.map((r) => ({
          marketId: r.key.slice(MARK_PRICE_KEY_PREFIX.length),
          price: BigInt(r.value),
        })),
        lastSeq: Number(lastSeqRows[0]?.value ?? '0'),
      };
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }

  return {
    users,
    markets,
    balances,
    orders,
    trades,
    positions,
    leverage,
    nonces,
    candles,
    retention,
    loadRestoreState,
  };
}

export type Repos = ReturnType<typeof createRepos>;
