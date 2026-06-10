import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Side, Ticker } from '@dex/shared';
import type { PublicTrade } from './upbit.js';
import {
  expectBigIntId,
  expectNumber,
  expectObject,
  expectString,
  numToUnits,
  quoteJsonIntegerFields,
} from './util.js';

export const UPBIT_WS_URL = 'wss://api.upbit.com/websocket/v1';

export type UpbitWsFrame =
  | { kind: 'ticker'; ticker: Ticker }
  | { kind: 'trade'; trade: PublicTrade }
  | { kind: 'other' };

/**
 * Parse one Upbit websocket JSON frame, STRICTLY — same rules as the REST
 * parsers: unknown ask_bid rejected (never silently mapped to a side), trade
 * timestamps and sequential_id required (no Date.now()/0 fallbacks), and
 * sequential_id read with full >2^53 precision. Status/keepalive frames map
 * to `{ kind: 'other' }`; malformed data throws.
 */
export function parseUpbitWsFrame(text: string): UpbitWsFrame {
  // sequential_id exceeds 2^53 — re-quote it in the raw text to keep precision
  const msg = expectObject(JSON.parse(quoteJsonIntegerFields(text, ['sequential_id'])), 'Upbit WS frame');
  const type = msg['type'];
  if (type === 'ticker') {
    const ctx = 'Upbit WS ticker';
    const ticker: Ticker = {
      marketId: expectString(msg['code'], 'code', ctx),
      price: numToUnits(msg['trade_price'], 'trade_price'),
      change24h: numToUnits(msg['signed_change_rate'], 'signed_change_rate'),
      high24h: numToUnits(msg['high_price'], 'high_price'),
      low24h: numToUnits(msg['low_price'], 'low_price'),
      volume24h: numToUnits(msg['acc_trade_price_24h'], 'acc_trade_price_24h'),
      ts: expectNumber(msg['timestamp'], 'timestamp', ctx),
    };
    return { kind: 'ticker', ticker };
  }
  if (type === 'trade') {
    const ctx = 'Upbit WS trade';
    const askBid = expectString(msg['ask_bid'], 'ask_bid', ctx);
    if (askBid !== 'ASK' && askBid !== 'BID') {
      throw new Error(`${ctx}: unexpected ask_bid ${JSON.stringify(askBid)}`);
    }
    const side: Side = askBid === 'BID' ? 'buy' : 'sell';
    const trade: PublicTrade = {
      marketId: expectString(msg['code'], 'code', ctx),
      price: numToUnits(msg['trade_price'], 'trade_price'),
      qty: numToUnits(msg['trade_volume'], 'trade_volume'),
      side,
      ts: expectNumber(msg['trade_timestamp'], 'trade_timestamp', ctx),
      sequentialId: expectBigIntId(msg['sequential_id'], 'sequential_id', ctx),
    };
    return { kind: 'trade', trade };
  }
  return { kind: 'other' }; // status/keepalive frames
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export interface UpbitWsOptions {
  url?: string;
}

/**
 * Upbit public websocket: subscribes ticker + trade for the given codes.
 * Emits:
 *  - 'ticker' (Ticker)
 *  - 'trade' (PublicTrade)
 *  - 'open' / 'close' / 'wsError' (Error) — informational
 * Auto-reconnects with capped exponential backoff and resubscribes.
 * `close()` is final: no further reconnects.
 */
export class UpbitWs extends EventEmitter {
  readonly #codes: string[];
  readonly #url: string;
  #ws: WebSocket | null = null;
  #closed = false;
  #attempts = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(codes: string[], opts: UpbitWsOptions = {}) {
    super();
    this.#codes = [...codes];
    this.#url = opts.url ?? UPBIT_WS_URL;
  }

  connect(): void {
    if (this.#closed || this.#ws) return;
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.on('open', () => {
      this.#attempts = 0;
      ws.send(
        JSON.stringify([
          { ticket: 'dex' },
          { type: 'ticker', codes: this.#codes },
          { type: 'trade', codes: this.#codes },
        ]),
      );
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
      this.#ws = null;
      this.emit('close');
      this.#scheduleReconnect();
    });
  }

  close(): void {
    this.#closed = true;
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

  #handleMessage(data: WebSocket.RawData): void {
    // Upbit sends binary frames containing UTF-8 JSON.
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    const frame = parseUpbitWsFrame(text); // throws on malformed frames → wsError
    if (frame.kind === 'ticker') this.emit('ticker', frame.ticker);
    else if (frame.kind === 'trade') this.emit('trade', frame.trade);
  }
}
