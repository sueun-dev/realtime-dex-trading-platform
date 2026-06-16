import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import {
  DexError,
  ErrorCodes,
  divUnits,
  jsonSafe,
  mulDiv,
  mulUnits,
  parseOrderRequest,
  roundToTick,
  type EngineEvent,
  type ErrorCode,
  type Order,
  type OrderRequest,
  type Trade,
} from '@dex/shared';
import type { Services } from '../services.js';

/**
 * Final state of a just-submitted order, derived from its own events. The
 * engine evicts terminal orders from memory immediately, so getOrder() returns
 * undefined for an order that fully filled or was cancelled in the same call —
 * we reconstruct the terminal snapshot from the trade/cancel events instead of
 * relying on the stale at-acceptance snapshot.
 */
function finalOrderState(events: EngineEvent[], accepted: Order): Order {
  let snap = accepted;
  let cancelled = false;
  for (const e of events) {
    if (e.kind === 'trade') {
      if (e.takerOrder.id === accepted.id) snap = e.takerOrder;
      else if (e.makerOrder.id === accepted.id) snap = e.makerOrder;
    } else if (e.kind === 'orderCancelled' && e.orderId === accepted.id) {
      cancelled = true;
    }
  }
  return cancelled && snap.status !== 'filled' ? { ...snap, status: 'cancelled' } : snap;
}

/**
 * Volume-weighted average fill price for an order, from its trade events —
 * what a trader most wants after a market order sweeps multiple price levels.
 * Returns null when the order had no fills. (Computed at the read layer from
 * the fill tape, so no extra order state needs to be persisted.)
 */
function avgFillPrice(events: EngineEvent[], orderId: string): bigint | null {
  let notional = 0n;
  let qty = 0n;
  for (const e of events) {
    if (e.kind === 'trade' && (e.trade.takerOrderId === orderId || e.trade.makerOrderId === orderId)) {
      notional += mulUnits(e.trade.price, e.trade.qty);
      qty += e.trade.qty;
    }
  }
  return qty > 0n ? divUnits(notional, qty) : null;
}

export function registerOrderRoutes(
  app: FastifyInstance,
  svc: Services,
  authenticate: preHandlerAsyncHookHandler,
  metrics?: import('../metrics.js').Metrics,
): void {
  const { engine, repos, pipeline } = svc;

  app.post('/api/orders', { preHandler: authenticate }, async (req) => {
    const parsed = parseOrderRequest(req.body);
    const request: OrderRequest =
      parsed.type === 'market' && parsed.price === undefined
        ? { ...parsed, price: defaultMarketBound(svc, parsed) }
        : parsed;

    const outcome = await pipeline.run(() => {
      const events = engine.submitOrder(req.userId, request, Date.now());
      return [events, events] as const;
    });
    const rejected = outcome.find((e) => e.kind === 'orderRejected');
    if (rejected) {
      metrics?.ordersRejected.inc({ code: rejected.code });
      // idempotent retry: a duplicate clientOrderId returns the EXISTING live
      // order (200) instead of an error, so a client that retries after a
      // network timeout can't accidentally double-submit
      if (rejected.code === ErrorCodes.DUPLICATE_CLIENT_ORDER_ID && request.clientOrderId !== undefined) {
        const existing = engine
          .getOpenOrders(req.userId, request.marketId)
          .find((o) => o.clientOrderId === request.clientOrderId);
        if (existing) return jsonSafe(existing);
      }
      const code = (Object.values(ErrorCodes) as string[]).includes(rejected.code)
        ? (rejected.code as ErrorCode)
        : 'INVALID_ORDER';
      throw new DexError(code, rejected.reason);
    }
    const accepted = outcome.find((e) => e.kind === 'orderAccepted');
    if (!accepted) throw new DexError('INTERNAL', 'no acceptance event');
    metrics?.ordersAccepted.inc({ market: request.marketId, type: request.type });
    metrics?.tradesExecuted.inc(outcome.filter((e) => e.kind === 'trade').length);
    // engine may have already evicted a fully-filled/cancelled order — prefer
    // the live order, else reconstruct the terminal state from the events
    const live = engine.getOrder(accepted.order.id);
    const order = live ?? finalOrderState(outcome, accepted.order);
    const avg = avgFillPrice(outcome, accepted.order.id);
    return jsonSafe({ ...order, avgFillPrice: avg });
  });

  app.delete('/api/orders/:id', { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    await pipeline.exec(() => engine.cancelOrder(req.userId, id, Date.now()));
    return { ok: true };
  });

  app.get('/api/orders', { preHandler: authenticate }, async (req) => {
    const q = req.query as { status?: string; before?: string; limit?: string };
    const status = q.status === 'closed' || q.status === 'all' ? q.status : 'open';
    // open orders come live from the engine (source of truth); closed/all history
    // is served from the durable projection with a cursor
    if (status === 'open' && q.before === undefined) {
      return jsonSafe(engine.getOpenOrders(req.userId));
    }
    const orders = await repos.orders.historyForUser(req.userId, {
      status,
      ...(q.before !== undefined ? { beforeSeq: Number(q.before) } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
    return jsonSafe(orders);
  });

  app.get('/api/fills', { preHandler: authenticate }, async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const trades = await repos.orders.fillsForUser(req.userId, {
      ...(q.before !== undefined ? { beforeSeq: Number(q.before) } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
    return jsonSafe(trades.map((t) => toFill(t, req.userId)));
  });
}

/** A trade from one user's perspective. */
function toFill(t: Trade, userId: string): Record<string, unknown> {
  const isTaker = t.takerUserId === userId;
  const side = isTaker ? t.takerSide : t.takerSide === 'buy' ? 'sell' : 'buy';
  return {
    id: t.id,
    marketId: t.marketId,
    price: t.price,
    qty: t.qty,
    side,
    takerSide: t.takerSide,
    role: isTaker ? 'taker' : 'maker',
    fee: isTaker ? t.takerFee : t.makerFee,
    ts: t.ts,
  };
}

/** Default worst-price bound for market orders: best opposite price ±5%. */
function defaultMarketBound(svc: Services, req: OrderRequest): bigint {
  const { engine, priceCache } = svc;
  const m = engine.getMarket(req.marketId);
  if (!m) throw new DexError('MARKET_NOT_FOUND', `unknown market ${req.marketId}`);
  const book = engine.getOrderbook(req.marketId, 1);
  const best = req.side === 'buy' ? book.asks[0]?.price : book.bids[0]?.price;
  const ref = best ?? priceCache.get(req.marketId)?.price;
  if (ref === undefined || ref <= 0n) {
    throw new DexError('INVALID_ORDER', 'no reference price for market order bound');
  }
  const bound =
    req.side === 'buy'
      ? roundToTick(mulDiv(ref, 105n, 100n), m.tickSize, 'floor')
      : roundToTick(mulDiv(ref, 95n, 100n), m.tickSize, 'ceil');
  if (bound <= 0n) throw new DexError('INVALID_ORDER', 'no valid market order bound');
  return bound;
}
