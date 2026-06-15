/**
 * Real-orderbook mirror: replicates the LIVE source-venue depth (Upbit for
 * KRW spot, Hyperliquid l2Book for perps) into our matching engine as real
 * resting orders of the house account — prices AND sizes are the venue's.
 * User orders interact with this book exactly like on the source market:
 * a user bid inside the real spread rests until the real book crosses it.
 *
 * Mirrored markets = always-on majors ∪ markets someone is currently watching
 * (live orderbook:<mkt> WS subscribers), re-evaluated every 2s.
 */
import {
  feeOn,
  maxBig,
  minBig,
  mulUnits,
  roundToLot,
  roundToTick,
  type BookLevel,
  type EngineEvent,
  type MarketConfig,
} from '@dex/shared';
import {
  HyperliquidWs,
  UpbitWs,
  spotMarketIdForUpbitCode,
  upbitCodeForSpotMarket,
} from '@dex/market-data';
import type { Exchange } from '@dex/engine';
import type { Pipeline } from './pipeline.js';
import type { Services, Stoppable } from './services.js';

export const MIRROR_USER = 'mm-bot';

const ALWAYS_ON = [
  'BTC-USDC',
  'ETH-USDC',
  'XRP-USDC',
  'SOL-USDC',
  'DOGE-USDC',
  'ADA-USDC',
  'BTC-PERP',
  'ETH-PERP',
  'SOL-PERP',
  'XRP-PERP',
];
/** real levels mirrored per side */
const DEPTH = 10;
/** per-market apply throttle (trailing — latest snapshot always lands) */
const APPLY_MS = 400;
const ACTIVE_REFRESH_MS = 2000;
/**
 * If no fresh venue snapshot arrives within this window, the feed is treated as
 * down: the mirror book is taken DOWN (no frozen liquidity presented as live)
 * and the market is flagged stale to clients. Upbit/HL push every few seconds,
 * so this only trips on a real outage.
 */
const STALE_MS = 8000;

export interface MirrorDeps {
  engine: Exchange;
  pipeline: Pipeline;
  log: (msg: string) => void;
}

/**
 * Apply one real-venue snapshot to the engine atomically. Unchanged levels
 * are left resting (minimal churn); changed/missing levels are cancel+replaced.
 * Exported for tests.
 */
export function applyMirrorSnapshot(
  deps: MirrorDeps,
  market: MarketConfig,
  bids: BookLevel[],
  asks: BookLevel[],
): Promise<EngineEvent[]> {
  const { engine } = deps;
  return deps.pipeline.exec(() => {
    const now = Date.now();
    const evts: EngineEvent[] = [];

    const desire = (levels: BookLevel[], side: 'buy' | 'sell'): Map<bigint, bigint> => {
      const out = new Map<bigint, bigint>();
      for (const l of levels.slice(0, DEPTH)) {
        // legacy venue prices can sit off the current tick grid — snap them
        const price = roundToTick(l.price, market.tickSize, side === 'buy' ? 'floor' : 'ceil');
        const qty = roundToLot(l.qty, market.lotSize);
        if (price <= 0n || qty < market.lotSize) continue;
        if (mulUnits(qty, price) < market.minNotional) continue;
        out.set(price, (out.get(price) ?? 0n) + qty);
      }
      return out;
    };
    const dBids = desire(bids, 'buy');
    const dAsks = desire(asks, 'sell');
    // tick-rounding could cross the snapped sides — drop offending bids
    let bestAsk: bigint | null = null;
    for (const p of dAsks.keys()) bestAsk = bestAsk === null ? p : minBig(bestAsk, p);
    if (bestAsk !== null) {
      for (const p of [...dBids.keys()]) if (p >= bestAsk) dBids.delete(p);
    }

    // keep exact matches, cancel the rest
    for (const o of engine.getOpenOrders(MIRROR_USER, market.id)) {
      const want = o.side === 'buy' ? dBids : dAsks;
      const remaining = o.qty - o.filledQty;
      if (o.price !== null && want.get(o.price) === remaining) {
        want.delete(o.price); // already resting exactly as the venue shows
      } else {
        evts.push(...engine.cancelOrder(MIRROR_USER, o.id, now));
      }
    }

    // fund the house account for what's about to be placed
    let quoteNeed = 0n;
    let baseNeed = 0n;
    for (const [p, q] of dBids) {
      const notional = mulUnits(q, p);
      quoteNeed += notional + feeOn(notional, market.takerFeeBps);
    }
    for (const [p, q] of dAsks) {
      if (market.type === 'spot') baseNeed += q;
      else {
        const notional = mulUnits(q, p);
        quoteNeed += notional + feeOn(notional, market.takerFeeBps);
      }
    }
    const bal = new Map(engine.getBalances(MIRROR_USER).map((b) => [b.asset, b.available]));
    if ((bal.get(market.quote) ?? 0n) < quoteNeed) {
      evts.push(...engine.deposit(MIRROR_USER, market.quote, maxBig(quoteNeed * 10n, 1n), now));
    }
    if (baseNeed > 0n && (bal.get(market.base) ?? 0n) < baseNeed) {
      evts.push(...engine.deposit(MIRROR_USER, market.base, baseNeed * 10n, now));
    }

    for (const [price, qty] of dBids) {
      evts.push(
        ...engine.submitOrder(
          MIRROR_USER,
          { marketId: market.id, side: 'buy', type: 'limit', price, qty, tif: 'GTC' },
          now,
        ),
      );
    }
    for (const [price, qty] of dAsks) {
      evts.push(
        ...engine.submitOrder(
          MIRROR_USER,
          { marketId: market.id, side: 'sell', type: 'limit', price, qty, tif: 'GTC' },
          now,
        ),
      );
    }
    return evts;
  });
}

export function startBookMirror(svc: Services): Stoppable {
  const { engine, pipeline, hub, log } = svc;
  const deps: MirrorDeps = { engine, pipeline, log };
  const byId = new Map(engine.getMarkets().map((m) => [m.id, m]));
  const alwaysOn = ALWAYS_ON.filter((id) => byId.has(id));

  let stopped = false;
  const pendings = new Map<string, { bids: BookLevel[]; asks: BookLevel[] }>();
  const lastApplied = new Map<string, number>();
  const lastSnapshotAt = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cancel every house quote on a market (book down) — its book is no longer live. */
  const takeDown = (marketId: string): Promise<unknown> => {
    pendings.delete(marketId);
    return pipeline
      .exec(() => {
        const now = Date.now();
        const evts: EngineEvent[] = [];
        for (const o of engine.getOpenOrders(MIRROR_USER, marketId)) {
          evts.push(...engine.cancelOrder(MIRROR_USER, o.id, now));
        }
        return evts;
      })
      .catch((e: unknown) => log(`mirror takedown ${marketId} failed: ${String(e)}`));
  };

  const onSnapshot = (marketId: string, bids: BookLevel[], asks: BookLevel[]): void => {
    if (stopped) return;
    const market = byId.get(marketId);
    if (!market) return;
    lastSnapshotAt.set(marketId, Date.now());
    hub.setFeedStale(marketId, false); // fresh venue data — book is live again
    pendings.set(marketId, { bids, asks });
    const since = Date.now() - (lastApplied.get(marketId) ?? 0);
    if (since >= APPLY_MS) flush(marketId);
    else if (!timers.has(marketId)) {
      const t = setTimeout(() => {
        timers.delete(marketId);
        flush(marketId);
      }, APPLY_MS - since);
      t.unref?.();
      timers.set(marketId, t);
    }
  };

  const flush = (marketId: string): void => {
    const pending = pendings.get(marketId);
    const market = byId.get(marketId);
    if (!pending || !market || stopped) return;
    pendings.delete(marketId);
    lastApplied.set(marketId, Date.now());
    void applyMirrorSnapshot(deps, market, pending.bids, pending.asks).catch((e: unknown) =>
      log(`mirror ${marketId} failed: ${String(e)}`),
    );
  };

  // ---- sources -----------------------------------------------------------
  const activeSpot = (): string[] =>
    [...new Set([...alwaysOn, ...hub.subscribedBooks()])].filter(
      (id) => byId.get(id)?.type === 'spot',
    );
  // Upbit subscribes by its native USDT codes; we relabel snapshots back
  const activeSpotCodes = (): string[] => activeSpot().map(upbitCodeForSpotMarket);
  const activePerpCoins = (): string[] =>
    [...new Set([...alwaysOn, ...hub.subscribedBooks()])]
      .map((id) => byId.get(id))
      .filter((m): m is MarketConfig => m !== undefined && m.type === 'perp')
      .map((m) => m.base);

  const upbitOb = new UpbitWs(activeSpotCodes(), { types: ['orderbook'] });
  upbitOb.on('orderbook', (ob: { marketId: string; bids: BookLevel[]; asks: BookLevel[] }) =>
    onSnapshot(spotMarketIdForUpbitCode(ob.marketId), ob.bids, ob.asks),
  );
  upbitOb.on('wsError', () => {});
  upbitOb.connect();

  const hlWs = new HyperliquidWs({ l2Coins: activePerpCoins() });
  hlWs.on('l2book', (book: { coin: string; bids: BookLevel[]; asks: BookLevel[] }) =>
    onSnapshot(`${book.coin}-PERP`, book.bids, book.asks),
  );
  hlWs.on('wsError', () => {});
  hlWs.connect();

  // ---- dynamic active set + staleness watchdog ---------------------------
  let mirrored = new Set<string>([...alwaysOn]);
  const refresh = setInterval(() => {
    if (stopped) return;
    const next = new Set<string>([...alwaysOn, ...[...hub.subscribedBooks()].filter((id) => byId.has(id))]);
    upbitOb.setCodes(activeSpotCodes());
    hlWs.setL2Coins(activePerpCoins());
    const now = Date.now();
    // a market left the active set → take its mirror down (a frozen book lies)
    for (const id of mirrored) {
      if (!next.has(id)) {
        void takeDown(id);
        lastSnapshotAt.delete(id);
        hub.setFeedStale(id, false); // not stale — just not mirrored anymore
      }
    }
    // active markets whose venue feed went silent → take the book DOWN and flag
    // stale, so a frozen book is never presented (or traded against) as live
    for (const id of next) {
      const last = lastSnapshotAt.get(id);
      if (last !== undefined && now - last > STALE_MS && !hub.isFeedStale(id)) {
        log(`mirror ${id}: venue feed stale (>${STALE_MS}ms) — taking book down`);
        hub.setFeedStale(id, true);
        void takeDown(id);
      }
    }
    mirrored = next;
  }, ACTIVE_REFRESH_MS);
  refresh.unref?.();

  log(`book mirror live: ${alwaysOn.join(', ')} + on-demand watched markets`);

  return {
    stop() {
      stopped = true;
      clearInterval(refresh);
      for (const t of timers.values()) clearTimeout(t);
      upbitOb.close();
      hlWs.close();
    },
  };
}
