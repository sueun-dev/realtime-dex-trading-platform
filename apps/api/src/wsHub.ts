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
}

const BOOK_DEPTH = 20;
const BOOK_FLUSH_MS = 80;
const TICKER_FLUSH_MS = 1000;
const TRADE_RING = 60;
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
  #bookTimer: ReturnType<typeof setTimeout> | null = null;
  #tickerTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(engine: Exchange, verifyToken: (token: string) => Promise<string | null>) {
    this.#engine = engine;
    this.#verifyToken = verifyToken;
  }

  register(socket: HubSocket): void {
    const conn: Conn = { socket, channels: new Set(), userId: null };
    this.#conns.add(conn);
    socket.on('message', (raw) => {
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

  close(): void {
    this.#closed = true;
    if (this.#bookTimer !== null) clearTimeout(this.#bookTimer);
    if (this.#tickerTimer !== null) clearTimeout(this.#tickerTimer);
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

  #broadcastBook(marketId: string): void {
    const channel = `orderbook:${marketId}`;
    if (![...this.#conns].some((c) => c.channels.has(channel))) return;
    const snap = this.#engine.getOrderbook(marketId, BOOK_DEPTH);
    const data = { type: 'snapshot', ...(jsonSafe(snap) as Record<string, unknown>) };
    this.#broadcast(channel, data, snap.seq);
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
        const snap = this.#engine.getOrderbook(marketId, BOOK_DEPTH);
        const data = { type: 'snapshot', ...(jsonSafe(snap) as Record<string, unknown>) };
        this.#send(conn, { channel, data, seq: snap.seq });
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
