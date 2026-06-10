/**
 * Fixed-point bigint arithmetic. ALL money/price/qty values in the system are
 * bigints scaled by 1e8. JS `number` must never hold a monetary value.
 */

export const DECIMALS = 8;
export const SCALE = 10n ** 8n;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export type RoundMode = 'floor' | 'ceil' | 'trunc' | 'half-up';

/** Parse a decimal string (or integer number) into 1e8-scaled units. Truncates past 8 dp. */
export function toUnits(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value * SCALE;
  const s = typeof value === 'number' ? value.toString() : value.trim();
  if (!DECIMAL_RE.test(s)) {
    throw new RangeError(`invalid decimal string: ${JSON.stringify(value)}`);
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart = '0', fracPartRaw = ''] = body.split('.');
  const fracPart = fracPartRaw.slice(0, DECIMALS).padEnd(DECIMALS, '0');
  const units = BigInt(intPart) * SCALE + BigInt(fracPart || '0');
  return neg ? -units : units;
}

/** Format 1e8-scaled units back to a decimal string (trailing zeros trimmed). */
export function fromUnits(units: bigint, minDp = 0): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const intPart = abs / SCALE;
  let frac = (abs % SCALE).toString().padStart(DECIMALS, '0');
  frac = frac.replace(/0+$/, '');
  while (frac.length < minDp) frac += '0';
  const s = frac.length > 0 ? `${intPart}.${frac}` : intPart.toString();
  return neg ? `-${s}` : s;
}

/** Division with explicit rounding, correct for negative values. */
export function divRound(num: bigint, den: bigint, mode: RoundMode = 'floor'): bigint {
  if (den === 0n) throw new RangeError('division by zero');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  switch (mode) {
    case 'trunc':
      return q;
    case 'floor':
      return num < 0n ? q - 1n : q;
    case 'ceil':
      return num < 0n ? q : q + 1n;
    case 'half-up': {
      const absR = r < 0n ? -r : r;
      if (absR * 2n >= den) return num < 0n ? q - 1n : q + 1n;
      return q;
    }
  }
}

/** (a * b) / d with rounding. */
export function mulDiv(a: bigint, b: bigint, d: bigint, mode: RoundMode = 'floor'): bigint {
  return divRound(a * b, d, mode);
}

/** Multiply two 1e8-scaled values → 1e8-scaled. e.g. qty × price → notional. */
export function mulUnits(a: bigint, b: bigint, mode: RoundMode = 'floor'): bigint {
  return divRound(a * b, SCALE, mode);
}

/** Divide two 1e8-scaled values → 1e8-scaled. */
export function divUnits(a: bigint, b: bigint, mode: RoundMode = 'floor'): bigint {
  if (b === 0n) throw new RangeError('division by zero');
  return divRound(a * SCALE, b, mode);
}

/** Fee on `amount` at `bps` basis points, rounded up (house never undercollects). */
export function feeOn(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`invalid bps: ${bps}`);
  return divRound(amount * BigInt(bps), 10_000n, 'ceil');
}

/** Round a price to the market tick size. */
export function roundToTick(price: bigint, tick: bigint, mode: RoundMode = 'half-up'): bigint {
  if (tick <= 0n) throw new RangeError('tick must be > 0');
  return divRound(price, tick, mode) * tick;
}

/** Round a quantity down to the market lot size. */
export function roundToLot(qty: bigint, lot: bigint): bigint {
  if (lot <= 0n) throw new RangeError('lot must be > 0');
  return (qty / lot) * lot;
}

export function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) throw new RangeError('step must be > 0');
  return value % step === 0n;
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function signBig(v: bigint): -1n | 0n | 1n {
  return v < 0n ? -1n : v > 0n ? 1n : 0n;
}
