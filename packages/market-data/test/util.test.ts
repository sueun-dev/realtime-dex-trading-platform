import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectBigIntId, fetchJson, numToUnits, quoteJsonIntegerFields } from '../src/util.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('numToUnits', () => {
  it('converts exchange numbers/strings to exact 1e8 bigints', () => {
    expect(numToUnits(93151000.0, 'p')).toBe(9315100000000000n);
    expect(numToUnits('61953.5', 'p')).toBe(6195350000000n);
    expect(numToUnits(0.00184778, 'q')).toBe(184778n);
    expect(numToUnits('-0.0000052185', 'r')).toBe(-521n); // truncates past 8 dp
  });

  it('normalizes JS exponent notation (1e-8) instead of throwing', () => {
    expect(numToUnits(1e-8, 'q')).toBe(1n);
    expect(numToUnits(5e-7, 'q')).toBe(50n);
    expect(numToUnits(1.5e-7, 'q')).toBe(15n);
    expect(numToUnits('2.5e3', 'q')).toBe(250000000000n); // 2500 * 1e8
    expect(numToUnits(1e21, 'q')).toBe(10n ** 29n); // "1e+21"
    expect(numToUnits(-5e-7, 'q')).toBe(-50n);
  });

  it('expands exponents exactly — truncates past 8 dp like toUnits, never rounds half-up', () => {
    expect(numToUnits(9.9e-9, 'q')).toBe(0n); // 0.0000000099 truncates to 0, toFixed(8) would round to 1
    expect(numToUnits(1.23456789e-1, 'q')).toBe(12345678n); // ...9 truncated, not rounded
  });

  it('rejects junk with a descriptive field name', () => {
    expect(() => numToUnits('abc', 'trade_price')).toThrow(/trade_price/);
    expect(() => numToUnits(null, 'trade_price')).toThrow(/trade_price/);
    expect(() => numToUnits(Number.NaN, 'trade_price')).toThrow(/non-finite/);
  });
});

describe('quoteJsonIntegerFields + expectBigIntId', () => {
  it('re-quotes bare integer fields so JSON.parse keeps >2^53 precision', () => {
    const text = '{"sequential_id":17811024497020001,"timestamp":1781102449702}';
    const parsed = JSON.parse(quoteJsonIntegerFields(text, ['sequential_id'])) as Record<string, unknown>;
    expect(parsed['sequential_id']).toBe('17811024497020001');
    expect(parsed['timestamp']).toBe(1781102449702); // untouched
    expect(expectBigIntId(parsed['sequential_id'], 'sequential_id', 'ctx')).toBe(17811024497020001n);
  });

  it('leaves decimals, exponents, and already-quoted values alone', () => {
    expect(quoteJsonIntegerFields('{"a":1.5}', ['a'])).toBe('{"a":1.5}');
    expect(quoteJsonIntegerFields('{"a":1e3}', ['a'])).toBe('{"a":1e3}');
    expect(quoteJsonIntegerFields('{"a":"123"}', ['a'])).toBe('{"a":"123"}');
    expect(quoteJsonIntegerFields('{"a": 42}', ['a'])).toBe('{"a": "42"}'); // whitespace tolerated
  });

  it('expectBigIntId accepts safe-integer numbers and digit strings, rejects the rest', () => {
    expect(expectBigIntId(42, 'id', 'ctx')).toBe(42n);
    expect(expectBigIntId('17811024497020001', 'id', 'ctx')).toBe(17811024497020001n);
    expect(() => expectBigIntId(1.5, 'id', 'ctx')).toThrow(/id/);
    expect(() => expectBigIntId(2 ** 53 + 2, 'id', 'ctx')).toThrow(/id/); // unsafe double — precision already lost
    expect(() => expectBigIntId('12a', 'id', 'ctx')).toThrow(/id/);
    expect(() => expectBigIntId(null, 'id', 'ctx')).toThrow(/id/);
  });
});

describe('fetchJson', () => {
  it('aborts after the timeout with a descriptive error', async () => {
    vi.stubGlobal('fetch', ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as typeof fetch);
    await expect(fetchJson('https://example.invalid/x', { timeoutMs: 20 })).rejects.toThrow(
      /network failure.*timed out after 20ms/,
    );
  });

  it('includes status and body snippet on non-200', async () => {
    vi.stubGlobal('fetch', (async () =>
      new Response('{"error":"rate limit"}', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch);
    await expect(fetchJson('https://example.invalid/x')).rejects.toThrow(/HTTP 429.*rate limit/);
  });

  it('reports invalid JSON bodies', async () => {
    vi.stubGlobal('fetch', (async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch);
    await expect(fetchJson('https://example.invalid/x')).rejects.toThrow(/invalid JSON/);
  });
});
