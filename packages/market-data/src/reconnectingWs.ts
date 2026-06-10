import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** a connection only counts as healthy (backoff reset) after surviving this long */
const STABLE_AFTER_MS = 5_000;

/**
 * Shared lifecycle for venue websocket clients: capped exponential backoff
 * (1s,2s,4s..30s) that only resets after the connection proves stable —
 * a server that accepts-then-drops keeps escalating instead of hot-looping —
 * plus optional keepalive pings and binary→UTF-8 normalization.
 * Emits 'open' / 'close' / 'wsError' (Error). `close()` is final.
 */
export abstract class ReconnectingWs extends EventEmitter {
  readonly #url: string;
  readonly #pingMs: number | null;
  #ws: WebSocket | null = null;
  #closed = false;
  #attempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;

  protected constructor(url: string, opts: { pingMs?: number } = {}) {
    super();
    this.#url = url;
    this.#pingMs = opts.pingMs ?? null;
  }

  /** Send venue-specific subscriptions; called on every (re)connect. */
  protected abstract onSocketOpen(ws: WebSocket): void;
  /** Handle one UTF-8 text frame; may throw (surfaces as 'wsError'). */
  protected abstract handleText(text: string): void;
  /** Venue keepalive (only used when pingMs was configured). */
  protected sendPing(ws: WebSocket): void {
    ws.ping();
  }

  /** Send a JSON frame if currently connected. */
  protected sendJson(frame: unknown): boolean {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.on('open', () => {
      // only a connection that survives STABLE_AFTER_MS resets the backoff
      this.#stableTimer = setTimeout(() => {
        this.#attempts = 0;
      }, STABLE_AFTER_MS);
      this.#stableTimer.unref?.();
      this.onSocketOpen(ws);
      if (this.#pingMs !== null) this.#startPing(ws);
      this.emit('open');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.handleText(rawToText(data));
      } catch (err) {
        this.#emitError(err as Error);
      }
    });

    ws.on('error', (err: Error) => {
      this.#emitError(err);
    });

    ws.on('close', () => {
      this.#teardownTimers();
      this.#ws = null;
      this.emit('close');
      this.#scheduleReconnect();
    });
  }

  close(): void {
    this.#closed = true;
    this.#teardownTimers();
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

  #teardownTimers(): void {
    if (this.#stableTimer) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    }
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #startPing(ws: WebSocket): void {
    this.#pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) this.sendPing(ws);
    }, this.#pingMs!);
    this.#pingTimer.unref?.();
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
    // 'error' with no listener crashes the process — only emit when someone listens.
    if (this.listenerCount('wsError') > 0) this.emit('wsError', err);
  }
}

function rawToText(data: WebSocket.RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8');
}
