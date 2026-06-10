/** OFFLINE Upbit WS tests — strict frame parsing + reconnect against a local in-process server. */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { Ticker } from '@dex/shared';
import type { PublicTrade } from '../src/upbit.js';
import { UpbitWs, parseUpbitWsFrame } from '../src/upbitWs.js';

/** Real Upbit WS ticker frame shape (values from the 2026-06-10 REST capture). */
const TICKER_FRAME =
  '{"type":"ticker","code":"KRW-BTC","opening_price":92555000.0,"high_price":93848000.0,' +
  '"low_price":91500000.0,"trade_price":93151000.0,"signed_change_rate":0.0064394144,' +
  '"acc_trade_price_24h":128096613472.80703,"timestamp":1781102448112,"stream_type":"REALTIME"}';

/** Real Upbit WS trade frame shape — sequential_id deliberately odd and > 2^53. */
const TRADE_FRAME =
  '{"type":"trade","code":"KRW-BTC","trade_price":93089000.0,"trade_volume":0.00184778,' +
  '"ask_bid":"ASK","trade_timestamp":1781102449702,"timestamp":1781102449750,' +
  '"sequential_id":17811024497020001,"stream_type":"REALTIME"}';

async function waitUntil(cond: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('parseUpbitWsFrame — strict, same rules as the REST parsers', () => {
  it('parses a ticker frame to exact bigints with the wire timestamp', () => {
    const frame = parseUpbitWsFrame(TICKER_FRAME);
    expect(frame.kind).toBe('ticker');
    if (frame.kind !== 'ticker') throw new Error('unreachable');
    expect(frame.ticker.marketId).toBe('KRW-BTC');
    expect(frame.ticker.price).toBe(9315100000000000n);
    expect(frame.ticker.change24h).toBe(643941n); // truncated to 8 dp
    expect(frame.ticker.high24h).toBe(9384800000000000n);
    expect(frame.ticker.low24h).toBe(9150000000000000n);
    expect(frame.ticker.volume24h).toBe(12809661347280704000n);
    expect(frame.ticker.ts).toBe(1781102448112);
  });

  it('parses a trade frame, preserving sequential_id beyond 2^53 exactly', () => {
    const frame = parseUpbitWsFrame(TRADE_FRAME);
    expect(frame.kind).toBe('trade');
    if (frame.kind !== 'trade') throw new Error('unreachable');
    expect(frame.trade.marketId).toBe('KRW-BTC');
    expect(frame.trade.price).toBe(9308900000000000n);
    expect(frame.trade.qty).toBe(184778n);
    expect(frame.trade.side).toBe('sell'); // ASK = taker sold
    expect(frame.trade.ts).toBe(1781102449702); // trade_timestamp, not server timestamp
    expect(frame.trade.sequentialId).toBe(17811024497020001n); // odd → a double would give ...020000
  });

  it('rejects unknown ask_bid instead of silently mapping it to sell', () => {
    expect(() => parseUpbitWsFrame(TRADE_FRAME.replace('"ASK"', '"WAT"'))).toThrow(/ask_bid/);
  });

  it('rejects a trade frame missing trade_timestamp (no Date.now() fallback)', () => {
    expect(() => parseUpbitWsFrame(TRADE_FRAME.replace('"trade_timestamp":1781102449702,', ''))).toThrow(
      /trade_timestamp/,
    );
  });

  it('rejects a trade frame missing sequential_id (no 0 fallback)', () => {
    expect(() => parseUpbitWsFrame(TRADE_FRAME.replace(',"sequential_id":17811024497020001', ''))).toThrow(
      /sequential_id/,
    );
  });

  it('rejects a ticker frame missing timestamp (no Date.now() fallback)', () => {
    expect(() => parseUpbitWsFrame(TICKER_FRAME.replace('"timestamp":1781102448112,', ''))).toThrow(/timestamp/);
  });

  it('passes through status/keepalive frames as other', () => {
    expect(parseUpbitWsFrame('{"status":"UP"}')).toEqual({ kind: 'other' });
  });

  it('orderbook frames are parsed strictly now — malformed ones throw', () => {
    expect(() => parseUpbitWsFrame('{"type":"orderbook","code":"KRW-BTC"}')).toThrow(/orderbook/);
  });
});

describe('UpbitWs (offline, local server)', () => {
  let server: WebSocketServer | undefined;

  afterEach(async () => {
    if (server) {
      const s = server;
      server = undefined;
      for (const c of s.clients) c.terminate();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it(
    'subscribes, emits parsed frames, surfaces bad frames as wsError, reconnects after a drop, and close() is final',
    async () => {
      server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      await new Promise<void>((r) => server!.once('listening', () => r()));
      const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const sockets: ServerSocket[] = [];
      const subs: unknown[] = [];
      server.on('connection', (sock) => {
        sockets.push(sock);
        sock.on('message', (raw) => subs.push(JSON.parse(String(raw))));
      });

      const client = new UpbitWs(['KRW-BTC'], { url });
      const tickers: Ticker[] = [];
      const trades: PublicTrade[] = [];
      const errors: Error[] = [];
      client.on('ticker', (t: Ticker) => tickers.push(t));
      client.on('trade', (t: PublicTrade) => trades.push(t));
      client.on('wsError', (e: Error) => errors.push(e));
      try {
        client.connect();
        await waitUntil(() => subs.length === 1, 5_000, 'initial subscribe');
        expect(subs[0]).toEqual([
          { ticket: 'dex' },
          { type: 'ticker', codes: ['KRW-BTC'] },
          { type: 'trade', codes: ['KRW-BTC'] },
        ]);

        // Upbit sends binary frames containing UTF-8 JSON.
        sockets[0]!.send(Buffer.from(TICKER_FRAME, 'utf8'));
        sockets[0]!.send(Buffer.from(TRADE_FRAME, 'utf8'));
        sockets[0]!.send(Buffer.from(TRADE_FRAME.replace('"ASK"', '"WAT"'), 'utf8')); // malformed → wsError
        await waitUntil(
          () => tickers.length === 1 && trades.length === 1 && errors.length === 1,
          5_000,
          'parsed frames + wsError',
        );
        expect(tickers[0]!.price).toBe(9315100000000000n);
        expect(trades[0]!.sequentialId).toBe(17811024497020001n); // full precision over the socket too
        expect(errors[0]!.message).toMatch(/ask_bid/);

        // Server drops the connection → client reconnects (1s backoff) and resubscribes.
        sockets[0]!.close();
        await waitUntil(() => subs.length === 2, 10_000, 'resubscribe after reconnect');
        expect(sockets.length).toBe(2);
        expect(subs[1]).toEqual(subs[0]);

        // close() is final: no further reconnect even after the server drops us again.
        client.close();
        await new Promise((r) => setTimeout(r, 1_300)); // > 1s backoff window
        expect(sockets.length).toBe(2);
      } finally {
        client.close();
      }
    },
    20_000,
  );
});
