import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { toUnits } from '@dex/shared';
import {
  TEST_PERP,
  TEST_SPOT,
  authed,
  loginAndFund,
  makeApp,
  placeOrder,
  u,
  type TestApp,
  type TestUser,
} from './helpers.js';

const M = TEST_SPOT.id;
const M2 = TEST_PERP.id;

let t: TestApp;
let base = '';
let alice: TestUser;
let bob: TestUser;

interface Frame {
  channel: string;
  data: unknown;
  seq?: number;
  reset?: boolean;
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
      price: '100',
      qty: '0.5',
      tif: 'GTC',
    });
    const withAsk = await probe.waitFor((f) => {
      if (f.channel !== `orderbook:${M}`) return false;
      const d = f.data as { asks: { price: string; qty: string }[] };
      return d.asks.length === 1 && d.asks[0]!.qty === '0.5';
    });
    expect((withAsk.data as { asks: unknown[] }).asks).toEqual([
      { price: '100', qty: '0.5' },
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
      price: '100',
      qty: '0.2',
      tif: 'GTC',
    });
    expect(res.statusCode).toBe(200);

    const tradeFrame = await probe.waitFor((f) => f.channel === `trades:${M}`);
    const trades = tradeFrame.data as { price: string; qty: string; takerSide: string }[];
    expect(trades[0]).toMatchObject({ price: '100', qty: '0.2', takerSide: 'buy' });

    // the user frame carries not just a coalesced kind string but the actual
    // changed entities (a fill here), so a client can update without refetching
    const userFrame = await probe.waitFor((f) => {
      if (f.channel !== 'user') return false;
      const d = f.data as { fills?: unknown[] };
      return Array.isArray(d.fills) && d.fills.length > 0;
    });
    const d = userFrame.data as { type: string; fills: Record<string, unknown>[] };
    expect(d.type).toContain('fill');
    expect(d.fills[0]).toMatchObject({ price: '100', qty: '0.2', role: 'taker', side: 'buy' });
    // privacy: the per-user fill view never leaks the counterparty's identity
    expect(d.fills[0]).not.toHaveProperty('makerUserId');
    expect(d.fills[0]).not.toHaveProperty('takerUserId');
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
      price: toUnits('100.5'),
      change24h: toUnits('0.012'),
      high24h: toUnits('10100000'),
      low24h: toUnits('9900000'),
      volume24h: toUnits('123456789'),
      ts: Date.now(),
    });

    const tick = await probe.waitFor((f) => f.channel === `ticker:${M}`);
    expect(tick.data).toMatchObject({ marketId: M, price: '100.5', change24h: '0.012' });
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
      price: toUnits('100.5'),
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
    expect(print).toMatchObject({ price: '100.5', qty: '0.025', takerSide: 'sell' });

    // late subscriber gets it from the ring
    const late = new WsProbe(base);
    await late.ready();
    late.send({ op: 'subscribe', channel: `trades:${M}`, market: M });
    const seeded = await late.waitFor((f) => f.channel === `trades:${M}`);
    expect((seeded.data as { id?: string }[]).some((x) => x.id === 'u1234567890')).toBe(true);
    probe.close();
    late.close();
  });

  it('kicks a flooding client and keeps serving everyone else', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    const kicked = new Promise<void>((resolve) => probe.ws.on('close', () => resolve()));
    // 2000 junk frames blows straight through the 300-frame burst budget
    for (let i = 0; i < 500; i++) {
      probe.ws.send('not json at all {{{');
      probe.send({ op: 'subscribe' }); // missing channel
      probe.send({ op: 'auth', token: 12345 }); // wrong type
      probe.send({ nonsense: true });
    }
    await kicked;

    // a well-behaved client connects fine right after
    const fresh = new WsProbe(base);
    await fresh.ready();
    fresh.send({ op: 'subscribe', channel: `orderbook:${M}`, market: M });
    await fresh.waitFor((f) => f.channel === `orderbook:${M}`);
    const health = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    fresh.close();
  });

  it('stamps a strictly +1 per-channel seq on consecutive frames of the same channel', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `orderbook:${M}`, market: M });

    // first frame is a fresh snapshot: carries the channel's current seq + reset
    const initial = await probe.waitFor((f) => f.channel === `orderbook:${M}`);
    expect(initial.reset).toBe(true);
    expect(typeof initial.seq).toBe('number');

    // each fill dirties the book → one more orderbook broadcast (seq += 1)
    for (let i = 0; i < 3; i++) {
      await placeOrder(t.app, alice, {
        marketId: M,
        side: 'sell',
        type: 'limit',
        price: String(200 + i),
        qty: '0.01',
        tif: 'GTC',
      });
      // wait until we've observed (i + 1) live (non-reset) frames after the snapshot
      await probe.waitFor(
        (f) => f.channel === `orderbook:${M}` && f.reset !== true,
        4000,
      );
      // give the throttled book flush room to emit before the next order
      await new Promise((r) => setTimeout(r, 120));
    }

    const seqs = probe.frames
      .filter((f) => f.channel === `orderbook:${M}`)
      .map((f) => f.seq as number);
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    // strictly monotonic by exactly +1, with no gaps, across the whole channel
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
    probe.close();
  });

  it('gives different channels independent per-channel sequences', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `orderbook:${M}`, market: M });
    probe.send({ op: 'subscribe', channel: `orderbook:${M2}`, market: M2 });

    const a0 = await probe.waitFor((f) => f.channel === `orderbook:${M}`);
    const b0 = await probe.waitFor((f) => f.channel === `orderbook:${M2}`);
    // both snapshots are resets; their seqs are tracked per-channel, not shared
    expect(a0.reset).toBe(true);
    expect(b0.reset).toBe(true);

    // drive several broadcasts on channel A only
    const countA = () => probe.frames.filter((f) => f.channel === `orderbook:${M}`).length;
    const before = countA();
    for (let i = 0; i < 2; i++) {
      await placeOrder(t.app, alice, {
        marketId: M,
        side: 'sell',
        type: 'limit',
        price: String(300 + i),
        qty: '0.01',
        tif: 'GTC',
      });
      await new Promise((r) => setTimeout(r, 120));
    }
    await probe.waitFor(() => countA() >= before + 1);

    const aSeqs = probe.frames
      .filter((f) => f.channel === `orderbook:${M}`)
      .map((f) => f.seq as number);
    const bSeqs = probe.frames
      .filter((f) => f.channel === `orderbook:${M2}`)
      .map((f) => f.seq as number);

    // A advanced; B did not — the counters are not a shared global sequence
    expect(aSeqs[aSeqs.length - 1]!).toBeGreaterThan(aSeqs[0]!);
    expect(bSeqs.every((s) => s === bSeqs[0])).toBe(true);
    // each channel's own seqs are still gap-free +1 steps
    for (let i = 1; i < aSeqs.length; i++) expect(aSeqs[i]).toBe(aSeqs[i - 1]! + 1);
    probe.close();
  });

  it('markPrice:<mkt> streams perp marks and snapshots the latest to late subscribers', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: `markPrice:${M2}`, market: M2 });

    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M2, toUnits('123.5'), Date.now()));
    const frame = await probe.waitFor((f) => f.channel === `markPrice:${M2}`);
    expect(frame.data).toMatchObject({ marketId: M2, price: '123.5' });

    // a late subscriber gets the latest mark immediately as a reset snapshot
    const late = new WsProbe(base);
    await late.ready();
    late.send({ op: 'subscribe', channel: `markPrice:${M2}`, market: M2 });
    const snap = await late.waitFor((f) => f.channel === `markPrice:${M2}`);
    expect(snap.reset).toBe(true);
    expect(snap.data).toMatchObject({ marketId: M2, price: '123.5' });
    probe.close();
    late.close();
  });

  it('liquidations channel broadcasts an anonymized public tape (no userId)', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: 'liquidations' });

    // alice opens a 5x long on the perp, bob takes the other side
    await authed(t.app, alice, 'POST', '/api/account/leverage', { marketId: M2, leverage: 5 });
    await placeOrder(t.app, bob, { marketId: M2, side: 'sell', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    await placeOrder(t.app, alice, { marketId: M2, side: 'buy', type: 'limit', price: '100', qty: '1', tif: 'GTC' });
    // crater the mark → alice is force-closed
    await t.svc.pipeline.exec(() => t.svc.engine.setMarkPrice(M2, toUnits('50'), Date.now()));

    const frame = await probe.waitFor((f) => f.channel === 'liquidations');
    const rows = frame.data as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ marketId: M2 });
    expect(rows[0]).toHaveProperty('markPrice');
    expect(rows[0]).not.toHaveProperty('userId'); // privacy: public tape is anonymized
    probe.close();
  });

  it('unauthenticated sockets never receive user frames', async () => {
    const probe = new WsProbe(base);
    await probe.ready();
    probe.send({ op: 'subscribe', channel: 'user' });
    await placeOrder(t.app, bob, {
      marketId: M,
      side: 'buy',
      type: 'limit',
      price: '90',
      qty: '0.05',
      tif: 'GTC',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(probe.frames.filter((f) => f.channel === 'user')).toEqual([]);
    probe.close();
  });
});
