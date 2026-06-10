/** HTTP rate limiting: hard 429 with our error body, per-route auth caps. */
import { describe, expect, it } from 'vitest';
import { login, makeApp } from './helpers.js';

describe('rate limiting', () => {
  it('global limiter returns 429 RATE_LIMITED past the cap', async () => {
    const t = await makeApp({ rateLimit: { max: 5, windowSec: 60 } });
    try {
      for (let i = 0; i < 5; i++) {
        const res = await t.app.inject({ method: 'GET', url: '/api/health' });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await t.app.inject({ method: 'GET', url: '/api/health' });
      expect(blocked.statusCode).toBe(429);
      expect((blocked.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    } finally {
      await t.stop();
    }
  });

  it('auth endpoints get their own stricter cap', async () => {
    const t = await makeApp({ rateLimit: { max: 1000, windowSec: 60, authMax: 2 } });
    try {
      const address = `0x${'1'.repeat(40)}`;
      for (let i = 0; i < 2; i++) {
        const res = await t.app.inject({
          method: 'POST',
          url: '/api/auth/nonce',
          payload: { address },
        });
        expect(res.statusCode).toBe(200);
      }
      const blocked = await t.app.inject({
        method: 'POST',
        url: '/api/auth/nonce',
        payload: { address },
      });
      expect(blocked.statusCode).toBe(429);
      expect((blocked.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
      // the global budget is untouched by the per-route limiter
      const health = await t.app.inject({ method: 'GET', url: '/api/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await t.stop();
    }
  });

  it('rate limiting disabled (test default) never throttles bursts', async () => {
    const t = await makeApp();
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, () => t.app.inject({ method: 'GET', url: '/api/health' })),
      );
      for (const r of results) expect(r.statusCode).toBe(200);
    } finally {
      await t.stop();
    }
  });

  it('the trading path stays usable under the production-style config', async () => {
    const t = await makeApp({ rateLimit: { max: 600, windowSec: 60, authMax: 30 } });
    try {
      const user = await login(t.app); // 2 auth calls, well under 30
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/account',
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await t.stop();
    }
  });
});
