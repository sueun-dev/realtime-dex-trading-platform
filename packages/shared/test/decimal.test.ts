import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DECIMALS,
  SCALE,
  divRound,
  divUnits,
  emaStep,
  feeOn,
  fromUnits,
  isMultipleOf,
  medianBig,
  mulUnits,
  roundToLot,
  roundToTick,
  toUnits,
} from '../src/decimal.js';

describe('toUnits / fromUnits', () => {
  it('parses integers, decimals, negatives', () => {
    expect(toUnits('1')).toBe(SCALE);
    expect(toUnits('93130000')).toBe(93_130_000n * SCALE);
    expect(toUnits('0.00000001')).toBe(1n);
    expect(toUnits('-2.5')).toBe(-250_000_000n);
    expect(toUnits(7)).toBe(700_000_000n);
    expect(toUnits(5n)).toBe(500_000_000n);
  });

  it('truncates beyond 8 dp', () => {
    expect(toUnits('0.000000019')).toBe(1n);
  });

  it('rejects junk', () => {
    for (const bad of ['', 'abc', '1e5', '1.', '.5', '--1', '1,000', 'NaN', 'Infinity']) {
      expect(() => toUnits(bad), bad).toThrow(RangeError);
    }
  });

  it('round-trips every value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), (u) => {
        expect(toUnits(fromUnits(u))).toBe(u);
      }),
    );
  });

  it('formats with minDp', () => {
    expect(fromUnits(150_000_000n, 2)).toBe('1.50');
    expect(fromUnits(0n)).toBe('0');
    expect(fromUnits(-1n)).toBe('-0.00000001');
  });
});

describe('divRound', () => {
  it('floor goes toward -infinity for negatives', () => {
    expect(divRound(-7n, 2n, 'floor')).toBe(-4n);
    expect(divRound(7n, 2n, 'floor')).toBe(3n);
    expect(divRound(-7n, -2n, 'floor')).toBe(3n);
  });
  it('ceil goes toward +infinity', () => {
    expect(divRound(-7n, 2n, 'ceil')).toBe(-3n);
    expect(divRound(7n, 2n, 'ceil')).toBe(4n);
  });
  it('half-up rounds .5 away from zero', () => {
    expect(divRound(5n, 2n, 'half-up')).toBe(3n);
    expect(divRound(-5n, 2n, 'half-up')).toBe(-3n);
    expect(divRound(4n, 3n, 'half-up')).toBe(1n);
  });
  it('throws on zero denominator', () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
  it('matches exact rational rounding for all modes', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (n, d) => {
          const fl = divRound(n, d, 'floor');
          const ce = divRound(n, d, 'ceil');
          expect(fl * d <= n).toBe(true);
          expect((fl + 1n) * d > n).toBe(true);
          expect(ce * d >= n).toBe(true);
          expect((ce - 1n) * d < n).toBe(true);
        },
      ),
    );
  });
});

describe('mulUnits / divUnits', () => {
  it('qty × price = notional', () => {
    // 0.5 BTC × ₩93,130,000 = ₩46,565,000
    expect(mulUnits(toUnits('0.5'), toUnits('93130000'))).toBe(toUnits('46565000'));
  });
  it('inverse within 1 unit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 16n }),
        fc.bigInt({ min: 1n, max: 10n ** 16n }),
        (a, b) => {
          const prod = mulUnits(a, b);
          const back = divUnits(prod, b);
          expect(back <= a).toBe(true);
          expect(a - back <= divRound(SCALE, b, 'ceil') + 1n).toBe(true);
        },
      ),
    );
  });
});

describe('feeOn', () => {
  it('rounds up', () => {
    expect(feeOn(10_000n, 10)).toBe(10n);
    expect(feeOn(10_001n, 10)).toBe(11n);
    expect(feeOn(0n, 10)).toBe(0n);
  });
  it('rejects bad bps', () => {
    expect(() => feeOn(1n, -1)).toThrow(RangeError);
    expect(() => feeOn(1n, 1.5)).toThrow(RangeError);
  });
});

describe('tick/lot', () => {
  it('roundToTick half-up', () => {
    expect(roundToTick(toUnits('100.4'), toUnits('1'))).toBe(toUnits('100'));
    expect(roundToTick(toUnits('100.5'), toUnits('1'))).toBe(toUnits('101'));
  });
  it('roundToLot floors', () => {
    expect(roundToLot(toUnits('0.999'), toUnits('0.01'))).toBe(toUnits('0.99'));
  });
  it('isMultipleOf', () => {
    expect(isMultipleOf(toUnits('100'), toUnits('0.5'))).toBe(true);
    expect(isMultipleOf(toUnits('100.3'), toUnits('0.5'))).toBe(false);
  });
  it('DECIMALS consistency', () => {
    expect(10n ** BigInt(DECIMALS)).toBe(SCALE);
  });
});

describe('medianBig — manipulation-resistant mark aggregation', () => {
  it('odd count returns the middle, even count the floor-average', () => {
    expect(medianBig([toUnits('3'), toUnits('1'), toUnits('2')])).toBe(toUnits('2'));
    expect(medianBig([toUnits('1'), toUnits('2'), toUnits('3'), toUnits('4')])).toBe(toUnits('2.5'));
    expect(medianBig([toUnits('65832.7')])).toBe(toUnits('65832.7'));
  });
  it('a single manipulated source cannot move the median of >=3 real sources', () => {
    const real = [toUnits('65832'), toUnits('65806'), toUnits('65820')];
    const honest = medianBig(real);
    // one source spikes 10x — median is unmoved (still a real middle price)
    const attacked = medianBig([...real, toUnits('658320')]);
    expect(honest).toBe(toUnits('65820'));
    // with the 4th (even count) it shifts only to the floor-avg of the two middles,
    // never to the manipulated value
    expect(attacked).toBe(divRound(toUnits('65820') + toUnits('65832'), 2n, 'floor'));
    expect(attacked < toUnits('65840')).toBe(true);
  });
  it('throws on an empty list (a mark needs >=1 real source)', () => {
    expect(() => medianBig([])).toThrow(RangeError);
  });
  it('property: median lies within [min,max] and equals the sorted middle', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 10n ** 14n }), { minLength: 1, maxLength: 9 }), (xs) => {
        const m = medianBig(xs);
        const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        expect(m >= sorted[0]!).toBe(true);
        expect(m <= sorted[sorted.length - 1]!).toBe(true);
        if (xs.length % 2 === 1) expect(m).toBe(sorted[xs.length >> 1]!);
      }),
    );
  });
});

describe('emaStep', () => {
  it('seeds with the first sample, then converges toward new values', () => {
    expect(emaStep(null, toUnits('100'), toUnits('0.2'))).toBe(toUnits('100'));
    // prev=100, next=110, α=0.2 → 100 + 0.2*10 = 102
    expect(emaStep(toUnits('100'), toUnits('110'), toUnits('0.2'))).toBe(toUnits('102'));
    // α=1 → tracks next exactly
    expect(emaStep(toUnits('100'), toUnits('110'), toUnits('1'))).toBe(toUnits('110'));
  });
  it('property: EMA stays between prev and next (never overshoots) for 0<α<=1', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.bigInt({ min: 1n, max: SCALE }),
        (prev, next, alpha) => {
          const out = emaStep(prev, next, alpha);
          const lo = prev < next ? prev : next;
          const hi = prev < next ? next : prev;
          expect(out >= lo && out <= hi).toBe(true);
        },
      ),
    );
  });
});
