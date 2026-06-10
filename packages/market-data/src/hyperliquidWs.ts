import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { BookLevel, Side } from '@dex/shared';
import { expectArray, expectNumber, expectObject, expectString, numToUnits } from './util.js';

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export interface HlTrade {
  coin: string;
  price: bigint;
  qty: bigint;
  /** aggressor side */
  side: Side;
  ts: number;
  tid: string;
}

export interface HlL2Book {
  coin: string;
  /** descending price */
  bids: BookLevel[];
  /** ascending price */
  asks: BookLevel[];
  ts: number;
}

export interface HyperliquidWsOptions {
  url?: string;
  /** coins to stream real trades for (e.g. ['BTC','ETH']) */
  tradeCoins?: string[];
  /** coins to stream the real L2 orderbook for */
  l2Coins?: string[];
}

/**
 * Hyperliquid public websocket: subscribes allMids plus optional per-coin
 * trades / l2Book streams. Emits:
 *  - 'mids' (Map<string, bigint>) — coin → mid, 1e8 units, '@'/'#' keys skipped
 *  - 'trades' (HlTrade[]) — real venue prints
 *  - 'l2book' (HlL2Book) — real venue depth, prices AND sizes
 *  - 'open' / 'close' / 'wsError' (Error)
 * `setL2Coins`/`setTradeCoins` adjust subscriptions live (diff-based).
 * Auto-reconnects with capped exponential backoff (1s,2s,4s..30s) and
 * resubscribes; sends {"method":"ping"} every 30s. `close()` is final.
 */
export class HyperliquidWs extends EventEmitter {
  readonly #url: string;
  #tradeCoins: Set<string>;
  #l2Coins: Set<string>;
  #ws: WebSocket | null = null;
  #closed = false;
  #attempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;

  constructor(opts: HyperliquidWsOptions = {}) {
    super();
    this.#url = opts.url ?? HYPERLIQUID_WS_URL;
    this.#tradeCoins = new Set(opts.tradeCoins ?? []);
    this.#l2Coins = new Set(opts.l2Coins ?? []);
  }

  #send(method: 'subscribe' | 'unsubscribe', subscription: Record<string, string>): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ method, subscription }));
    }
  }

  setL2Coins(coins: string[]): void {
    const next = new Set(coins);
    for (const c of this.#l2Coins) if (!next.has(c)) this.#send('unsubscribe', { type: 'l2Book', coin: c });
    for (const c of next) if (!this.#l2Coins.has(c)) this.#send('subscribe', { type: 'l2Book', coin: c });
    this.#l2Coins = next;
  }

  setTradeCoins(coins: string[]): void {
    const next = new Set(coins);
    for (const c of this.#tradeCoins) if (!next.has(c)) this.#send('unsubscribe', { type: 'trades', coin: c });
    for (const c of next) if (!this.#tradeCoins.has(c)) this.#send('subscribe', { type: 'trades', coin: c });
    this.#tradeCoins = next;
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.on('open', () => {
      this.#attempts = 0;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      for (const coin of this.#tradeCoins) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      }
      for (const coin of this.#l2Coins) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
      }
      this.#startPing(ws);
      this.emit('open');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.#handleMessage(data);
      } catch (err) {
        this.#emitError(err as Error);
      }
    });

    ws.on('error', (err: Error) => {
      this.#emitError(err);
    });

    ws.on('close', () => {
      this.#stopPing();
      this.#ws = null;
      this.emit('close');
      this.#scheduleReconnect();
    });
  }

  close(): void {
    this.#closed = true;
    this.#stopPing();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#ws) {
      this.#ws.removeAllListeners('close');
      this.#ws.once('error', () => {
        /* swallow teardown errors */
      });
      this.#ws.terminate();
      this.#ws = null;
    }
  }

  #startPing(ws: WebSocket): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      }
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref?.();
  }

  #stopPing(): void {
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.#attempts);
    this.#attempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #emitError(err: Error): void {
    if (this.listenerCount('wsError') > 0) this.emit('wsError', err);
  }

  #handleMessage(data: WebSocket.RawData): void {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    const msg = JSON.parse(text) as Record<string, unknown>;
    const channel = msg['channel'];
    if (channel === 'allMids') {
      const payload = msg['data'];
      if (payload === null || typeof payload !== 'object') return;
      const rawMids = (payload as Record<string, unknown>)['mids'];
      if (rawMids === null || typeof rawMids !== 'object') return;
      const mids = new Map<string, bigint>();
      for (const [coin, raw] of Object.entries(rawMids as Record<string, unknown>)) {
        if (coin.startsWith('@') || coin.startsWith('#')) continue;
        mids.set(coin, numToUnits(raw, `mids[${coin}]`));
      }
      this.emit('mids', mids);
    } else if (channel === 'trades') {
      this.emit('trades', parseHlTrades(msg['data']));
    } else if (channel === 'l2Book') {
      this.emit('l2book', parseHlL2Book(msg['data']));
    }
    // pong / subscriptionResponse / etc. are ignored
  }
}

/** Strict parse of a Hyperliquid `trades` payload (real venue prints). */
export function parseHlTrades(data: unknown): HlTrade[] {
  const ctx = 'Hyperliquid WS trades';
  return expectArray(data, ctx).map((item, i) => {
    const o = expectObject(item, `${ctx}[${i}]`);
    const rawSide = expectString(o['side'], 'side', `${ctx}[${i}]`);
    if (rawSide !== 'A' && rawSide !== 'B') {
      throw new Error(`${ctx}[${i}]: unexpected side ${JSON.stringify(rawSide)}`);
    }
    return {
      coin: expectString(o['coin'], 'coin', `${ctx}[${i}]`),
      price: numToUnits(o['px'], 'px'),
      qty: numToUnits(o['sz'], 'sz'),
      side: rawSide === 'B' ? ('buy' as const) : ('sell' as const),
      ts: expectNumber(o['time'], 'time', `${ctx}[${i}]`),
      tid: String(o['tid']),
    };
  });
}

/** Strict parse of a Hyperliquid `l2Book` payload (real venue depth). */
export function parseHlL2Book(data: unknown): HlL2Book {
  const ctx = 'Hyperliquid WS l2Book';
  const o = expectObject(data, ctx);
  const levels = expectArray(o['levels'], `${ctx}.levels`);
  if (levels.length !== 2) throw new Error(`${ctx}.levels: expected [bids, asks]`);
  const parseSide = (raw: unknown, name: string): BookLevel[] =>
    expectArray(raw, `${ctx}.${name}`).map((lvl, i) => {
      const l = expectObject(lvl, `${ctx}.${name}[${i}]`);
      return { price: numToUnits(l['px'], 'px'), qty: numToUnits(l['sz'], 'sz') };
    });
  const bids = parseSide(levels[0], 'bids');
  const asks = parseSide(levels[1], 'asks');
  bids.sort((a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1));
  asks.sort((a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1));
  return {
    coin: expectString(o['coin'], 'coin', ctx),
    bids,
    asks,
    ts: expectNumber(o['time'], 'time', ctx),
  };
}
