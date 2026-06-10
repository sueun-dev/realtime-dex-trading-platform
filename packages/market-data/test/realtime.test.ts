/**
 * Real-venue depth/print parsing. Fixtures are verbatim frames captured live
 * 2026-06-10T21:44Z from wss://api.upbit.com/websocket/v1 and
 * wss://api.hyperliquid.xyz/ws (trimmed to 3-4 entries).
 */
import { describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import { parseUpbitWsFrame } from '../src/upbitWs.js';
import { parseHlL2Book, parseHlTrades } from '../src/hyperliquidWs.js';

const UPBIT_ORDERBOOK_FRAME = `{"type":"orderbook","code":"KRW-BTC","timestamp":1781123069065,"total_ask_size":2.24796018,"total_bid_size":3.00442002,"orderbook_units":[{"ask_price":93332000,"bid_price":93274000,"ask_size":0.00107145,"bid_size":0.05595163},{"ask_price":93339000,"bid_price":93272000,"ask_size":0.0020735,"bid_size":0.00646489},{"ask_price":93367000,"bid_price":93271000,"ask_size":0.00005357,"bid_size":0.17620263},{"ask_price":93368000,"bid_price":93269000,"ask_size":0.07281524,"bid_size":0.08183181}],"stream_type":"SNAPSHOT","level":0}`;

const HL_L2BOOK_DATA = JSON.parse(
  `{"coin":"BTC","time":1781123068176,"levels":[[{"px":"61875.0","sz":"6.10265","n":25},{"px":"61874.0","sz":"0.15477","n":3},{"px":"61873.0","sz":"3.83529","n":12},{"px":"61872.0","sz":"0.26708","n":6}],[{"px":"61876.0","sz":"0.49742","n":4},{"px":"61877.0","sz":"0.00034","n":2},{"px":"61878.0","sz":"0.00034","n":2},{"px":"61879.0","sz":"0.00034","n":2}]]}`,
) as unknown;

const HL_TRADES_DATA = JSON.parse(
  `[{"coin":"BTC","side":"B","px":"61870.0","sz":"0.00017","time":1781123059414,"hash":"0xc3f4","tid":793409250578087,"users":["0x89e2","0xf5d8"]},{"coin":"BTC","side":"A","px":"61869.0","sz":"0.09","time":1781123059500,"hash":"0xc3f4","tid":893648766302328,"users":["0x89e2","0x6a07"]}]`,
) as unknown;

describe('Upbit WS orderbook frame (real venue depth)', () => {
  it('parses prices and sizes exactly, bids desc / asks asc', () => {
    const frame = parseUpbitWsFrame(UPBIT_ORDERBOOK_FRAME);
    if (frame.kind !== 'orderbook') throw new Error(`expected orderbook, got ${frame.kind}`);
    const ob = frame.orderbook;
    expect(ob.marketId).toBe('KRW-BTC');
    expect(ob.ts).toBe(1781123069065);
    expect(ob.bids).toHaveLength(4);
    expect(ob.asks).toHaveLength(4);
    expect(ob.bids[0]).toEqual({ price: toUnits('93274000'), qty: toUnits('0.05595163') });
    expect(ob.asks[0]).toEqual({ price: toUnits('93332000'), qty: toUnits('0.00107145') });
    for (let i = 1; i < 4; i++) {
      expect(ob.bids[i]!.price < ob.bids[i - 1]!.price).toBe(true);
      expect(ob.asks[i]!.price > ob.asks[i - 1]!.price).toBe(true);
    }
    // never crossed
    expect(ob.bids[0]!.price < ob.asks[0]!.price).toBe(true);
  });

  it('rejects malformed orderbook frames', () => {
    expect(() => parseUpbitWsFrame('{"type":"orderbook","code":"KRW-BTC"}')).toThrow();
    expect(() =>
      parseUpbitWsFrame(
        '{"type":"orderbook","code":"KRW-BTC","timestamp":1,"orderbook_units":[{"ask_price":"abc","bid_price":1,"ask_size":1,"bid_size":1}]}',
      ),
    ).toThrow();
  });
});

describe('Hyperliquid l2Book (real venue depth)', () => {
  it('parses levels exactly with bigint units', () => {
    const book = parseHlL2Book(HL_L2BOOK_DATA);
    expect(book.coin).toBe('BTC');
    expect(book.bids[0]).toEqual({ price: toUnits('61875'), qty: toUnits('6.10265') });
    expect(book.asks[0]).toEqual({ price: toUnits('61876'), qty: toUnits('0.49742') });
    expect(book.bids).toHaveLength(4);
    expect(book.asks).toHaveLength(4);
    expect(book.bids[0]!.price < book.asks[0]!.price).toBe(true);
  });

  it('rejects payloads without [bids, asks]', () => {
    expect(() => parseHlL2Book({ coin: 'BTC', time: 1, levels: [[]] })).toThrow();
  });
});

describe('Hyperliquid trades (real venue prints)', () => {
  it('parses side B→buy / A→sell with exact px/sz', () => {
    const trades = parseHlTrades(HL_TRADES_DATA);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({
      coin: 'BTC',
      side: 'buy',
      price: toUnits('61870'),
      qty: toUnits('0.00017'),
      ts: 1781123059414,
      tid: '793409250578087',
    });
    expect(trades[1]!.side).toBe('sell');
  });

  it('rejects unknown sides instead of guessing', () => {
    expect(() =>
      parseHlTrades([{ coin: 'BTC', side: 'X', px: '1', sz: '1', time: 1, tid: 1 }]),
    ).toThrow(/unexpected side/);
  });
});
