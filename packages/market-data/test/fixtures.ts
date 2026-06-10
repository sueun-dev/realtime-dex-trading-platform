/**
 * REAL captured API responses (trimmed), fetched 2026-06-10T14:40Z via curl:
 *  - GET  https://api.upbit.com/v1/market/all?isDetails=false
 *  - GET  https://api.upbit.com/v1/candles/minutes/1?market=KRW-BTC&count=3
 *  - GET  https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=2
 *  - GET  https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH,KRW-XRP
 *  - GET  https://api.upbit.com/v1/trades/ticks?market=KRW-BTC&count=3
 *  - POST https://api.hyperliquid.xyz/info {"type":"meta"}
 *  - POST https://api.hyperliquid.xyz/info {"type":"allMids"}
 *  - POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot","req":{"coin":"BTC","interval":"1h",...}}
 *  - POST https://api.hyperliquid.xyz/info {"type":"fundingHistory","coin":"BTC",...}
 * Values are verbatim from the live responses; lists trimmed for size.
 */

export const UPBIT_MARKETS_FIXTURE = [
  { market: 'BTC-BERA', korean_name: '베라체인', english_name: 'Berachain' },
  { market: 'BTC-FIL', korean_name: '파일코인', english_name: 'Filecoin' },
  { market: 'KRW-WAXP', korean_name: '왁스', english_name: 'WAX' },
  { market: 'USDT-PEPE', korean_name: '페페', english_name: 'Pepe' },
  { market: 'KRW-CARV', korean_name: '카브', english_name: 'CARV' },
  { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
  { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
  { market: 'KRW-XRP', korean_name: '리플', english_name: 'XRP' },
];

/** Upbit returns minute candles NEWEST-FIRST (descending). */
export const UPBIT_CANDLES_1M_FIXTURE = [
  {
    market: 'KRW-BTC',
    candle_date_time_utc: '2026-06-10T14:40:00',
    candle_date_time_kst: '2026-06-10T23:40:00',
    opening_price: 93049000.0,
    high_price: 93151000.0,
    low_price: 93004000.0,
    trade_price: 93151000.0,
    timestamp: 1781102446828,
    candle_acc_trade_price: 14396633.95537,
    candle_acc_trade_volume: 0.15468252,
    unit: 1,
  },
  {
    market: 'KRW-BTC',
    candle_date_time_utc: '2026-06-10T14:39:00',
    candle_date_time_kst: '2026-06-10T23:39:00',
    opening_price: 92922000.0,
    high_price: 93078000.0,
    low_price: 92920000.0,
    trade_price: 93050000.0,
    timestamp: 1781102397945,
    candle_acc_trade_price: 327841610.25632,
    candle_acc_trade_volume: 3.52624191,
    unit: 1,
  },
  {
    market: 'KRW-BTC',
    candle_date_time_utc: '2026-06-10T14:38:00',
    candle_date_time_kst: '2026-06-10T23:38:00',
    opening_price: 92924000.0,
    high_price: 92950000.0,
    low_price: 92913000.0,
    trade_price: 92948000.0,
    timestamp: 1781102332890,
    candle_acc_trade_price: 95215978.67578,
    candle_acc_trade_volume: 1.02453046,
    unit: 1,
  },
];

/** Day candles have a slightly different shape (no `unit`, extra change fields). */
export const UPBIT_CANDLES_1D_FIXTURE = [
  {
    market: 'KRW-BTC',
    candle_date_time_utc: '2026-06-10T00:00:00',
    candle_date_time_kst: '2026-06-10T09:00:00',
    opening_price: 92555000.0,
    high_price: 93848000.0,
    low_price: 91500000.0,
    trade_price: 93162000.0,
    timestamp: 1781102466662,
    candle_acc_trade_price: 84241354194.46382,
    candle_acc_trade_volume: 911.79135707,
    prev_closing_price: 92555000.0,
    change_price: 607000.0,
    change_rate: 0.0065582627,
  },
  {
    market: 'KRW-BTC',
    candle_date_time_utc: '2026-06-09T00:00:00',
    candle_date_time_kst: '2026-06-09T09:00:00',
    opening_price: 94735000.0,
    high_price: 94980000.0,
    low_price: 91700000.0,
    trade_price: 92555000.0,
    timestamp: 1781049599931,
    candle_acc_trade_price: 124485287109.73103,
    candle_acc_trade_volume: 1333.84495975,
    prev_closing_price: 94730000.0,
    change_price: -2175000.0,
    change_rate: -0.0229599916,
  },
];

export const UPBIT_TICKER_FIXTURE = [
  {
    market: 'KRW-BTC',
    trade_date: '20260610',
    trade_time: '144046',
    trade_timestamp: 1781102446783,
    opening_price: 92555000.0,
    high_price: 93848000.0,
    low_price: 91500000.0,
    trade_price: 93151000.0,
    prev_closing_price: 92555000.0,
    change: 'RISE',
    change_price: 596000.0,
    change_rate: 0.0064394144,
    signed_change_price: 596000.0,
    signed_change_rate: 0.0064394144,
    trade_volume: 0.00063762,
    acc_trade_price: 84237522424.23064,
    acc_trade_price_24h: 128096613472.80703,
    acc_trade_volume: 911.75022409,
    acc_trade_volume_24h: 1386.48310946,
    timestamp: 1781102448112,
  },
  {
    market: 'KRW-XRP',
    trade_date: '20260610',
    trade_time: '144044',
    trade_timestamp: 1781102444182,
    opening_price: 1707.0,
    high_price: 1710.0,
    low_price: 1656.0,
    trade_price: 1687.0,
    prev_closing_price: 1706.0,
    change: 'FALL',
    change_price: 19.0,
    change_rate: 0.011137163,
    signed_change_price: -19.0,
    signed_change_rate: -0.011137163,
    trade_volume: 1359.17836384,
    acc_trade_price: 108243228572.89687,
    acc_trade_price_24h: 151139921563.96792238,
    acc_trade_volume: 64418510.37747735,
    acc_trade_volume_24h: 89579672.36768088,
    timestamp: 1781102447160,
  },
];

export const UPBIT_TRADES_FIXTURE = [
  {
    market: 'KRW-BTC',
    trade_date_utc: '2026-06-10',
    trade_time_utc: '14:40:49',
    timestamp: 1781102449702,
    trade_price: 93089000.0,
    trade_volume: 0.00184778,
    prev_closing_price: 92555000.0,
    change_price: 534000.0,
    ask_bid: 'ASK',
    sequential_id: 17811024497020000,
  },
  {
    market: 'KRW-BTC',
    trade_date_utc: '2026-06-10',
    trade_time_utc: '14:40:48',
    timestamp: 1781102448878,
    trade_price: 93151000.0,
    trade_volume: 0.00005474,
    prev_closing_price: 92555000.0,
    change_price: 596000.0,
    ask_bid: 'BID',
    sequential_id: 17811024488780000,
  },
];

export const HL_META_FIXTURE = {
  universe: [
    { szDecimals: 5, name: 'BTC', maxLeverage: 40, marginTableId: 56 },
    { szDecimals: 4, name: 'ETH', maxLeverage: 25, marginTableId: 55 },
    { szDecimals: 2, name: 'ATOM', maxLeverage: 5, marginTableId: 5 },
    { szDecimals: 1, name: 'MATIC', maxLeverage: 20, marginTableId: 20, isDelisted: true },
    { szDecimals: 1, name: 'DYDX', maxLeverage: 5, marginTableId: 5 },
    { szDecimals: 2, name: 'SOL', maxLeverage: 20, marginTableId: 54 },
  ],
};

export const HL_ALLMIDS_FIXTURE: Record<string, string> = {
  '@1': '9.58665',
  '@10': '0.000045',
  '@100': '0.003578',
  BTC: '61953.5',
  ETH: '1643.35',
  SOL: '64.7925',
  DYDX: '0.5',
};

/** Hyperliquid candleSnapshot BTC 1h — ascending as returned. */
export const HL_CANDLES_FIXTURE = [
  { t: 1781089200000, T: 1781092799999, s: 'BTC', i: '1h', o: '61355.0', c: '61000.0', h: '61414.0', l: '60832.0', v: '1737.48262', n: 21168 },
  { t: 1781092800000, T: 1781096399999, s: 'BTC', i: '1h', o: '61000.0', c: '61537.0', h: '61902.0', l: '60930.0', v: '3813.10095', n: 31030 },
  { t: 1781096400000, T: 1781099999999, s: 'BTC', i: '1h', o: '61537.0', c: '62115.0', h: '62436.0', l: '61409.0', v: '4468.37077', n: 38171 },
  { t: 1781100000000, T: 1781103599999, s: 'BTC', i: '1h', o: '62115.0', c: '61986.0', h: '62241.0', l: '61786.0', v: '1762.6004', n: 23781 },
];

export const HL_FUNDING_FIXTURE = [
  { coin: 'BTC', fundingRate: '-0.0000052185', premium: '-0.0005417479', time: 1781082000053 },
  { coin: 'BTC', fundingRate: '0.0000022075', premium: '-0.0004823403', time: 1781085600013 },
  { coin: 'BTC', fundingRate: '0.0000056886', premium: '-0.0004544911', time: 1781089200011 },
  { coin: 'BTC', fundingRate: '0.0000099992', premium: '-0.0004200064', time: 1781096400058 },
];

/** Build a fetch stub returning the given JSON bodies in call order. */
export function jsonFetchStub(
  bodies: unknown[],
): { fetch: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: stub, calls };
}
