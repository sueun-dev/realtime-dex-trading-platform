import {
  CLEARING_ACCOUNT,
  FEE_ACCOUNT,
  jsonSafe,
  type EngineEvent,
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
/** heartbeat: ping each conn every interval; reap any that didn't speak since the last */
const HEARTBEAT_MS = 30_000;
const INTERNAL_ACCOUNTS = new Set([FEE_ACCOUNT, CLEARING_ACCOUNT]);

/**
 * WebSocket hub for the /ws contract:
 *   in : {op:'subscribe'|'unsubscribe', channel} | {op:'auth', token} | {op:'ping'}
 *   out: {channel, data, seq}
 * Channels: allTickers, ticker:<mkt>, orderbook:<mkt>, trades:<mkt>, user.
 * Orderbook frames are throttled full snapshots ({type:'snapshot'}).
 */
export class WsHub implements EventSink {
  readonly #conns = new Set<Conn>();
  readonly #engine: Exchange;
  readonly #verifyToken: (token: string) => Promise<string | null>;
  readonly #tradeRing = new Map<string, unknown[]>();
  readonly #tickers = new Map<string, unknown>();
  #tickerQueue = new Map<string, unknown>();
  readonly #dirtyBooks = new Set<string>();
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
    const touchedUsers = new Map<string, Set<string>>(); // userId -> event kinds
    const touch = (userId: string, kind: string): void => {
      if (INTERNAL_ACCOUNTS.has(userId)) return;
      let set = touchedUsers.get(userId);
      if (!set) {
        set = new Set();
        touchedUsers.set(userId, set);
      }
      set.add(kind);
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
          touch(e.trade.makerUserId, 'fill');
          touch(e.trade.takerUserId, 'fill');
          break;
        }
        case 'orderAccepted':
          this.#dirtyBooks.add(e.order.marketId);
          touch(e.order.userId, 'order');
          break;
        case 'orderCancelled':
          this.#dirtyBooks.add(e.marketId);
          touch(e.userId, 'order');
          break;
        case 'orderRejected':
          touch(e.userId, 'order');
          break;
        case 'balanceChanged':
          touch(e.userId, 'balance');
          break;
        case 'positionChanged':
          touch(e.userId, 'position');
          break;
        case 'liquidation':
          touch(e.userId, 'liquidation');
          break;
        case 'fundingApplied':
          touch(e.userId, 'funding');
          break;
        case 'markPrice':
          break;
      }
    }

    for (const [marketId, trades] of tradesByMarket) {
      const wires = trades.map((t) => jsonSafe(t));
      const ring = this.#tradeRing.get(marketId) ?? [];
      ring.unshift(...[...wires].reverse());
      this.#tradeRing.set(marketId, ring.slice(0, TRADE_RING));
      this.#broadcast(`trades:${marketId}`, wires);
    }
    for (const [userId, kinds] of touchedUsers) {
      this.#sendUser(userId, { type: [...kinds].join(',') });
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

  #broadcastBook(marketId: string): void {
    const channel = `orderbook:${marketId}`;
    if (![...this.#conns].some((c) => c.channels.has(channel))) return;
    const data = this.#bookData(marketId);
    this.#broadcast(channel, data, data['seq'] as number);
  }

  #sendInitial(conn: Conn, channel: string): void {
    if (channel === 'allTickers') {
      const all = [...this.#tickers.values()];
      if (all.length > 0) this.#send(conn, { channel, data: all });
    } else if (channel.startsWith('ticker:')) {
      const t = this.#tickers.get(channel.slice('ticker:'.length));
      if (t !== undefined) this.#send(conn, { channel, data: t });
    } else if (channel.startsWith('orderbook:')) {
      const marketId = channel.slice('orderbook:'.length);
      if (this.#engine.getMarket(marketId)) {
        const data = this.#bookData(marketId);
        this.#send(conn, { channel, data, seq: data['seq'] as number });
      }
    } else if (channel.startsWith('trades:')) {
      const ring = this.#tradeRing.get(channel.slice('trades:'.length));
      if (ring && ring.length > 0) this.#send(conn, { channel, data: ring });
    }
  }

  #sendUser(userId: string, data: unknown): void {
    for (const c of this.#conns) {
      if (c.userId === userId && c.channels.has('user')) {
        this.#send(c, { channel: 'user', data });
      }
    }
  }

  #broadcast(channel: string, data: unknown, seq?: number): void {
    const frame = JSON.stringify(seq === undefined ? { channel, data } : { channel, data, seq });
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

  #send(conn: Conn, frame: { channel: string; data: unknown; seq?: number }): void {
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {
      // ignore
    }
  }
}
