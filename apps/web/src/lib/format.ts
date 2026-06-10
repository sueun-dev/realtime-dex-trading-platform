/**
 * Display-only formatting helpers. All inputs are 1e8 fixed-point bigints from
 * @dex/shared. Arithmetic stays in bigint; only the final string rendering may
 * touch JS number (and only for non-monetary things like bar widths elsewhere).
 */
import { SCALE, divRound, fromUnits } from '@dex/shared';

/** Insert thousands separators into the integer part of a decimal string. */
function groupDecimalString(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart = '0', frac] = body.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac !== undefined && frac.length > 0 ? `.${frac}` : ''}`;
}

/** KRW-style amount: thousands separators, trailing zeros trimmed. */
export function formatKRW(units: bigint): string {
  return groupDecimalString(fromUnits(units));
}

/** Decimal places implied by a market tick size (1e8 units). */
export function tickDecimals(tickSize: bigint): number {
  const s = fromUnits(tickSize);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Market-aware price: rounded (half-up) and padded to the tick's dp, grouped. */
export function formatPrice(units: bigint, tickSize: bigint): string {
  const dp = tickDecimals(tickSize);
  const pow = 10n ** BigInt(8 - dp);
  const rounded = divRound(units, pow, 'half-up') * pow;
  return groupDecimalString(fromUnits(rounded, dp));
}

/** Quantity: up to 8 dp, trailing zeros trimmed, grouped integer part. */
export function formatQty(units: bigint): string {
  return groupDecimalString(fromUnits(units));
}

/**
 * Percentage from a 1e8-scaled rate (0.05 → 5_000_000n → "+5.00%").
 * Always two decimal places; positive sign optional.
 */
export function formatPct(rate: bigint, withSign = true): string {
  const hundredths = divRound(rate * 10_000n, SCALE, 'half-up');
  const neg = hundredths < 0n;
  const abs = neg ? -hundredths : hundredths;
  const intPart = groupDecimalString((abs / 100n).toString());
  const frac = (abs % 100n).toString().padStart(2, '0');
  const sign = neg ? '-' : withSign && hundredths > 0n ? '+' : '';
  return `${sign}${intPart}.${frac}%`;
}

/** HH:MM:SS from epoch ms (display only). */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 0x1234…abcd */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
