import { toUnits } from '@dex/shared';

/**
 * Expand exponent notation (e.g. `1.5e-7`, `1e+21`) to plain decimal form by
 * shifting the decimal point EXACTLY — no rounding — so toUnits' documented
 * truncation semantics are preserved. Non-exponent strings pass through.
 */
function expandExponent(s: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (m === null) return s; // not exponent notation — let toUnits report it
  const sign = m[1] === '-' ? '-' : '';
  const digits = m[2]! + (m[3] ?? '');
  const pointPos = m[2]!.length + Number(m[4]!);
  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`;
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/**
 * Convert an exchange-provided numeric value (number or decimal string) into
 * 1e8 fixed-point bigint units. Goes through `toUnits(String(x))` per the
 * project contract; exponent notation (e.g. `1e-8` from JS number stringify)
 * is expanded to fixed notation exactly (no rounding) so toUnits' decimal
 * grammar accepts it and its truncation semantics hold past 8 dp.
 */
export function numToUnits(value: unknown, field: string): bigint {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') {
    throw new Error(`expected numeric value for ${field}, got ${typeof value}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`non-finite numeric value for ${field}: ${value}`);
  }
  if (typeof value === 'bigint') return toUnits(value);
  let s = String(value).trim();
  if (/[eE]/.test(s)) {
    s = expandExponent(s);
  }
  try {
    return toUnits(s);
  } catch (err) {
    throw new Error(`cannot parse ${field} value ${JSON.stringify(value)}: ${(err as Error).message}`);
  }
}

/**
 * Re-quote bare integer values of the named fields in raw JSON text so that
 * `JSON.parse` cannot round them through a double (64-bit ids like Upbit's
 * `sequential_id` exceed 2^53). Only bare integer literals are touched;
 * decimal/exponent values and already-quoted strings are left alone. (The
 * regex would also match inside string values containing `"<field>":<int>`,
 * which cannot occur in the fixed-schema exchange payloads this is used for.)
 */
export function quoteJsonIntegerFields(text: string, fields: string[]): string {
  let out = text;
  for (const field of fields) {
    const re = new RegExp(`("${field}"\\s*:\\s*)(-?\\d+)(?![\\d.eE])`, 'g');
    out = out.replace(re, '$1"$2"');
  }
  return out;
}

/** Parse a (possibly re-quoted) integer id into a bigint, exactly. */
export function expectBigIntId(value: unknown, field: string, context: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`${context}: expected integer id field ${field}, got ${JSON.stringify(value)}`);
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  /**
   * Integer fields to re-quote in the raw response text before JSON.parse so
   * values beyond 2^53 keep full precision (read back via `expectBigIntId`).
   */
  bigIntFields?: string[];
  /** extra request headers (e.g. a User-Agent some venues require) */
  headers?: Record<string, string>;
}

/** fetch + JSON with abort timeout and descriptive errors on non-200 / bad JSON. */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const { method = 'GET', body, timeoutMs = 10_000, headers } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  let res: Response;
  try {
    const init: RequestInit = { method, signal: ctrl.signal };
    const hdrs: Record<string, string> = { ...headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      hdrs['Content-Type'] = 'application/json';
    }
    if (Object.keys(hdrs).length > 0) init.headers = hdrs;
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`${method} ${url} network failure: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* body unreadable — status alone is enough */
    }
    throw new Error(`${method} ${url} failed: HTTP ${res.status} ${res.statusText} ${detail}`.trimEnd());
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new Error(`${method} ${url} body read failed: ${(err as Error).message}`, { cause: err });
  }
  if (opts.bigIntFields !== undefined) text = quoteJsonIntegerFields(text, opts.bigIntFields);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${method} ${url} returned invalid JSON: ${(err as Error).message}`, { cause: err });
  }
}

export function expectArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected JSON array, got ${value === null ? 'null' : typeof value}`);
  }
  return value;
}

export function expectObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context}: expected JSON object, got ${value === null ? 'null' : typeof value}`);
  }
  return value as Record<string, unknown>;
}

export function expectString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${context}: expected string field ${field}, got ${typeof value}`);
  }
  return value;
}

export function expectNumber(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context}: expected finite number field ${field}, got ${String(value)}`);
  }
  return value;
}
