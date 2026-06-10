import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpbitRest } from '../src/upbit.js';
import {
  UPBIT_CANDLES_1D_FIXTURE,
  UPBIT_CANDLES_1M_FIXTURE,
  UPBIT_MARKETS_FIXTURE,
  UPBIT_TICKER_FIXTURE,
  UPBIT_TRADES_FIXTURE,
  jsonFetchStub,
} from './fixtures.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UpbitRest.fetchMarkets', () => {
  it('parses the real market list shape and hits the right URL', async () => {
    const { fetch, calls } = jsonFetchStub([UPBIT_MARKETS_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const rest = new UpbitRest();
    const markets = await rest.fetchMarkets();
    expect(calls[0]!.url).toBe('https://api.upbit.com/v1/market/all?isDetails=false');
    expect(markets).toHaveLength(8);
    const btc = markets.find((m) => m.market === 'KRW-BTC')!;
    expect(btc.korean_name).toBe('비트코인');
    expect(btc.english_name).toBe('Bitcoin');
  });

  it('throws a descriptive error on schema mismatch', async () => {
    const { fetch } = jsonFetchStub([[{ market: 'KRW-BTC', korean_name: 42, english_name: 'Bitcoin' }]]);
    vi.stubGlobal('fetch', fetch);
    await expect(new UpbitRest().fetchMarkets()).rejects.toThrow(/korean_name/);
  });

  it('throws a descriptive error on non-200', async () => {
    vi.stubGlobal('fetch', (async () =>
      new Response('{"error":{"name":"too_many_requests"}}', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch);
    await expect(new UpbitRest().fetchMarkets()).rejects.toThrow(/HTTP 429/);
  });

  it('throws a descriptive error when the body is not an array', async () => {
    const { fetch } = jsonFetchStub([{ oops: true }]);
    vi.stubGlobal('fetch', fetch);
    await expect(new UpbitRest().fetchMarkets()).rejects.toThrow(/expected JSON array/);
  });
});

describe('UpbitRest.fetchCandles', () => {
  it('maps every interval to the documented Upbit path', async () => {
    const { fetch, calls } = jsonFetchStub([UPBIT_CANDLES_1M_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const rest = new UpbitRest();
    await rest.fetchCandles('KRW-BTC', '1m', 3);
    await rest.fetchCandles('KRW-BTC', '5m', 3);
    await rest.fetchCandles('KRW-BTC', '15m', 3);
    await rest.fetchCandles('KRW-BTC', '1h', 3);
    await rest.fetchCandles('KRW-BTC', '4h', 3);
    await rest.fetchCandles('KRW-BTC', '1d', 3);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.upbit.com/v1/candles/minutes/1?market=KRW-BTC&count=3',
      'https://api.upbit.com/v1/candles/minutes/5?market=KRW-BTC&count=3',
      'https://api.upbit.com/v1/candles/minutes/15?market=KRW-BTC&count=3',
      'https://api.upbit.com/v1/candles/minutes/60?market=KRW-BTC&count=3',
      'https://api.upbit.com/v1/candles/minutes/240?market=KRW-BTC&count=3',
      'https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=3',
    ]);
  });

  it('clamps count to 200', async () => {
    const { fetch, calls } = jsonFetchStub([UPBIT_CANDLES_1M_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    await new UpbitRest().fetchCandles('KRW-BTC', '1m', 999);
    expect(calls[0]!.url).toContain('count=200');
  });

  it('parses real 1m candles to exact bigints and reverses to ascending', async () => {
    const { fetch } = jsonFetchStub([UPBIT_CANDLES_1M_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const candles = await new UpbitRest().fetchCandles('KRW-BTC', '1m', 3);
    expect(candles).toHaveLength(3);
    // Upbit returned newest-first; we must get oldest-first.
    expect(candles.map((c) => c.t)).toEqual([1781102280000, 1781102340000, 1781102400000]);
    const first = candles[0]!; // 14:38 UTC candle
    expect(first.o).toBe(9292400000000000n); // 92,924,000 KRW
    expect(first.h).toBe(9295000000000000n);
    expect(first.l).toBe(9291300000000000n);
    expect(first.c).toBe(9294800000000000n);
    expect(first.v).toBe(102453046n); // 1.02453046 BTC
    const last = candles[2]!;
    expect(last.o).toBe(9304900000000000n);
    expect(last.c).toBe(9315100000000000n);
    expect(last.v).toBe(15468252n); // 0.15468252 BTC
    for (const c of candles) {
      expect(c.l <= c.o && c.l <= c.c).toBe(true);
      expect(c.h >= c.o && c.h >= c.c).toBe(true);
    }
  });

  it('parses real day candles (different shape) with UTC bucket times', async () => {
    const { fetch } = jsonFetchStub([UPBIT_CANDLES_1D_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const candles = await new UpbitRest().fetchCandles('KRW-BTC', '1d', 2);
    expect(candles.map((c) => c.t)).toEqual([1780963200000, 1781049600000]);
    expect(candles[0]!.o).toBe(9473500000000000n);
    expect(candles[0]!.v).toBe(133384495975n); // 1333.84495975 BTC
    expect(candles[1]!.c).toBe(9316200000000000n);
  });

  it('rejects non-monotonic candle data instead of returning bad order', async () => {
    const dup = [UPBIT_CANDLES_1M_FIXTURE[0], UPBIT_CANDLES_1M_FIXTURE[0]];
    const { fetch } = jsonFetchStub([dup]);
    vi.stubGlobal('fetch', fetch);
    await expect(new UpbitRest().fetchCandles('KRW-BTC', '1m', 2)).rejects.toThrow(/not strictly ascending/);
  });
});

describe('UpbitRest.fetchTickers', () => {
  it('parses real tickers to exact bigints (incl. negative change rate)', async () => {
    const { fetch, calls } = jsonFetchStub([UPBIT_TICKER_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const tickers = await new UpbitRest().fetchTickers(['KRW-BTC', 'KRW-XRP']);
    expect(calls[0]!.url).toBe('https://api.upbit.com/v1/ticker?markets=KRW-BTC%2CKRW-XRP');
    expect(tickers).toHaveLength(2);
    const btc = tickers[0]!;
    expect(btc.marketId).toBe('KRW-BTC');
    expect(btc.price).toBe(9315100000000000n); // 93,151,000 KRW
    expect(btc.change24h).toBe(643941n); // 0.0064394144 truncated to 8 dp
    expect(btc.high24h).toBe(9384800000000000n);
    expect(btc.low24h).toBe(9150000000000000n);
    // wire value 128096613472.80703 — JSON.parse yields the nearest double,
    // which stringifies to ...80704; exactness is double-roundtrip exactness.
    expect(btc.volume24h).toBe(12809661347280704000n);
    expect(btc.ts).toBe(1781102448112);
    const xrp = tickers[1]!;
    expect(xrp.price).toBe(168700000000n); // 1,687 KRW
    expect(xrp.change24h).toBe(-1113716n); // -0.011137163 truncated, signed
  });

  it('returns [] for an empty market list without a network call', async () => {
    const { fetch, calls } = jsonFetchStub([[]]);
    vi.stubGlobal('fetch', fetch);
    expect(await new UpbitRest().fetchTickers([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('UpbitRest.fetchRecentTrades', () => {
  it('parses real trades with taker side mapping (BID=buy, ASK=sell)', async () => {
    const { fetch, calls } = jsonFetchStub([UPBIT_TRADES_FIXTURE]);
    vi.stubGlobal('fetch', fetch);
    const trades = await new UpbitRest().fetchRecentTrades('KRW-BTC', 2);
    expect(calls[0]!.url).toBe('https://api.upbit.com/v1/trades/ticks?market=KRW-BTC&count=2');
    expect(trades).toHaveLength(2);
    expect(trades[0]!.price).toBe(9308900000000000n);
    expect(trades[0]!.qty).toBe(184778n); // 0.00184778 BTC
    expect(trades[0]!.side).toBe('sell'); // ASK
    expect(trades[0]!.ts).toBe(1781102449702);
    expect(trades[0]!.sequentialId).toBe(17811024497020000n);
    expect(trades[1]!.side).toBe('buy'); // BID
    expect(trades[1]!.qty).toBe(5474n);
    expect(trades[1]!.sequentialId).toBe(17811024488780000n);
  });

  it('preserves sequential_id beyond 2^53 exactly (no double rounding)', async () => {
    // 17811024497020001 is odd and > 2^53 — JSON.parse via double would round it to ...020000
    const body =
      '[{"market":"KRW-BTC","trade_date_utc":"2026-06-10","trade_time_utc":"14:40:49",' +
      '"timestamp":1781102449702,"trade_price":93089000.0,"trade_volume":0.00184778,' +
      '"prev_closing_price":92555000.0,"change_price":534000.0,"ask_bid":"ASK",' +
      '"sequential_id":17811024497020001}]';
    vi.stubGlobal('fetch', (async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
    const trades = await new UpbitRest().fetchRecentTrades('KRW-BTC', 1);
    expect(trades[0]!.sequentialId).toBe(17811024497020001n);
  });

  it('rejects unknown ask_bid values', async () => {
    const bad = [{ ...UPBIT_TRADES_FIXTURE[0], ask_bid: 'WAT' }];
    const { fetch } = jsonFetchStub([bad]);
    vi.stubGlobal('fetch', fetch);
    await expect(new UpbitRest().fetchRecentTrades('KRW-BTC', 1)).rejects.toThrow(/ask_bid/);
  });
});
