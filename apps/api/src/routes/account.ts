import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { DexError, FAUCET_USDC, jsonSafe, zLeverageRequest } from '@dex/shared';
import type { Services } from '../services.js';

export function registerAccountRoutes(
  app: FastifyInstance,
  svc: Services,
  authenticate: preHandlerAsyncHookHandler,
): void {
  const { engine, repos, pipeline } = svc;

  app.get('/api/account', { preHandler: authenticate }, (req) => {
    return jsonSafe(engine.getAccountSummary(req.userId));
  });

  app.post('/api/account/faucet', { preHandler: authenticate }, async (req) => {
    await repos.users.getOrCreate(req.userId, Date.now());
    // atomic compare-and-set: only the request that flips faucet_claimed_at
    // NULL→now wins, so concurrent claims cannot both deposit (no double-spend)
    const won = await repos.users.claimFaucet(req.userId, Date.now());
    if (!won) throw new DexError('FAUCET_ALREADY_CLAIMED', 'faucet already claimed');
    await pipeline.exec(() => engine.deposit(req.userId, 'USDC', FAUCET_USDC, Date.now()));
    return { ok: true };
  });

  app.post('/api/account/leverage', { preHandler: authenticate }, async (req) => {
    const { marketId, leverage } = zLeverageRequest.parse(req.body);
    // engine.setLeverage throws on open position/orders (LEVERAGE_IN_USE); only
    // persist after it succeeds, on the SAME serialized queue so engine state
    // and the durable projection cannot diverge or reorder
    await pipeline.run(() => {
      engine.setLeverage(req.userId, marketId, leverage, Date.now());
      return [null, []] as const;
    });
    await pipeline.runDb(() => repos.leverage.set(req.userId, marketId, leverage));
    return { ok: true };
  });

  // a user's funding-payment history (paid/received), seq-cursor paginated
  app.get('/api/account/funding', { preHandler: authenticate }, async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const rows = await repos.perpHistory.fundingForUser(req.userId, {
      ...(q.before !== undefined ? { beforeSeq: Number(q.before) } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
    return jsonSafe(rows);
  });

  // a user's liquidation history, seq-cursor paginated
  app.get('/api/account/liquidations', { preHandler: authenticate }, async (req) => {
    const q = req.query as { before?: string; limit?: string };
    const rows = await repos.perpHistory.liquidationsForUser(req.userId, {
      ...(q.before !== undefined ? { beforeSeq: Number(q.before) } : {}),
      ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}),
    });
    return jsonSafe(rows);
  });
}
