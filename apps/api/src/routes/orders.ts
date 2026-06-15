import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import {
  DexError,
  ErrorCodes,
  jsonSafe,
  mulDiv,
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

export function registerOrderRoutes(
  app: FastifyInstance,
  svc: Services,
  authenticate: preHandlerAsyncHookHandler,
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
      const code = (Object.values(ErrorCodes) as string[]).includes(rejected.code)
        ? (rejected.code as ErrorCode)
        : 'INVALID_ORDER';
      throw new DexError(code, rejected.reason);
    }
    const accepted = outcome.find((e) => e.kind === 'orderAccepted');
    if (!accepted) throw new DexError('INTERNAL', 'no acceptance event');
    // engine may have already evicted a fully-filled/cancelled order — prefer
    // the live order, else reconstruct the terminal state from the events
    const live = engine.getOrder(accepted.order.id);
    return jsonSafe(live ?? finalOrderState(outcome, accepted.order));
  });

  app.delete('/api/orders/:id', { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    await pipeline.exec(() => engine.cancelOrder(req.userId, id, Date.now()));
    return { ok: true };
  });

  app.get('/api/orders', { preHandler: authenticate }, (req) => {
    return jsonSafe(engine.getOpenOrders(req.userId));
  });

  app.get('/api/fills', { preHandler: authenticate }, async (req) => {
    const trades = await repos.orders.fillsForUser(req.userId, 100);
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
