import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { numToUnits } from './util.js';

export const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export interface HyperliquidWsOptions {
  url?: string;
}

/**
 * Hyperliquid public websocket: subscribes allMids.
 * Emits:
 *  - 'mids' (Map<string, bigint>) — coin → mid, 1e8 units, '@'/'#' keys skipped
 *  - 'open' / 'close' / 'wsError' (Error)
 * Auto-reconnects with capped exponential backoff (1s,2s,4s..30s) and
 * resubscribes; sends {"method":"ping"} every 30s. `close()` is final.
 */
export class HyperliquidWs extends EventEmitter {
  readonly #url: string;
  #ws: WebSocket | null = null;
  #closed = false;
  #attempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;

  constructor(opts: HyperliquidWsOptions = {}) {
    super();
    this.#url = opts.url ?? HYPERLIQUID_WS_URL;
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.on('open', () => {
      this.#attempts = 0;
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
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
    if (msg['channel'] !== 'allMids') return; // pong / subscriptionResponse / etc.
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
  }
}
