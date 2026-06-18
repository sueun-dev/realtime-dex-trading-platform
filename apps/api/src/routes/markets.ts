import type { FastifyInstance } from 'fastify';
import { DexError, FEE_ACCOUNT, jsonSafe, zCandleInterval } from '@dex/shared';
import type { Services } from '../services.js';

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(raw ?? fallback) || fallback));
}

export function registerMarketRoutes(app: FastifyInstance, svc: Services): void {
  const { engine, hub, candles } = svc;

  // liveness: cheap, true the moment the route is registered
  app.get('/api/health', () => ({ ok: true, seq: engine.seq }));

  // readiness: gates LB/orchestrator traffic until the node serves real data —
  // live feeds warmed (tickers for the majors) and perp mark prices present, so
  // we never route to a node whose books are empty / marks absent
  app.get('/api/ready', (_req, reply) => {
    const majors = ['BTC-USDC', 'ETH-USDC', 'BTC-PERP', 'ETH-PERP'].filter((id) => engine.getMarket(id));
    const tickersWarm = majors.filter((id) => hub.getTicker(id) !== undefined).length;
    const perpMarks = engine
      .getMarkets()
      .filter((m) => m.type === 'perp')
      .filter((m) => engine.getMarkPrice(m.id) !== undefined).length;
    const ready = majors.length > 0 && tickersWarm >= Math.ceil(majors.length / 2) && perpMarks > 0;
    return reply.status(ready ? 200 : 503).send({ ready, tickersWarm, perpMarks, seq: engine.seq });
  });

  /** House commission revenue (FEE_ACCOUNT) per asset. */
  app.get('/api/stats/fees', () => jsonSafe(engine.getBalances(FEE_ACCOUNT)));

  app.get('/api/markets', () => {
    return engine.getMarkets().map((m) => ({
      ...(jsonSafe(m) as Record<string, unknown>),
      ticker: hub.getTicker(m.id) ?? null,
      funding: m.type === 'perp' ? (hub.getFunding(m.id) ?? null) : null,
      mark: m.type === 'perp' ? jsonSafe(engine.getMarkPrice(m.id) ?? null) : null,
    }));
  });

  // current REAL perp funding rates (Hyperliquid) + next-settlement time
  app.get('/api/funding', () => hub.allFunding());

  app.get('/api/markets/:id/funding', (req, reply) => {
    const { id } = req.params as { id: string };
    const m = engine.getMarket(id);
    if (!m) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const f = hub.getFunding(id);
    return f ?? reply.status(404).send({ error: 'no funding data yet' });
  });

  // manipulation-resistant perp mark price (median+EMA of HL/OKX/Coinbase) — the
  // number that drives liquidation, funding, and unrealized PnL
  app.get('/api/markets/:id/mark', (req, reply) => {
    const { id } = req.params as { id: string };
    const m = engine.getMarket(id);
    if (!m) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const mark = engine.getMarkPrice(id);
    if (mark === undefined) return reply.status(404).send({ error: 'no mark price yet' });
    return jsonSafe({ marketId: id, price: mark, ts: Date.now() });
  });

  app.get('/api/markets/:id/orderbook', (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { depth?: string };
    const snap = engine.getOrderbook(id, clampInt(q.depth, 20, 1, 50)); // throws MARKET_NOT_FOUND
    // `stale` = source venue feed is down, so the mirror took the book down and
    // this depth is NOT live venue data (clients should not present it as live)
    return { ...(jsonSafe(snap) as Record<string, unknown>), stale: hub.isFeedStale(id) };
  });

  app.get('/api/markets/:id/trades', (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { limit?: string };
    // serve the SAME live tape as the WS trades:<mkt> channel — the hub ring
    // merges real venue prints with our engine fills, newest-first — so REST
    // and WS never disagree (DB holds durable fill history for restore only)
    return hub.recentTrades(id).slice(0, clampInt(q.limit, 50, 1, 200));
  });

  app.get('/api/markets/:id/candles', async (req) => {
    const { id } = req.params as { id: string };
    if (!engine.getMarket(id)) throw new DexError('MARKET_NOT_FOUND', `unknown market ${id}`);
    const q = req.query as { interval?: string; limit?: string };
    const interval = zCandleInterval.parse(q.interval ?? '1m');
    return jsonSafe(await candles.get(id, interval, clampInt(q.limit, 200, 1, 400)));
  });
}
