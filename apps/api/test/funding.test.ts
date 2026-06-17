import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toUnits } from '@dex/shared';
import { TEST_PERP, TEST_SPOT, makeApp, type TestApp } from './helpers.js';

let t: TestApp;

const now = Date.now();
const FUNDING = {
  marketId: TEST_PERP.id,
  rate: toUnits('0.0001'), // +0.01% / hour (real-shaped HL value)
  intervalMs: 3_600_000,
  nextFundingTs: now + 600_000,
  ts: now,
};

beforeAll(async () => {
  t = await makeApp();
  // seed the hub as the real funding poller would (HL fundingHistory → publishFunding)
  t.svc.hub.publishFunding(FUNDING);
});
afterAll(async () => {
  await t.stop();
});

describe('perp funding rate exposure', () => {
  it('GET /api/funding returns the current rate as decimal wire strings', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/funding' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Record<string, unknown>[];
    const f = list.find((x) => x['marketId'] === TEST_PERP.id);
    expect(f).toBeDefined();
    expect(f).toMatchObject({
      marketId: TEST_PERP.id,
      rate: '0.0001',
      intervalMs: 3_600_000,
      nextFundingTs: FUNDING.nextFundingTs,
    });
  });

  it('GET /api/markets/:id/funding returns the single market rate', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/markets/${TEST_PERP.id}/funding` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ marketId: TEST_PERP.id, rate: '0.0001' });
  });

  it('404s for a market that has no funding observation yet', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/markets/${TEST_SPOT.id}/funding` });
    expect(res.statusCode).toBe(404);
  });

  it('MARKET_NOT_FOUND for an unknown market', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets/NOPE-PERP/funding' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('MARKET_NOT_FOUND');
  });

  it('GET /api/markets carries funding on perp rows and null on spot rows', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/markets' });
    const rows = res.json() as Record<string, unknown>[];
    const perp = rows.find((r) => r['id'] === TEST_PERP.id);
    const spot = rows.find((r) => r['id'] === TEST_SPOT.id);
    expect((perp?.['funding'] as { rate?: string })?.rate).toBe('0.0001');
    expect(spot?.['funding']).toBeNull();
  });
});
