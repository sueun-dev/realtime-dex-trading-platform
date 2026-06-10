import { afterEach, describe, expect, it, vi } from 'vitest';
import { HyperliquidRest } from '../src/hyperliquid.js';
import {
  HL_ALLMIDS_FIXTURE,
  HL_CANDLES_FIXTURE,
  HL_FUNDING_FIXTURE,
  HL_META_FIXTURE,
  jsonFetchStub,
} from './fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HyperliquidRest.meta', () => {
  it('POSTs {"type":"meta"} and parses the real universe shape', async () => {
    const { fetch, calls } = jsonFetchStub([HL_META_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const universe = await new HyperliquidRest().meta();
    expect(calls[0]!.url).toBe('https://api.hyperliquid.xyz/info');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ type: 'meta' });
    expect(universe).toHaveLength(6);
    expect(universe[0]).toEqual({ name: 'BTC', szDecimals: 5, maxLeverage: 40 });
    expect(universe[1]).toEqual({ name: 'ETH', szDecimals: 4, maxLeverage: 25 });
    const matic = universe.find((a) => a.name === 'MATIC')!;
    expect(matic.isDelisted).toBe(true);
  });

  it('throws on schema mismatch (missing universe)', async () => {
    const { fetch } = jsonFetchStub([{ nope: [] }]);
    vi.stubGlobal('fetch', fetch);
    await expect(new HyperliquidRest().meta()).rejects.toThrow(/universe/);
  });
});

describe('HyperliquidRest.allMids', () => {
  it('parses real mids to exact bigints and skips @/# index keys', async () => {
    const { fetch, calls } = jsonFetchStub([HL_ALLMIDS_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const mids = await new HyperliquidRest().allMids();
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ type: 'allMids' });
    expect(mids.get('BTC')).toBe(6195350000000n); // 61953.5
    expect(mids.get('ETH')).toBe(164335000000n); // 1643.35
    expect(mids.get('SOL')).toBe(6479250000n); // 64.7925
    expect([...mids.keys()].some((k) => k.startsWith('@') || k.startsWith('#'))).toBe(false);
    expect(mids.size).toBe(4);
  });

  it('throws on non-numeric mid', async () => {
    const { fetch } = jsonFetchStub([{ BTC: 'not-a-number' }]);
    vi.stubGlobal('fetch', fetch);
    await expect(new HyperliquidRest().allMids()).rejects.toThrow(/allMids\[BTC\]/);
  });
});

describe('HyperliquidRest.candleSnapshot', () => {
  it('POSTs the documented req body and parses real candles ascending', async () => {
    const { fetch, calls } = jsonFetchStub([HL_CANDLES_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const candles = await new HyperliquidRest().candleSnapshot('BTC', '1h', 1781089200000, 1781103599999);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1h', startTime: 1781089200000, endTime: 1781103599999 },
    });
    expect(candles).toHaveLength(4);
    expect(candles.map((c) => c.t)).toEqual([1781089200000, 1781092800000, 1781096400000, 1781100000000]);
    expect(candles[0]!.o).toBe(6135500000000n); // "61355.0"
    expect(candles[0]!.c).toBe(6100000000000n);
    expect(candles[0]!.h).toBe(6141400000000n);
    expect(candles[0]!.l).toBe(6083200000000n);
    expect(candles[0]!.v).toBe(173748262000n); // "1737.48262"
    expect(candles[3]!.v).toBe(176260040000n); // "1762.6004"
    for (const c of candles) {
      expect(c.l <= c.o && c.l <= c.c).toBe(true);
      expect(c.h >= c.o && c.h >= c.c).toBe(true);
    }
  });

  it('sorts out-of-order candles ascending', async () => {
    const shuffled = [HL_CANDLES_FIXTURE[2], HL_CANDLES_FIXTURE[0], HL_CANDLES_FIXTURE[3], HL_CANDLES_FIXTURE[1]];
    const { fetch } = jsonFetchStub([shuffled]);
    vi.stubGlobal('fetch', fetch);
    const candles = await new HyperliquidRest().candleSnapshot('BTC', '1h', 0, 1);
    expect(candles.map((c) => c.t)).toEqual([1781089200000, 1781092800000, 1781096400000, 1781100000000]);
  });
});

describe('HyperliquidRest.fundingHistory', () => {
  it('parses real signed funding rates to exact 1e8 bigints', async () => {
    const { fetch, calls } = jsonFetchStub([HL_FUNDING_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const points = await new HyperliquidRest().fundingHistory('BTC', 1781082000000);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      type: 'fundingHistory',
      coin: 'BTC',
      startTime: 1781082000000,
    });
    expect(points).toHaveLength(4);
    expect(points[0]).toEqual({ time: 1781082000053, fundingRate: -521n }); // -0.0000052185 → -521 (trunc)
    expect(points[1]!.fundingRate).toBe(220n); // 0.0000022075
    expect(points[2]!.fundingRate).toBe(568n); // 0.0000056886
    expect(points[3]!.fundingRate).toBe(999n); // 0.0000099992
  });
});
