import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import {
  DexError,
  ErrorCodes,
  FAUCET_KRW,
  FAUCET_USDC,
  FEE_ACCOUNT,
  jsonSafe,
  mulDiv,
  parseOrderRequest,
  roundToTick,
  zAuthNonceRequest,
  zAuthVerifyRequest,
  zCandleInterval,
  zLeverageRequest,
  type ErrorCode,
  type OrderRequest,
  type Trade,
} from '@dex/shared';
import type { Services } from './services.js';
import type { HubSocket } from './wsHub.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  ORDER_NOT_FOUND: 404,
  MARKET_NOT_FOUND: 404,
  NOT_AUTHORIZED: 401,
  FAUCET_ALREADY_CLAIMED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export async function buildApp(svc: Services): Promise<FastifyInstance> {
  const { engine, repos, auth, hub, pipeline, candles } = svc;
  const app = fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DexError) {
      return reply
        .status(STATUS_BY_CODE[err.code] ?? 400)
        .send(errorBody(err.code, err.message));
    }
    if (err instanceof ZodError) {
      const msg = err.issues
        .map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return reply.status(422).send(errorBody(ErrorCodes.INVALID_ORDER, msg));
    }
    svc.log(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return reply.status(500).send(errorBody(ErrorCodes.INTERNAL, 'internal server error'));
  });

  app.decorateRequest('userId', '');
  const authenticate = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token !== null ? await auth.verifyToken(token) : null;
    if (userId === null) throw new DexError('NOT_AUTHORIZED', 'missing or invalid token');
    req.userId = userId;
  };

  // ---- websocket ------------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket) => {
    hub.register(socket as unknown as HubSocket);
  });

  // ---- public ----------------------------------------------------------------
  app.get('/api/health', () => ({ ok: true, seq: engine.seq }));

  /** House commission revenue (FEE_ACCOUNT) per asset. */
  app.get('/api/stats/fees', () => {
    return jsonSafe(engine.getBalances(FEE_ACCOUNT));
  });

  app.get('/api/markets', () => {
    return engine.getMarkets().map((m) => ({
      ...(jsonSafe(m) as Record<string, unknown>),
      ticker: hub.getTicker(m.id) ?? null,
    }));
  });

  app.get('/api/markets/:id/orderbook', (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { depth?: string };
    const depth = Math.min(50, Math.max(1, Number(q.depth ?? 20) || 20));
    return jsonSafe(engine.getOrderbook(id, depth)); // throws MARKET_NOT_FOUND
  });

  app.get('/api/markets/:id/trades', async (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50) || 50));
    return jsonSafe(await repos.trades.recentForMarket(id, limit));
  });

  app.get('/api/markets/:id/candles', async (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { interval?: string; limit?: string };
    const interval = zCandleInterval.parse(q.interval ?? '1m');
    const limit = Math.min(400, Math.max(1, Number(q.limit ?? 200) || 200));
    return jsonSafe(await candles.get(id, interval, limit));
  });

  // ---- auth ------------------------------------------------------------------
  app.post('/api/auth/nonce', (req) => {
    const { address } = zAuthNonceRequest.parse(req.body);
    return { nonce: auth.issueNonce(address) };
  });

  app.post('/api/auth/verify', async (req) => {
    const { address, signature } = zAuthVerifyRequest.parse(req.body);
    const ok = await auth.verifySignature(address, signature as `0x${string}`);
    if (!ok) throw new DexError('NOT_AUTHORIZED', 'signature verification failed');
    await repos.users.getOrCreate(address, Date.now());
    return { token: await auth.issueToken(address) };
  });

  // ---- account ----------------------------------------------------------------
  app.get('/api/account', { preHandler: authenticate }, (req) => {
    return jsonSafe(engine.getAccountSummary(req.userId));
  });

  app.post('/api/account/faucet', { preHandler: authenticate }, async (req) => {
    const user = await repos.users.getOrCreate(req.userId, Date.now());
    if (user.faucetClaimedAt !== null) {
      throw new DexError('FAUCET_ALREADY_CLAIMED', 'faucet already claimed');
    }
    await pipeline.exec(() => {
      const now = Date.now();
      return [
        ...engine.deposit(req.userId, 'KRW', FAUCET_KRW, now),
        ...engine.deposit(req.userId, 'USDC', FAUCET_USDC, now),
      ];
    });
    await repos.users.setFaucetClaimed(req.userId, Date.now());
    return { ok: true };
  });

  app.post('/api/account/leverage', { preHandler: authenticate }, async (req) => {
    const { marketId, leverage } = zLeverageRequest.parse(req.body);
    await pipeline.run(() => {
      engine.setLeverage(req.userId, marketId, leverage, Date.now());
      return [null, []] as const;
    });
    await repos.leverage.set(req.userId, marketId, leverage);
    return { ok: true };
  });

  // ---- orders -----------------------------------------------------------------
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
      const code = (
        Object.values(ErrorCodes) as string[]
      ).includes(rejected.code)
        ? (rejected.code as ErrorCode)
        : 'INVALID_ORDER';
      throw new DexError(code, rejected.reason);
    }
    const accepted = outcome.find((e) => e.kind === 'orderAccepted');
    if (!accepted) throw new DexError('INTERNAL', 'no acceptance event');
    const order = engine.getOrder(accepted.order.id) ?? accepted.order;
    return jsonSafe(order);
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

  return app;
}

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
