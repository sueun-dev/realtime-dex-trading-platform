import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { DexError, FAUCET_KRW, FAUCET_USDC, jsonSafe, zLeverageRequest } from '@dex/shared';
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
}
