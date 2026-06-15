import { describe, expect, it } from 'vitest';
import { toUnits, type Ticker } from '@dex/shared';
import { buildPerpMarkets, buildSpotMarkets, perpTickFromMid } from '../src/universe.js';
import { HL_ALLMIDS_FIXTURE, HL_META_FIXTURE, UPBIT_MARKETS_FIXTURE, UPBIT_TICKER_FIXTURE } from './fixtures.js';

describe('buildSpotMarkets — DEX spot from Upbit USDT books, presented as <BASE>-USDC', () => {
  const tickers: Ticker[] = [
    {
      marketId: 'USDT-BTC',
      price: toUnits('67500'),
      change24h: 643941n,
      high24h: toUnits('68200'),
      low24h: toUnits('66800'),
      volume24h: toUnits('12809661.34'),
      ts: 1781102448112,
    },
    {
      marketId: 'USDT-XRP',
      price: toUnits('2.4153'),
      change24h: -1113716n,
      high24h: toUnits('2.51'),
      low24h: toUnits('2.39'),
      volume24h: toUnits('15113992.96'),
      ts: 1781102447160,
    },
  ];

  it('keeps only USDT-* markets (not KRW/BTC/self) and quotes them in USDC', () => {
    const configs = buildSpotMarkets(UPBIT_MARKETS_FIXTURE, tickers);
    expect(configs.map((c) => c.id)).toEqual(['PEPE-USDC', 'WAXP-USDC', 'BTC-USDC', 'ETH-USDC', 'XRP-USDC']);
    const btc = configs.find((c) => c.id === 'BTC-USDC')!;
    expect(btc).toEqual({
      id: 'BTC-USDC',
      type: 'spot',
      base: 'BTC',
      quote: 'USDC',
      koreanName: '비트코인',
      englishName: 'Bitcoin',
      tickSize: toUnits('1'), // 5 sig figs from $67,500
      lotSize: 1n,
      minNotional: toUnits('1'),
      makerFeeBps: 2,
      takerFeeBps: 2,
      maxLeverage: 1,
    });
    const xrp = configs.find((c) => c.id === 'XRP-USDC')!;
    expect(xrp.tickSize).toBe(toUnits('0.0001')); // 5 sig figs from $2.4153
  });

  it('falls back to a coarse tick when no ticker is available', () => {
    const configs = buildSpotMarkets(UPBIT_MARKETS_FIXTURE);
    for (const c of configs) expect(c.tickSize).toBe(toUnits('0.0001'));
  });
});

describe('perpTickFromMid — 5 significant figures', () => {
  it('matches 10^(floor(log10(mid units)) - 4) with a 1-unit floor', () => {
    expect(perpTickFromMid(toUnits('61953.5'))).toBe(toUnits('1')); // BTC: 5 sig figs → 1 USDC
    expect(perpTickFromMid(toUnits('1643.35'))).toBe(toUnits('0.1')); // ETH
    expect(perpTickFromMid(toUnits('64.7925'))).toBe(toUnits('0.001')); // SOL
    expect(perpTickFromMid(toUnits('0.5'))).toBe(toUnits('0.00001'));
    expect(perpTickFromMid(toUnits('0.00005'))).toBe(1n); // floor at 1 unit
    expect(perpTickFromMid(1n)).toBe(1n);
    // exact powers of ten sit on the boundary
    expect(perpTickFromMid(toUnits('10000'))).toBe(toUnits('1')); // 5 sig figs of 10000 → 1
    expect(perpTickFromMid(toUnits('9999.99'))).toBe(toUnits('0.1'));
  });

  it('also enforces HL max decimals = 6 - szDecimals when szDecimals is given', () => {
    // 5 sig figs alone would allow 1e-7, but szDecimals 0 caps prices at 6 dp
    expect(perpTickFromMid(toUnits('0.0012345'))).toBe(toUnits('0.0000001'));
    expect(perpTickFromMid(toUnits('0.0012345'), 0)).toBe(toUnits('0.000001'));
    // cap not binding for normal coins
    expect(perpTickFromMid(toUnits('61953.5'), 5)).toBe(toUnits('1')); // BTC
    expect(perpTickFromMid(toUnits('1643.35'), 4)).toBe(toUnits('0.1')); // ETH
    expect(perpTickFromMid(toUnits('64.7925'), 2)).toBe(toUnits('0.001')); // SOL
    expect(perpTickFromMid(toUnits('0.5'), 1)).toBe(toUnits('0.00001')); // exactly at the 5-dp cap
    // out-of-range szDecimals clamps to a sane tick
    expect(perpTickFromMid(toUnits('1'), 8)).toBe(toUnits('1')); // 6-8 → 0 dp
    expect(perpTickFromMid(toUnits('0.5'), -2)).toBe(toUnits('0.00001')); // dp capped at 8
  });
});

describe('buildPerpMarkets', () => {
  const mids = new Map<string, bigint>(
    Object.entries(HL_ALLMIDS_FIXTURE)
      .filter(([k]) => !k.startsWith('@') && !k.startsWith('#'))
      .map(([k, v]) => [k, toUnits(v)]),
  );

  it('builds configs from the real universe, skipping delisted and mid-less coins', () => {
    const configs = buildPerpMarkets(HL_META_FIXTURE.universe, mids);
    // ATOM has no mid, MATIC is delisted → skipped
    expect(configs.map((c) => c.id)).toEqual(['BTC-PERP', 'ETH-PERP', 'DYDX-PERP', 'SOL-PERP']);
    const btc = configs[0]!;
    expect(btc).toEqual({
      id: 'BTC-PERP',
      type: 'perp',
      base: 'BTC',
      quote: 'USDC',
      koreanName: null,
      englishName: 'BTC',
      tickSize: toUnits('1'), // 61953.5 → 5 sig figs
      lotSize: 1000n, // szDecimals 5 → 10^(8-5)
      minNotional: toUnits('10'),
      makerFeeBps: 2,
      takerFeeBps: 2,
      maxLeverage: 40,
    });
    const eth = configs[1]!;
    expect(eth.lotSize).toBe(10000n); // szDecimals 4
    expect(eth.tickSize).toBe(toUnits('0.1'));
    expect(eth.maxLeverage).toBe(25);
    const sol = configs[3]!;
    expect(sol.lotSize).toBe(1000000n); // szDecimals 2
    expect(sol.tickSize).toBe(toUnits('0.001'));
  });

  it('respects topN', () => {
    const configs = buildPerpMarkets(HL_META_FIXTURE.universe, mids, 2);
    expect(configs.map((c) => c.id)).toEqual(['BTC-PERP', 'ETH-PERP']);
  });

  it('clamps szDecimals to 0..8 for lot size math', () => {
    const configs = buildPerpMarkets(
      [
        { name: 'WEIRDA', szDecimals: 12, maxLeverage: 3 },
        { name: 'WEIRDB', szDecimals: -2, maxLeverage: 3 },
      ],
      new Map([
        ['WEIRDA', toUnits('1')],
        ['WEIRDB', toUnits('1')],
      ]),
    );
    expect(configs[0]!.lotSize).toBe(1n); // clamp 12 → 8 → 10^0
    expect(configs[1]!.lotSize).toBe(100000000n); // clamp -2 → 0 → 10^8
  });
});
