import {
  CLEARING_ACCOUNT,
  FEE_ACCOUNT,
  jsonSafe,
  type EngineEvent,
  type FundingInfo,
  type Ticker,
  type Trade,
} from '@dex/shared';
import type { Exchange } from '@dex/engine';
import type { EventSink } from './pipeline.js';

/** Minimal socket surface (ws WebSocket and test fakes both satisfy it). */
export interface HubSocket {
  send(data: string): void;
  on(event: 'message', cb: (raw: Buffer | string) => void): void;
  on(event: 'close', cb: () => void): void;
  close(): void;
}

interface Conn {
  socket: HubSocket;
  channels: Set<string>;
  userId: string | null;
  /** flood protection: token bucket refilled lazily */
  tokens: number;
  lastRefill: number;
  /** heartbeat liveness: set true on any inbound frame, swept each interval */
  alive: boolean;
}

/** per-connection message budget: burst of 300, refilling 50/s */
const MSG_BURST = 300;
const MSG_PER_SEC = 50;
/** a single client may watch at most this many channels */
const MAX_CHANNELS = 100;

const BOOK_DEPTH = 20;
const BOOK_FLUSH_MS = 80;
const TICKER_FLUSH_MS = 250;
const TRADE_RING = 200;
const LIQ_RING = 100;
/** heartbeat: ping each conn every interval; reap any that didn't speak since the last */
const HEARTBEAT_MS = 30_000;
const INTERNAL_ACCOUNTS = new Set([FEE_ACCOUNT, CLEARING_ACCOUNT]);

/** Per-user accumulator for one dispatch batch — the changed entities the user
 * channel ships so a client can update without a full refetch. */
interface UserBucket {
  kinds: Set<string>;
  orders: unknown[];
  fills: unknown[];
  balances: unknown[];
  positions: unknown[];
  liquidations: unknown[];
  funding: unknown[];
}

/**
 * WebSocket hub for the /ws contract:
 *   in : {op:'subscribe'|'unsubscribe', channel} | {op:'auth', token} | {op:'ping'}
 *   out: {channel, data, seq, reset?}
 * Channels: allTickers, ticker:<mkt>, orderbook:<mkt>, trades:<mkt>, user.
 * Orderbook frames are throttled full snapshots ({type:'snapshot'}).
 *
 * `seq` is a PER-CHANNEL monotonic counter (NOT the global engine seq): every
 * broadcast to a given channel increments that channel's counter by exactly 1,
 * so a client can detect a dropped frame on its own channel as a gap. The very
 * first frame a (re)subscriber receives is a fresh snapshot carrying the
 * channel's current seq plus `reset:true`, so the client resets its expectation
 * instead of seeing a spurious gap.
 */
export class WsHub implements EventSink {
  readonly #conns = new Set<Conn>();
  readonly #engine: Exchange;
  readonly #verifyToken: (token: string) => Promise<string | null>;
  readonly #tradeRing = new Map<string, unknown[]>();
  readonly #tickers = new Map<string, unknown>();
  readonly #funding = new Map<string, unknown>();
  readonly #marks = new Map<string, unknown>();
  #liqRing: unknown[] = []; // public anonymized liquidation tape (most-recent-first)
  #tickerQueue = new Map<string, unknown>();
  readonly #dirtyBooks = new Set<string>();
  /** per-channel monotonic frame counter, stamped onto every outbound frame */
  readonly #channelSeq = new Map<string, number>();
  /** markets whose source venue feed is stale/down — book is NOT live data */
  readonly #staleMarkets = new Set<string>();
  #bookTimer: ReturnType<typeof setTimeout> | null = null;
  #tickerTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(engine: Exchange, verifyToken: (token: string) => Promise<string | null>) {
    this.#engine = engine;
    this.#verifyToken = verifyToken;
    // server heartbeat: reap half-open/dead connections that the OS hasn't yet
    // torn down (no 'close' event), so they don't leak and burn broadcast CPU.
    this.#heartbeatTimer = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  #heartbeat(): void {
    for (const conn of [...this.#conns]) {
      if (!conn.alive) {
        // silent since the last ping → presumed dead
        this.#conns.delete(conn);
        conn.socket.close();
        continue;
      }
      conn.alive = false;
      this.#send(conn, { channel: 'ping', data: null }); // client echoes → marks alive
    }
  }

  register(socket: HubSocket): void {
    const conn: Conn = {
      socket,
      channels: new Set(),
      userId: null,
      tokens: MSG_BURST,
      lastRefill: Date.now(),
      alive: true,
    };
    this.#conns.add(conn);
    socket.on('message', (raw) => {
      conn.alive = true; // any inbound frame proves liveness
      if (!this.#takeToken(conn)) {
        // flooding client: disconnect rather than burn CPU on its frames
        this.#conns.delete(conn);
        conn.socket.close();
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg === null || typeof msg !== 'object') return;
      const { op, channel, token } = msg as { op?: unknown; channel?: unknown; token?: unknown };
      if (op === 'ping') {
        this.#send(conn, { channel: 'pong', data: null });
      } else if (op === 'auth' && typeof token === 'string') {
        void this.#verifyToken(token).then((userId) => {
          if (this.#conns.has(conn)) conn.userId = userId;
        });
      } else if (op === 'subscribe' && typeof channel === 'string') {
        if (conn.channels.size >= MAX_CHANNELS) return;
        conn.channels.add(channel);
        this.#sendInitial(conn, channel);
      } else if (op === 'unsubscribe' && typeof channel === 'string') {
        conn.channels.delete(channel);
      }
    });
    socket.on('close', () => {
      this.#conns.delete(conn);
    });
  }

  #takeToken(conn: Conn): boolean {
    const now = Date.now();
    conn.tokens = Math.min(MSG_BURST, conn.tokens + ((now - conn.lastRefill) / 1000) * MSG_PER_SEC);
    conn.lastRefill = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  /** EventSink: fan engine events out to subscribers. */
  dispatch(events: EngineEvent[]): void {
    const tradesByMarket = new Map<string, Trade[]>();
    const marksByMarket = new Map<string, { marketId: string; price: bigint; ts: number }>();
    const liqs: { marketId: string; size: bigint; markPrice: bigint; reason: string; ts: number }[] = [];
    const touchedUsers = new Map<string, UserBucket>();
    // touch returns the user's bucket so the caller can attach the changed
    // entity (so the user frame carries data, not just a "something changed"
    // kind string — clients can update incrementally instead of refetching).
    const touch = (userId: string, kind: string): UserBucket | null => {
      if (INTERNAL_ACCOUNTS.has(userId)) return null;
      let b = touchedUsers.get(userId);
      if (!b) {
        b = { kinds: new Set(), orders: [], fills: [], balances: [], positions: [], liquidations: [], funding: [] };
        touchedUsers.set(userId, b);
      }
      b.kinds.add(kind);
      return b;
    };

    for (const e of events) {
      switch (e.kind) {
        case 'trade': {
          let list = tradesByMarket.get(e.trade.marketId);
          if (!list) {
            list = [];
            tradesByMarket.set(e.trade.marketId, list);
          }
          list.push(e.trade);
          this.#dirtyBooks.add(e.trade.marketId);
          touch(e.trade.makerUserId, 'fill')?.fills.push(jsonSafe(e.trade));
          touch(e.trade.takerUserId, 'fill')?.fills.push(jsonSafe(e.trade));
          break;
        }
        case 'orderAccepted':
          this.#dirtyBooks.add(e.order.marketId);
          touch(e.order.userId, 'order')?.orders.push(jsonSafe(e.order));
          break;
        case 'orderCancelled':
          this.#dirtyBooks.add(e.marketId);
          touch(e.userId, 'order')?.orders.push(
            jsonSafe({ id: e.orderId, marketId: e.marketId, status: 'cancelled', remainingQty: e.remainingQty, reason: e.reason }),
          );
          break;
        case 'orderRejected':
          touch(e.userId, 'order')?.orders.push({ rejected: e.code, reason: e.reason });
          break;
        case 'balanceChanged':
          touch(e.userId, 'balance')?.balances.push(
            jsonSafe({ asset: e.asset, available: e.available, locked: e.locked, reason: e.reason }),
          );
          break;
        case 'positionChanged':
          touch(e.userId, 'position')?.positions.push(
            jsonSafe({ marketId: e.marketId, size: e.size, entryPrice: e.entryPrice, leverage: e.leverage, margin: e.margin, realizedPnl: e.realizedPnl }),
          );
          break;
        case 'liquidation':
          touch(e.userId, 'liquidation')?.liquidations.push(
            jsonSafe({ marketId: e.marketId, size: e.size, markPrice: e.markPrice, reason: e.reason }),
          );
          // public tape is ANONYMIZED — market/size/mark/reason only, no userId
          liqs.push({ marketId: e.marketId, size: e.size, markPrice: e.markPrice, reason: e.reason, ts: e.ts });
          break;
        case 'fundingApplied':
          touch(e.userId, 'funding')?.funding.push(
            jsonSafe({ marketId: e.marketId, rate: e.rate, payment: e.payment, markPrice: e.markPrice }),
          );
          break;
        case 'markPrice':
          // keep only the latest mark per market in this batch
          marksByMarket.set(e.marketId, { marketId: e.marketId, price: e.price, ts: e.ts });
          break;
        case 'orderTriggerUpdated':
          // trailing stop ratcheted → ship the new stop so the owner can update
          touch(e.userId, 'order')?.orders.push(jsonSafe({ id: e.orderId, marketId: e.marketId, triggerPrice: e.triggerPrice }));
          break;
      }
    }

    for (const [marketId, mark] of marksByMarket) {
      const wire = jsonSafe(mark);
      this.#marks.set(marketId, wire);
      this.#broadcast(`markPrice:${marketId}`, wire);
    }

    if (liqs.length > 0) {
      const wires = liqs.map((l) => jsonSafe(l));
      this.#liqRing = [...[...wires].reverse(), ...this.#liqRing].slice(0, LIQ_RING);
      this.#broadcast('liquidations', wires);
    }

    for (const [marketId, trades] of tradesByMarket) {
      const wires = trades.map((t) => jsonSafe(t));
      const ring = this.#tradeRing.get(marketId) ?? [];
      ring.unshift(...[...wires].reverse());
      this.#tradeRing.set(marketId, ring.slice(0, TRADE_RING));
      this.#broadcast(`trades:${marketId}`, wires);
    }
    for (const [userId, b] of touchedUsers) {
      // `type` (coalesced kinds) stays for backward compatibility; the entity
      // arrays let a client apply the change without a full refetch
      this.#sendUser(userId, {
        type: [...b.kinds].join(','),
        ...(b.orders.length > 0 ? { orders: b.orders } : {}),
        ...(b.fills.length > 0 ? { fills: b.fills } : {}),
        ...(b.balances.length > 0 ? { balances: b.balances } : {}),
        ...(b.positions.length > 0 ? { positions: b.positions } : {}),
        ...(b.liquidations.length > 0 ? { liquidations: b.liquidations } : {}),
        ...(b.funding.length > 0 ? { funding: b.funding } : {}),
      });
    }
    this.#scheduleBookFlush();
  }

  /** Live ticker from the market-data feeds (spot Upbit / perp HL). */
  publishTicker(t: Ticker): void {
    const wire = jsonSafe(t);
    this.#tickers.set(t.marketId, wire);
    this.#tickerQueue.set(t.marketId, wire);
    this.#broadcast(`ticker:${t.marketId}`, wire);
    if (this.#tickerTimer === null && !this.#closed) {
      this.#tickerTimer = setTimeout(() => {
        this.#tickerTimer = null;
        const batch = [...this.#tickerQueue.values()];
        this.#tickerQueue = new Map();
        if (batch.length > 0) this.#broadcast('allTickers', batch);
      }, TICKER_FLUSH_MS);
      this.#tickerTimer.unref?.();
    }
  }

  getTicker(marketId: string): unknown {
    return this.#tickers.get(marketId);
  }

  /** Current REAL perp funding rate (from Hyperliquid) for a market. */
  publishFunding(info: FundingInfo): void {
    const wire = jsonSafe(info);
    this.#funding.set(info.marketId, wire);
    this.#broadcast(`funding:${info.marketId}`, wire);
  }

  getFunding(marketId: string): unknown {
    return this.#funding.get(marketId);
  }

  allFunding(): unknown[] {
    return [...this.#funding.values()];
  }

  /** Latest mark price (wire form) for a market, if one has been broadcast. */
  getMark(marketId: string): unknown {
    return this.#marks.get(marketId);
  }

  /** Recent anonymized liquidations (most-recent-first) for the public tape. */
  recentLiquidations(): unknown[] {
    return this.#liqRing;
  }

  recentTrades(marketId: string): unknown[] {
    return this.#tradeRing.get(marketId) ?? [];
  }

  /** live connection count (observability / soak tests) */
  get connectionCount(): number {
    return this.#conns.size;
  }

  /** Markets with at least one live orderbook:<mkt> subscriber. */
  subscribedBooks(): Set<string> {
    const out = new Set<string>();
    for (const c of this.#conns) {
      for (const ch of c.channels) {
        if (ch.startsWith('orderbook:')) out.add(ch.slice('orderbook:'.length));
      }
    }
    return out;
  }

  /**
   * A REAL print from the source venue (Upbit/Hyperliquid) — not one of our
   * fills. Streamed into the same trades:<mkt> channel + recent ring so the
   * trades feed reflects the actual market.
   */
  publishExternalTrade(trade: {
    id: string;
    marketId: string;
    price: bigint;
    qty: bigint;
    takerSide: 'buy' | 'sell';
    ts: number;
  }): void {
    const wire = jsonSafe(trade);
    const ring = this.#tradeRing.get(trade.marketId) ?? [];
    ring.unshift(wire);
    this.#tradeRing.set(trade.marketId, ring.slice(0, TRADE_RING));
    this.#broadcast(`trades:${trade.marketId}`, [wire]);
  }

  close(): void {
    this.#closed = true;
    if (this.#bookTimer !== null) clearTimeout(this.#bookTimer);
    if (this.#tickerTimer !== null) clearTimeout(this.#tickerTimer);
    clearInterval(this.#heartbeatTimer);
    for (const c of this.#conns) c.socket.close();
    this.#conns.clear();
  }

  #scheduleBookFlush(): void {
    if (this.#bookTimer !== null || this.#closed || this.#dirtyBooks.size === 0) return;
    this.#bookTimer = setTimeout(() => {
      this.#bookTimer = null;
      const dirty = [...this.#dirtyBooks];
      this.#dirtyBooks.clear();
      for (const marketId of dirty) this.#broadcastBook(marketId);
    }, BOOK_FLUSH_MS);
    this.#bookTimer.unref?.();
  }

  /**
   * Mark a market's source-venue feed stale/live. When stale, the book mirror
   * has taken the book down, so the served depth is NOT live venue data — the
   * `stale` flag on orderbook frames lets clients show it as such rather than
   * presenting a frozen book as live. A transition re-broadcasts immediately.
   */
  setFeedStale(marketId: string, stale: boolean): void {
    const was = this.#staleMarkets.has(marketId);
    if (was === stale) return;
    if (stale) this.#staleMarkets.add(marketId);
    else this.#staleMarkets.delete(marketId);
    this.#broadcastBook(marketId);
  }

  isFeedStale(marketId: string): boolean {
    return this.#staleMarkets.has(marketId);
  }

  #bookData(marketId: string): Record<string, unknown> {
    const snap = this.#engine.getOrderbook(marketId, BOOK_DEPTH);
    return {
      type: 'snapshot',
      stale: this.#staleMarkets.has(marketId),
      ...(jsonSafe(snap) as Record<string, unknown>),
    };
  }

  /** Bump and return the next per-channel frame seq (starts at 1). */
  #nextSeq(channel: string): number {
    const next = (this.#channelSeq.get(channel) ?? 0) + 1;
    this.#channelSeq.set(channel, next);
    return next;
  }

  /** Current per-channel seq (the last value broadcast, or 0 if none yet). */
  #currentSeq(channel: string): number {
    return this.#channelSeq.get(channel) ?? 0;
  }

  #broadcastBook(marketId: string): void {
    const channel = `orderbook:${marketId}`;
    if (![...this.#conns].some((c) => c.channels.has(channel))) return;
    this.#broadcast(channel, this.#bookData(marketId));
  }

  #sendInitial(conn: Conn, channel: string): void {
    if (channel === 'allTickers') {
      const all = [...this.#tickers.values()];
      if (all.length > 0) this.#sendSnapshot(conn, channel, all);
    } else if (channel.startsWith('ticker:')) {
      const t = this.#tickers.get(channel.slice('ticker:'.length));
      if (t !== undefined) this.#sendSnapshot(conn, channel, t);
    } else if (channel.startsWith('orderbook:')) {
      const marketId = channel.slice('orderbook:'.length);
      if (this.#engine.getMarket(marketId)) {
        this.#sendSnapshot(conn, channel, this.#bookData(marketId));
      }
    } else if (channel.startsWith('trades:')) {
      const ring = this.#tradeRing.get(channel.slice('trades:'.length));
      if (ring && ring.length > 0) this.#sendSnapshot(conn, channel, ring);
    } else if (channel.startsWith('funding:')) {
      const f = this.#funding.get(channel.slice('funding:'.length));
      if (f !== undefined) this.#sendSnapshot(conn, channel, f);
    } else if (channel.startsWith('markPrice:')) {
      const mk = this.#marks.get(channel.slice('markPrice:'.length));
      if (mk !== undefined) this.#sendSnapshot(conn, channel, mk);
    } else if (channel === 'liquidations') {
      if (this.#liqRing.length > 0) this.#sendSnapshot(conn, channel, this.#liqRing);
    }
  }

  /**
   * Fresh-snapshot frame for a (re)subscriber: carries the channel's CURRENT
   * per-channel seq (not a new one — this snapshot is not a new broadcast) plus
   * `reset:true` so the client resets its gap-detection baseline rather than
   * treating the jump from its previous seq as a dropped frame.
   */
  #sendSnapshot(conn: Conn, channel: string, data: unknown): void {
    this.#send(conn, { channel, data, seq: this.#currentSeq(channel), reset: true });
  }

  #sendUser(userId: string, data: unknown): void {
    let seq: number | undefined;
    for (const c of this.#conns) {
      if (c.userId === userId && c.channels.has('user')) {
        if (seq === undefined) seq = this.#nextSeq('user');
        this.#send(c, { channel: 'user', data, seq });
      }
    }
  }

  #broadcast(channel: string, data: unknown): void {
    const seq = this.#nextSeq(channel);
    const frame = JSON.stringify({ channel, data, seq });
    for (const c of this.#conns) {
      if (c.channels.has(channel)) {
        try {
          c.socket.send(frame);
        } catch {
          // dropped connection; close event will clean up
        }
      }
    }
  }

  #send(conn: Conn, frame: { channel: string; data: unknown; seq?: number; reset?: boolean }): void {
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {
      // ignore
    }
  }
}
