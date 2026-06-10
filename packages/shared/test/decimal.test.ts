import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DECIMALS,
  SCALE,
  divRound,
  divUnits,
  feeOn,
  fromUnits,
  isMultipleOf,
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
