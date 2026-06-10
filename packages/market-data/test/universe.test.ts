import { describe, expect, it } from 'vitest';
import { toUnits, type Ticker } from '@dex/shared';
import { buildPerpMarkets, buildSpotMarkets, perpTickFromMid, upbitKrwTick } from '../src/universe.js';
import { HL_ALLMIDS_FIXTURE, HL_META_FIXTURE, UPBIT_MARKETS_FIXTURE, UPBIT_TICKER_FIXTURE } from './fixtures.js';

describe('upbitKrwTick — official KRW tick table (effective 2025-07-31), every boundary, both sides', () => {
  // Source: docs.upbit.com/kr/docs/krw-market-info_250731
  // (changelog krw_tick_unit_change_250731, "호가 단위 (변경)" column).
  const boundaries: { at: string; tickAtOrAbove: string; tickBelow: string }[] = [
    { at: '2000000', tickAtOrAbove: '1000', tickBelow: '1000' }, // 1M–2M shares the 1,000 tick
    { at: '1000000', tickAtOrAbove: '1000', tickBelow: '500' },
    { at: '500000', tickAtOrAbove: '500', tickBelow: '100' },
    { at: '100000', tickAtOrAbove: '100', tickBelow: '50' },
    { at: '50000', tickAtOrAbove: '50', tickBelow: '10' },
    { at: '10000', tickAtOrAbove: '10', tickBelow: '5' },
    { at: '5000', tickAtOrAbove: '5', tickBelow: '1' },
    { at: '1000', tickAtOrAbove: '1', tickBelow: '1' }, // 100–1K shares the 1 tick
    { at: '100', tickAtOrAbove: '1', tickBelow: '0.1' },
    { at: '10', tickAtOrAbove: '0.1', tickBelow: '0.01' },
    { at: '1', tickAtOrAbove: '0.01', tickBelow: '0.001' },
    { at: '0.1', tickAtOrAbove: '0.001', tickBelow: '0.0001' },
    { at: '0.01', tickAtOrAbove: '0.0001', tickBelow: '0.00001' },
    { at: '0.001', tickAtOrAbove: '0.00001', tickBelow: '0.000001' },
    { at: '0.0001', tickAtOrAbove: '0.000001', tickBelow: '0.0000001' },
    { at: '0.00001', tickAtOrAbove: '0.0000001', tickBelow: '0.00000001' },
  ];

  for (const b of boundaries) {
    it(`price ${b.at}: at boundary → ${b.tickAtOrAbove}, one unit below → ${b.tickBelow}`, () => {
      const price = toUnits(b.at);
      expect(upbitKrwTick(price)).toBe(toUnits(b.tickAtOrAbove));
      expect(upbitKrwTick(price - 1n)).toBe(toUnits(b.tickBelow));
      expect(upbitKrwTick(price + 1n)).toBe(toUnits(b.tickAtOrAbove));
    });
  }

  it('real prices: BTC 93,151,000 → 1000; XRP 1,687 → 1; DOGE-ish 339.5 → 1; WAXP-ish 35.5 → 0.1; dust → 0.00000001', () => {
    expect(upbitKrwTick(toUnits('93151000'))).toBe(toUnits('1000'));
    expect(upbitKrwTick(toUnits('1687'))).toBe(toUnits('1'));
    expect(upbitKrwTick(toUnits('339.5'))).toBe(toUnits('1')); // pre-2025-07-31 table would say 0.1
    expect(upbitKrwTick(toUnits('35.5'))).toBe(toUnits('0.1')); // pre-2025-07-31 table would say 0.01
    expect(upbitKrwTick(toUnits('0.0001'))).toBe(toUnits('0.000001'));
    expect(upbitKrwTick(toUnits('0.000009'))).toBe(1n); // < 0.00001 KRW band
    expect(upbitKrwTick(0n)).toBe(1n);
  });
});

describe('buildSpotMarkets', () => {
  const tickers: Ticker[] = [
    {
      marketId: 'KRW-BTC',
      price: toUnits('93151000'),
      change24h: 643941n,
      high24h: toUnits('93848000'),
      low24h: toUnits('91500000'),
      volume24h: toUnits('128096613472.80703'),
      ts: 1781102448112,
    },
    {
      marketId: 'KRW-XRP',
      price: toUnits('1687'),
      change24h: -1113716n,
      high24h: toUnits('1710'),
      low24h: toUnits('1656'),
      volume24h: toUnits('151139921563.96792238'),
      ts: 1781102447160,
    },
  ];

  it('keeps only KRW-* markets and fills the MarketConfig contract', () => {
    const configs = buildSpotMarkets(UPBIT_MARKETS_FIXTURE, tickers);
    expect(configs.map((c) => c.id)).toEqual(['KRW-WAXP', 'KRW-CARV', 'KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
    const btc = configs.find((c) => c.id === 'KRW-BTC')!;
    expect(btc).toEqual({
      id: 'KRW-BTC',
      type: 'spot',
      base: 'BTC',
      quote: 'KRW',
      koreanName: '비트코인',
      englishName: 'Bitcoin',
      tickSize: toUnits('1000'), // from live price 93,151,000
      lotSize: 1n,
      minNotional: toUnits('5000'),
      makerFeeBps: 2,
      takerFeeBps: 2,
      maxLeverage: 1,
    });
    const xrp = configs.find((c) => c.id === 'KRW-XRP')!;
    expect(xrp.tickSize).toBe(toUnits('1')); // 1,687 KRW → 1 KRW tick
  });

  it('falls back to a 1 KRW tick when no ticker is available', () => {
    const configs = buildSpotMarkets(UPBIT_MARKETS_FIXTURE);
    for (const c of configs) expect(c.tickSize).toBe(toUnits('1'));
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
