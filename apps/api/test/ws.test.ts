import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { toUnits } from '@dex/shared';
import {
  TEST_SPOT,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_SPOT.id;

let t: TestApp;
let base = '';
let alice: TestUser;
let bob: TestUser;

interface Frame {
  channel: string;
  data: unknown;
  seq?: number;
}

class WsProbe {
  readonly frames: Frame[] = [];
  readonly ws: WebSocket;
  #open: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.#open = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (raw) => {
      this.frames.push(JSON.parse(String(raw)) as Frame);
    });
  }

  async ready(): Promise<void> {
    await this.#open;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait until a frame matching the predicate exists (checks history too). */
  async waitFor(pred: (f: Frame) => boolean, timeoutMs = 4000): Promise<Frame> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout; saw ${JSON.stringify(this.frames.map((f) => f.channel))}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  close(): void {
    this.ws.close();
  }
}

beforeAll(async () => {
  t = await makeApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `ws://127.0.0.1:${addr.port}/ws`;
  alice = await loginAndFund(t.app);
  bob = await loginAndFund(t.app);
  await t.svc.pipeline.exec(() => t.svc.engine.deposit(alice.address, 'TBT', u(10), Date.now()));
});
afterAll(async () => {
  await t.stop();
});

describe('websocket hub', () => {
  it('orderbook subscribe gets an immediate snapshot, then live updates on fills', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `orderbook:${M}`, market: M });
    const initial = await probe.waitFor((f) => f.channel === `orderbook:${M}`);
    expect(initial.data).toMatchObject({ type: 'snapshot', bids: [], asks: [] });

    await placeOrder(t.app, alice, {
      marketId: M,
      side: 'sell',
      type: 'limit',
      price: '10000000',
      qty: '0.5',
      tif: 'GTC',
    });
    const withAsk = await probe.waitFor((f) => {
      if (f.channel !== `orderbook:${M}`) return false;
      const d = f.data as { asks: { price: string; qty: string }[] };
      return d.asks.length === 1 && d.asks[0]!.qty === '0.5';
    });
    expect((withAsk.data as { asks: unknown[] }).asks).toEqual([
      { price: '10000000', qty: '0.5' },
    ]);
    probe.close();
  });

  it('trades + authed user channels deliver fill events to both sides', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'auth', token: bob.token });
    probe.send({ op: 'subscribe', channel: `trades:${M}`, market: M });
    probe.send({ op: 'subscribe', channel: 'user' });
    await new Promise((r) => setTimeout(r, 100)); // let auth land

    const res = await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '10000000',
      qty: '0.2',
      tif: 'GTC',
    });
    expect(res.statusCode).toBe(200);

    const tradeFrame = await probe.waitFor((f) => f.channel === `trades:${M}`);
    const trades = tradeFrame.data as { price: string; qty: string; takerSide: string }[];
    expect(trades[0]).toMatchObject({ price: '10000000', qty: '0.2', takerSide: 'buy' });

    const userFrame = await probe.waitFor((f) => f.channel === 'user');
    expect(typeof (userFrame.data as { type: string }).type).toBe('string');
    probe.close();
  });

  it('late trades subscriber receives the recent-trades ring', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `trades:${M}`, market: M });
    const frame = await probe.waitFor((f) => f.channel === `trades:${M}`);
    expect((frame.data as unknown[]).length).toBeGreaterThanOrEqual(1);
    probe.close();
  });

  it('ticker + allTickers broadcast from the price cache', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `ticker:${M}`, market: M });
    probe.send({ op: 'subscribe', channel: 'allTickers' });

    t.svc.priceCache.setTicker({
      marketId: M,
      price: toUnits('10050000'),
      change24h: toUnits('0.012'),
      high24h: toUnits('10100000'),
      low24h: toUnits('9900000'),
      volume24h: toUnits('123456789'),
      ts: Date.now(),
    });

    const tick = await probe.waitFor((f) => f.channel === `ticker:${M}`);
    expect(tick.data).toMatchObject({ marketId: M, price: '10050000', change24h: '0.012' });
    const all = await probe.waitFor((f) => f.channel === 'allTickers');
    expect(Array.isArray(all.data)).toBe(true);
    probe.close();
  });

  it('external venue prints stream into trades:<mkt> and seed the ring', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `trades:${M}`, market: M });
    t.svc.hub.publishExternalTrade({
      id: 'u1234567890',
      marketId: M,
      price: toUnits('10050000'),
      qty: toUnits('0.025'),
      takerSide: 'sell',
      ts: Date.now(),
    });
    const frame = await probe.waitFor((f) => {
      if (f.channel !== `trades:${M}`) return false;
      return (f.data as { id?: string }[]).some((x) => x.id === 'u1234567890');
    });
    const print = (frame.data as { id: string; price: string; qty: string; takerSide: string }[]).find(
      (x) => x.id === 'u1234567890',
    )!;
    expect(print).toMatchObject({ price: '10050000', qty: '0.025', takerSide: 'sell' });

    // late subscriber gets it from the ring
    const late = new WsProbe(base);
    await late.ready();
    late.send({ op: 'subscribe', channel: `trades:${M}`, market: M });
    const seeded = await late.waitFor((f) => f.channel === `trades:${M}`);
    expect((seeded.data as { id?: string }[]).some((x) => x.id === 'u1234567890')).toBe(true);
    probe.close();
    late.close();
  });

  it('unauthenticated sockets never receive user frames', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: 'user' });
    await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '9000000',
      qty: '0.001',
      tif: 'GTC',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(probe.frames.filter((f) => f.channel === 'user')).toEqual([]);
    probe.close();
  });
});
