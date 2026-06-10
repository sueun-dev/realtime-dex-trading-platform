import type { FastifyInstance } from 'fastify';
import { DexError, FEE_ACCOUNT, jsonSafe, zCandleInterval } from '@dex/shared';
import type { Services } from '../services.js';

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(raw ?? fallback) || fallback));
}

export function registerMarketRoutes(app: FastifyInstance, svc: Services): void {
  const { engine, repos, hub, candles } = svc;

  app.get('/api/health', () => ({ ok: true, seq: engine.seq }));

  /** House commission revenue (FEE_ACCOUNT) per asset. */
  app.get('/api/stats/fees', () => jsonSafe(engine.getBalances(FEE_ACCOUNT)));

  app.get('/api/markets', () => {
    return engine.getMarkets().map((m) => ({
      ...(jsonSafe(m) as Record<string, unknown>),
      ticker: hub.getTicker(m.id) ?? null,
    }));
  });

  app.get('/api/markets/:id/orderbook', (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { depth?: string };
    return jsonSafe(engine.getOrderbook(id, clampInt(q.depth, 20, 1, 50))); // throws MARKET_NOT_FOUND
  });

  app.get('/api/markets/:id/trades', async (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { limit?: string };
    return jsonSafe(await repos.trades.recentForMarket(id, clampInt(q.limit, 50, 1, 200)));
  });

  app.get('/api/markets/:id/candles', async (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { interval?: string; limit?: string };
    const interval = zCandleInterval.parse(q.interval ?? '1m');
    return jsonSafe(await candles.get(id, interval, clampInt(q.limit, 200, 1, 400)));
  });
}
