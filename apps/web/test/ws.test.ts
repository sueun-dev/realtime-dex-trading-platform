import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '../src/lib/ws.js';
import type { WsStatus } from '../src/lib/ws.js';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  // test helpers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function frames(sock: MockWebSocket): unknown[] {
  return sock.sent.map((s) => JSON.parse(s));
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WsClient', () => {
  it('sends ref-counted subscribe/unsubscribe frames and routes messages by channel', () => {
    const client = new WsClient('ws://test/ws');
    expect(MockWebSocket.instances).toHaveLength(1);
    const sock = MockWebSocket.instances[0]!;
    expect(sock.url).toBe('ws://test/ws');

    const h1 = vi.fn();
    const h2 = vi.fn();
    const other = vi.fn();
    const un1 = client.subscribe('orderbook:KRW-BTC', h1);
    expect(sock.sent).toHaveLength(0); // socket not open yet — frame deferred to onopen

    sock.open();
    expect(frames(sock)).toEqual([{ op: 'subscribe', channel: 'orderbook:KRW-BTC', market: 'KRW-BTC' }]);

    const un2 = client.subscribe('orderbook:KRW-BTC', h2);
    expect(sock.sent).toHaveLength(1); // ref-counted: no duplicate subscribe frame
    client.subscribe('trades:KRW-BTC', other);
    expect(sock.sent).toHaveLength(2);

    sock.message({ channel: 'orderbook:KRW-BTC', data: { bids: [], asks: [] }, seq: 7 });
    expect(h1).toHaveBeenCalledWith({ bids: [], asks: [] }, 7);
    expect(h2).toHaveBeenCalledWith({ bids: [], asks: [] }, 7);
    expect(other).not.toHaveBeenCalled();

    un1();
    expect(sock.sent).toHaveLength(2); // one subscriber remains → no unsubscribe yet
    un2();
    expect(frames(sock).at(-1)).toEqual({ op: 'unsubscribe', channel: 'orderbook:KRW-BTC', market: 'KRW-BTC' });
    const count = sock.sent.length;
    un2(); // idempotent
    expect(sock.sent).toHaveLength(count);

    client.destroy();
  });

  it('omits the market field for non-market channels', () => {
    const client = new WsClient('ws://test/ws');
    const sock = MockWebSocket.instances[0]!;
    sock.open();
    client.subscribe('allTickers', vi.fn());
    expect(frames(sock)[0]).toEqual({ op: 'subscribe', channel: 'allTickers' });
    client.destroy();
  });

  it('sends the auth frame after open and re-auths + resubscribes on reconnect', () => {
    const client = new WsClient('ws://test/ws', { minBackoffMs: 500 });
    const sock1 = MockWebSocket.instances[0]!;
    client.auth('tkn'); // before open: stored, sent on open
    expect(sock1.sent).toHaveLength(0);

    sock1.open();
    expect(frames(sock1)[0]).toEqual({ op: 'auth', token: 'tkn' });
    client.subscribe('trades:KRW-BTC', vi.fn());

    // drop the connection → reconnect after the initial 500ms backoff
    sock1.close();
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    const sock2 = MockWebSocket.instances[1]!;
    sock2.open();
    // full resubscribe with auth first
    expect(frames(sock2)).toEqual([
      { op: 'auth', token: 'tkn' },
      { op: 'subscribe', channel: 'trades:KRW-BTC', market: 'KRW-BTC' },
    ]);

    client.destroy();
  });

  it('backs off exponentially while the connection keeps failing', () => {
    const client = new WsClient('ws://test/ws', { minBackoffMs: 500 });
    const sock1 = MockWebSocket.instances[0]!;
    sock1.open();

    sock1.close(); // attempt 0 → 500ms
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1]!.close(); // never opened: attempt 1 → 1000ms
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    MockWebSocket.instances[2]!.close(); // attempt 2 → 2000ms
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);

    client.destroy();
  });

  it('emits status events and stops reconnecting after destroy', () => {
    const client = new WsClient('ws://test/ws');
    const sock = MockWebSocket.instances[0]!;
    const statuses: WsStatus[] = [];
    client.onStatus((s) => statuses.push(s));

    sock.open();
    sock.close();
    expect(statuses).toEqual(['open', 'closed']);

    vi.advanceTimersByTime(500);
    const countAfterReconnect = MockWebSocket.instances.length;
    expect(countAfterReconnect).toBe(2);

    client.destroy();
    MockWebSocket.instances[1]!.open();
    MockWebSocket.instances[1]!.close();
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2); // destroyed → no further sockets
  });
});
