import type WebSocket from 'ws';
import type { BookLevel, Side } from '@dex/shared';
import { ReconnectingWs } from './reconnectingWs.js';
import { expectArray, expectNumber, expectObject, expectString, numToUnits } from './util.js';

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

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
export class HyperliquidWs extends ReconnectingWs {
  #tradeCoins: Set<string>;
  #l2Coins: Set<string>;

  constructor(opts: HyperliquidWsOptions = {}) {
    super(opts.url ?? HYPERLIQUID_WS_URL, { pingMs: PING_INTERVAL_MS });
    this.#tradeCoins = new Set(opts.tradeCoins ?? []);
    this.#l2Coins = new Set(opts.l2Coins ?? []);
  }

  /** Hyperliquid keepalive is an application-level JSON frame. */
  protected override sendPing(ws: WebSocket): void {
    ws.send(JSON.stringify({ method: 'ping' }));
  }

  #sub(method: 'subscribe' | 'unsubscribe', subscription: Record<string, string>): void {
    this.sendJson({ method, subscription });
  }

  setL2Coins(coins: string[]): void {
    const next = new Set(coins);
    for (const c of this.#l2Coins) if (!next.has(c)) this.#sub('unsubscribe', { type: 'l2Book', coin: c });
    for (const c of next) if (!this.#l2Coins.has(c)) this.#sub('subscribe', { type: 'l2Book', coin: c });
    this.#l2Coins = next;
  }

  setTradeCoins(coins: string[]): void {
    const next = new Set(coins);
    for (const c of this.#tradeCoins) if (!next.has(c)) this.#sub('unsubscribe', { type: 'trades', coin: c });
    for (const c of next) if (!this.#tradeCoins.has(c)) this.#sub('subscribe', { type: 'trades', coin: c });
    this.#tradeCoins = next;
  }

  protected override onSocketOpen(ws: WebSocket): void {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
    for (const coin of this.#tradeCoins) {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
    }
    for (const coin of this.#l2Coins) {
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
    }
  }

  protected override handleText(text: string): void {
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
