import { Exchange } from '@dex/engine';
import { Projector, createDb, createRepos, type DbHandle, type Repos } from '@dex/db';
import {
  CandleService,
  HyperliquidRest,
  PriceCache,
  UpbitRest,
  buildPerpMarkets,
  buildSpotMarkets,
  spotMarketIdForUpbitCode,
} from '@dex/market-data';
import type { MarketConfig, Ticker } from '@dex/shared';
import { AuthService } from './auth.js';
import { Pipeline } from './pipeline.js';
import { WsHub } from './wsHub.js';
import { startFeeds } from './feeds.js';
import { startBookMirror } from './bookMirror.js';
import { startFunding } from './funding.js';
import { startRetention } from './retention.js';

export interface Stoppable {
  stop(): void;
}

export interface ServiceOptions {
  /** PGlite data directory; undefined = in-memory (tests) */
  dataDir?: string;
  /** 'live' loads the real Upbit USDT + Hyperliquid perp universes */
  universe: 'live' | MarketConfig[];
  /** live ticker/mark-price feeds (Upbit WS + Hyperliquid WS) */
  feeds?: boolean;
  /** mirror the REAL source-venue orderbooks into the engine (house liquidity) */
  marketMaker?: boolean;
  funding?: boolean;
  /** periodic retention GC of the durable projection (bounds DB growth under mirror churn) */
  retention?: boolean;
  /** invoked when the pipeline poisons (projection failure); production halts the process */
  onFatal?: (err: unknown) => void;
  jwtSecret?: string;
  perpTopN?: number;
  /** HTTP rate limiting (per IP); false = disabled (default, for tests) */
  rateLimit?: RateLimitConfig | false;
  /** Fastify trustProxy (CIDR/hop-count/boolean) so req.ip is the real client behind a proxy */
  trustProxy?: boolean | string | string[] | number;
  /** Fastify logger option (pino config or boolean); default false (quiet, e.g. tests) */
  logger?: import('fastify').FastifyServerOptions['logger'];
  log?: (msg: string) => void;
}

export interface RateLimitConfig {
  /** global requests per window */
  max: number;
  windowSec: number;
  /** stricter cap for /api/auth/* within a 1-minute window */
  authMax?: number;
}

export interface Services {
  db: DbHandle;
  repos: Repos;
  projector: Projector;
  engine: Exchange;
  auth: AuthService;
  hub: WsHub;
  pipeline: Pipeline;
  priceCache: PriceCache;
  candles: CandleService;
  upbit: UpbitRest;
  hl: HyperliquidRest;
  rateLimit: RateLimitConfig | false;
  trustProxy: boolean | string | string[] | number;
  logger: import('fastify').FastifyServerOptions['logger'];
  log: (msg: string) => void;
  stop(): Promise<void>;
}

const TICKER_CHUNK = 100;

export async function fetchTickersChunked(upbit: UpbitRest, codes: string[]): Promise<Ticker[]> {
  const out: Ticker[] = [];
  for (let i = 0; i < codes.length; i += TICKER_CHUNK) {
    out.push(...(await upbit.fetchTickers(codes.slice(i, i + TICKER_CHUNK))));
  }
  return out;
}

/**
 * Boot order matters: persisted market configs are merged with the freshly
 * fetched real universe (fresh wins), the engine is constructed with the full
 * market list, and only then is the durable projection restored into it.
 */
export async function buildServices(opts: ServiceOptions): Promise<Services> {
  const log = opts.log ?? ((m: string) => console.log(`[dex-api] ${m}`));
  const db = await createDb(opts.dataDir);
  const repos = createRepos(db.db);
  const projector = new Projector(db.db);
  const upbit = new UpbitRest();
  const hl = new HyperliquidRest();

  const byId = new Map<string, MarketConfig>();
  for (const m of await repos.markets.list()) byId.set(m.id, m);

  let spotTickers: Ticker[] = [];
  if (opts.universe === 'live') {
    const raw = await upbit.fetchMarkets();
    // a DEX settles in USDC — mirror Upbit's real USDT stablecoin books
    const usdtCodes = raw
      .filter((m) => m.market.startsWith('USDT-') && m.market !== 'USDT-USDT')
      .map((m) => m.market);
    const usdtTickers = await fetchTickersChunked(upbit, usdtCodes); // keyed by USDT-<base>
    const spot = buildSpotMarkets(raw, usdtTickers);
    const [meta, mids] = await Promise.all([hl.meta(), hl.allMids()]);
    const perp = buildPerpMarkets(meta, mids, opts.perpTopN ?? 30);
    for (const m of [...spot, ...perp]) byId.set(m.id, m);
    // relabel USDT-<base> → <base>-USDC for the engine/price-cache namespace
    spotTickers = usdtTickers.map((t) => ({ ...t, marketId: spotMarketIdForUpbitCode(t.marketId) }));
    log(`live universe: ${spot.length} USDC spot + ${perp.length} perp markets`);
  } else {
    for (const m of opts.universe) byId.set(m.id, m);
  }
  const markets = [...byId.values()];
  await repos.markets.upsertAll(markets);

  const engine = new Exchange({ markets });
  const restored = await repos.loadRestoreState();
  engine.restoreState(restored);
  if (restored.lastSeq > 0) {
    log(`restored state @seq=${restored.lastSeq}: ${restored.openOrders.length} open orders, ${restored.positions.length} positions`);
  }

  const auth = new AuthService(opts.jwtSecret ?? process.env.DEX_JWT_SECRET ?? 'dex-dev-secret');
  const hub = new WsHub(engine, (t) => auth.verifyToken(t));
  const pipeline = new Pipeline(projector, hub, {
    onPoison: (err) => {
      log(`FATAL: durable projection failed — pipeline halted to avoid engine/DB divergence: ${String(err)}`);
      opts.onFatal?.(err);
    },
  });
  const priceCache = new PriceCache();
  const candles = new CandleService(upbit, hl);

  priceCache.on('ticker', (t: Ticker) => hub.publishTicker(t));
  // seed spot tickers fetched at boot so /api/markets has prices immediately
  for (const t of spotTickers) priceCache.setTicker(t);

  const stoppables: Stoppable[] = [];
  const services: Services = {
    db,
    repos,
    projector,
    engine,
    auth,
    hub,
    pipeline,
    priceCache,
    candles,
    upbit,
    hl,
    rateLimit: opts.rateLimit ?? false,
    trustProxy: opts.trustProxy ?? false,
    logger: opts.logger ?? false,
    log,
    async stop() {
      for (const s of stoppables) s.stop();
      hub.close();
      await pipeline.drain();
      await db.close();
    },
  };

  if (opts.feeds) stoppables.push(startFeeds(services));
  if (opts.marketMaker) stoppables.push(startBookMirror(services));
  if (opts.funding) stoppables.push(startFunding(services));
  if (opts.retention) stoppables.push(startRetention(services));

  return services;
}
