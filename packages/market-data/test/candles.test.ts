import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '@dex/shared';
import { CandleService, INTERVAL_MS } from '../src/candles.js';

function mkCandles(n: number, startT = 1_781_100_000_000, stepMs = 60_000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: startT + i * stepMs,
    o: 100n + BigInt(i),
    h: 110n + BigInt(i),
    l: 90n + BigInt(i),
    c: 105n + BigInt(i),
    v: 1_00000000n,
  }));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CandleService routing', () => {
  it('routes *-USDC spot to the Upbit USDT market (market, interval, limit)', async () => {
    const data = mkCandles(5);
    const upbit = { fetchCandles: vi.fn(async () => data) };
    const hl = { candleSnapshot: vi.fn(async () => []) };
    const svc = new CandleService(upbit, hl, { now: () => 1_781_103_000_000 });
    const out = await svc.get('BTC-USDC', '5m', 5);
    expect(upbit.fetchCandles).toHaveBeenCalledExactlyOnceWith('USDT-BTC', '5m', 5);
    expect(hl.candleSnapshot).not.toHaveBeenCalled();
    expect(out).toEqual(data);
  });

  it('routes *-PERP to Hyperliquid with computed start/end from the injected clock', async () => {
    const now = 1_781_103_000_000;
    const data = mkCandles(3, now - 3 * INTERVAL_MS['1h'], INTERVAL_MS['1h']);
    const upbit = { fetchCandles: vi.fn(async () => []) };
    const hl = { candleSnapshot: vi.fn(async () => data) };
    const svc = new CandleService(upbit, hl, { now: () => now });
    const out = await svc.get('BTC-PERP', '1h', 3);
    expect(hl.candleSnapshot).toHaveBeenCalledExactlyOnceWith('BTC', '1h', now - 3 * INTERVAL_MS['1h'], now);
    expect(upbit.fetchCandles).not.toHaveBeenCalled();
    expect(out).toEqual(data);
  });

  it('trims Hyperliquid results to the requested limit (newest kept)', async () => {
    const data = mkCandles(10);
    const upbit = { fetchCandles: vi.fn(async () => []) };
    const hl = { candleSnapshot: vi.fn(async () => data) };
    const svc = new CandleService(upbit, hl, { now: () => 1_781_103_000_000 });
    const out = await svc.get('ETH-PERP', '1m', 4);
    expect(out).toEqual(data.slice(-4));
  });

  it('rejects unsupported market ids', async () => {
    const svc = new CandleService(
      { fetchCandles: vi.fn(async () => []) },
      { candleSnapshot: vi.fn(async () => []) },
    );
    await expect(svc.get('KRW-BTC', '1m', 10)).rejects.toThrow(/unsupported market id/);
  });
});

describe('CandleService TTL cache', () => {
  it('serves from cache within 5s and refetches after expiry', async () => {
    let clock = 1_781_103_000_000;
    const upbit = { fetchCandles: vi.fn(async () => mkCandles(5)) };
    const hl = { candleSnapshot: vi.fn(async () => []) };
    const svc = new CandleService(upbit, hl, { now: () => clock });

    await svc.get('BTC-USDC', '1m', 5);
    clock += 4_999;
    await svc.get('BTC-USDC', '1m', 5);
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(1); // cache hit

    clock += 2; // 5_001ms after fetch
    await svc.get('BTC-USDC', '1m', 5);
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2); // TTL expired
  });

  it('keys the cache by (market, interval)', async () => {
    const clock = 1_781_103_000_000;
    const upbit = { fetchCandles: vi.fn(async () => mkCandles(5)) };
    const hl = { candleSnapshot: vi.fn(async () => mkCandles(5)) };
    const svc = new CandleService(upbit, hl, { now: () => clock });

    await svc.get('BTC-USDC', '1m', 5);
    await svc.get('BTC-USDC', '5m', 5); // different interval → miss
    await svc.get('ETH-USDC', '1m', 5); // different market → miss
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(3);
    await svc.get('BTC-PERP', '1m', 5);
    await svc.get('BTC-PERP', '1m', 5); // hit
    expect(hl.candleSnapshot).toHaveBeenCalledTimes(1);
  });

  it('serves a smaller limit from a larger cached window, refetches for a bigger one', async () => {
    const clock = 1_781_103_000_000;
    const data = mkCandles(10);
    const upbit = { fetchCandles: vi.fn(async () => data) };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => clock });

    await svc.get('BTC-USDC', '1m', 10);
    const small = await svc.get('BTC-USDC', '1m', 3);
    expect(small).toEqual(data.slice(-3));
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(1);

    await svc.get('BTC-USDC', '1m', 20); // larger than cached → must refetch
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const clock = 1_781_103_000_000;
    const upbit = {
      fetchCandles: vi
        .fn<() => Promise<Candle[]>>()
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(mkCandles(5)),
    };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => clock });
    await expect(svc.get('BTC-USDC', '1m', 5)).rejects.toThrow('HTTP 500');
    const out = await svc.get('BTC-USDC', '1m', 5);
    expect(out).toHaveLength(5);
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2);
  });
});

describe('CandleService concurrent dedupe', () => {
  it('reuses the in-flight promise for concurrent identical requests', async () => {
    const d = deferred<Candle[]>();
    const upbit = { fetchCandles: vi.fn(() => d.promise) };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => 1 });

    const p1 = svc.get('BTC-USDC', '1m', 5);
    const p2 = svc.get('BTC-USDC', '1m', 5);
    const p3 = svc.get('BTC-USDC', '1m', 3); // smaller limit piggybacks too
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(1);

    const data = mkCandles(5);
    d.resolve(data);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(data);
    expect(r2).toEqual(data);
    expect(r3).toEqual(data.slice(-3));
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('a concurrent request with a larger limit triggers its own fetch', async () => {
    const d1 = deferred<Candle[]>();
    const d2 = deferred<Candle[]>();
    const upbit = {
      fetchCandles: vi.fn<() => Promise<Candle[]>>().mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise),
    };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => 1 });

    const p1 = svc.get('BTC-USDC', '1m', 5);
    const p2 = svc.get('BTC-USDC', '1m', 50);
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2);
    d1.resolve(mkCandles(5));
    d2.resolve(mkCandles(50));
    expect(await p1).toHaveLength(5);
    expect(await p2).toHaveLength(50);
  });

  it("a small fetch completing first does not evict the larger fetch's in-flight entry", async () => {
    const dSmall = deferred<Candle[]>();
    const dLarge = deferred<Candle[]>();
    const upbit = {
      fetchCandles: vi
        .fn<() => Promise<Candle[]>>()
        .mockReturnValueOnce(dSmall.promise)
        .mockReturnValueOnce(dLarge.promise),
    };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => 1 });

    const pSmall = svc.get('BTC-USDC', '1m', 5);
    const pLarge = svc.get('BTC-USDC', '1m', 50); // replaces the in-flight entry
    dSmall.resolve(mkCandles(5));
    expect(await pSmall).toHaveLength(5); // must NOT delete the large in-flight entry
    const pPiggy = svc.get('BTC-USDC', '1m', 40); // should piggyback on the large fetch
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2); // no third fetch
    dLarge.resolve(mkCandles(50));
    expect(await pLarge).toHaveLength(50);
    expect(await pPiggy).toHaveLength(40);
  });

  it('a small fetch resolving after a larger one does not clobber the fresh larger cache window', async () => {
    const dSmall = deferred<Candle[]>();
    const dLarge = deferred<Candle[]>();
    const upbit = {
      fetchCandles: vi
        .fn<() => Promise<Candle[]>>()
        .mockReturnValueOnce(dSmall.promise)
        .mockReturnValueOnce(dLarge.promise),
    };
    const svc = new CandleService(upbit, { candleSnapshot: vi.fn(async () => []) }, { now: () => 1 });

    const pSmall = svc.get('BTC-USDC', '1m', 5);
    const pLarge = svc.get('BTC-USDC', '1m', 50);
    dLarge.resolve(mkCandles(50));
    expect(await pLarge).toHaveLength(50); // cache now holds the 50-candle window
    dSmall.resolve(mkCandles(5));
    expect(await pSmall).toHaveLength(5); // late small completion must not shrink the cache
    const out = await svc.get('BTC-USDC', '1m', 50);
    expect(out).toHaveLength(50);
    expect(upbit.fetchCandles).toHaveBeenCalledTimes(2); // served from cache, no refetch
  });
});
