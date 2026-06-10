import { describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import {
  formatKRW,
  formatPct,
  formatPrice,
  formatQty,
  formatTime,
  tickDecimals,
  truncateAddress,
} from '../src/lib/format.js';

describe('formatKRW', () => {
  it('formats zero', () => {
    expect(formatKRW(0n)).toBe('0');
  });

  it('adds thousands separators', () => {
    expect(formatKRW(toUnits('93130000'))).toBe('93,130,000');
  });

  it('handles negatives with separators and decimals', () => {
    expect(formatKRW(toUnits('-1234.5'))).toBe('-1,234.5');
  });

  it('handles tiny sub-unit values', () => {
    expect(formatKRW(123n)).toBe('0.00000123');
  });

  it('handles huge values without precision loss', () => {
    expect(formatKRW(toUnits('123456789012345'))).toBe('123,456,789,012,345');
  });

  it('trims trailing zeros', () => {
    expect(formatKRW(toUnits('100.10000000'))).toBe('100.1');
  });
});

describe('formatQty', () => {
  it('renders the smallest unit at 8dp', () => {
    expect(formatQty(1n)).toBe('0.00000001');
  });

  it('trims trailing zeros', () => {
    expect(formatQty(toUnits('1.23000000'))).toBe('1.23');
  });

  it('formats zero', () => {
    expect(formatQty(0n)).toBe('0');
  });

  it('handles negative quantities', () => {
    expect(formatQty(toUnits('-0.5'))).toBe('-0.5');
  });

  it('groups large integer parts', () => {
    expect(formatQty(toUnits('12345.678'))).toBe('12,345.678');
  });
});

describe('formatPrice', () => {
  it('derives 0dp from an integer tick', () => {
    expect(tickDecimals(toUnits('1000'))).toBe(0);
    expect(formatPrice(toUnits('93130000'), toUnits('1000'))).toBe('93,130,000');
  });

  it('pads to the tick decimals', () => {
    expect(formatPrice(toUnits('1.5'), toUnits('0.01'))).toBe('1.50');
  });

  it('rounds half-up to the tick decimals', () => {
    expect(formatPrice(toUnits('1.005'), toUnits('0.01'))).toBe('1.01');
  });

  it('handles 8dp ticks', () => {
    expect(formatPrice(123n, 1n)).toBe('0.00000123');
  });
});

describe('formatPct', () => {
  it('signs positive rates', () => {
    expect(formatPct(5_000_000n)).toBe('+5.00%');
  });

  it('rounds and signs negative rates', () => {
    expect(formatPct(-12_345_678n)).toBe('-12.35%');
  });

  it('formats zero without a sign', () => {
    expect(formatPct(0n)).toBe('0.00%');
  });

  it('drops the sign when rounding hits zero', () => {
    expect(formatPct(1_000n)).toBe('0.00%');
  });

  it('omits the plus sign when withSign=false', () => {
    expect(formatPct(5_000_000n, false)).toBe('5.00%');
  });
});

describe('formatTime / truncateAddress', () => {
  it('renders HH:MM:SS', () => {
    expect(formatTime(new Date(2026, 5, 10, 9, 5, 3).getTime())).toBe('09:05:03');
  });

  it('truncates ethereum addresses', () => {
    expect(truncateAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
  });
});
