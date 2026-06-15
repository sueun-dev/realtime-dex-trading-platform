import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { DexError, ErrorCodes, type ErrorCode } from '@dex/shared';
import type { Services } from './services.js';
import type { HubSocket } from './wsHub.js';
import { registerMarketRoutes } from './routes/markets.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerOrderRoutes } from './routes/orders.js';

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
  const { auth, hub } = svc;
  // trustProxy makes req.ip resolve from X-Forwarded-For so per-IP rate limits
  // scope to the real client behind a reverse proxy/LB (otherwise every client
  // collapses to the proxy's IP → one shared bucket → global self-DoS). Set it
  // to the trusted proxy CIDR/hop-count in production; default off (direct).
  const app = fastify({ logger: false, trustProxy: svc.trustProxy ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  if (svc.rateLimit !== false) {
    await app.register(rateLimit, {
      global: true,
      max: svc.rateLimit.max,
      timeWindow: svc.rateLimit.windowSec * 1000,
      keyGenerator: (req) => req.ip, // honors trustProxy → real client IP
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        ...errorBody(ErrorCodes.RATE_LIMITED, `rate limit exceeded, retry in ${ctx.after}`),
      }),
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DexError) {
      return reply.status(STATUS_BY_CODE[err.code] ?? 400).send(errorBody(err.code, err.message));
    }
    if (err instanceof ZodError) {
      const msg = err.issues
        .map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return reply.status(422).send(errorBody(ErrorCodes.INVALID_ORDER, msg));
    }
    // @fastify/rate-limit throws a plain error carrying statusCode 429
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send(errorBody(ErrorCodes.RATE_LIMITED, 'rate limit exceeded'));
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

  app.get('/ws', { websocket: true }, (socket) => {
    hub.register(socket as unknown as HubSocket);
  });

  registerMarketRoutes(app, svc);
  registerAuthRoutes(app, svc, svc.rateLimit === false ? undefined : svc.rateLimit.authMax);
  registerAccountRoutes(app, svc, authenticate);
  registerOrderRoutes(app, svc, authenticate);

  return app;
}
