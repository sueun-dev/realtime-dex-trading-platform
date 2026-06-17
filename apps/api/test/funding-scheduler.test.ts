import { describe, expect, it } from 'vitest';
import { toUnits, type MarketConfig } from '@dex/shared';
import { createFundingPoller } from '../src/funding.js';
import type { Services } from '../src/services.js';

const PERP: MarketConfig = {
  id: 'TBT-PERP',
  type: 'perp',
  base: 'TBT',
  quote: 'USDC',
  koreanName: null,
  englishName: 'Testbit Perp',
  tickSize: toUnits(1),
  lotSize: toUnits('0.001'),
  minNotional: toUnits(10),
  makerFeeBps: 2,
  takerFeeBps: 5,
  maxLeverage: 20,
};

interface Point {
  time: number;
  fundingRate: bigint;
}

/** A controllable fake of just the Services surface startFunding touches. */
function fakeSvc(initial: Point[]) {
  let points = initial;
  const applied: { rate: bigint; ts: number }[] = [];
  const published: { rate: bigint; nextFundingTs: number }[] = [];
  const svc = {
    engine: {
      getMarkets: () => [PERP],
      applyFunding: (_marketId: string, rate: bigint, ts: number) => {
        applied.push({ rate, ts });
        return [{ kind: 'fundingApplied' }];
      },
    },
    pipeline: { exec: (fn: () => unknown) => Promise.resolve(fn()) },
    hl: { fundingHistory: (_base: string, _since: number) => Promise.resolve(points) },
    hub: {
      publishFunding: (info: { rate: bigint; nextFundingTs: number }) => {
        published.push({ rate: info.rate, nextFundingTs: info.nextFundingTs });
      },
    },
    log: () => {},
  } as unknown as Services;
  return {
    poller: createFundingPoller(svc),
    applied,
    published,
    setPoints: (p: Point[]) => {
      points = p;
    },
  };
}

const HOUR = 3_600_000;

describe('funding scheduler idempotency + catch-up', () => {
  it('seeds on the first poll without applying historical funding', async () => {
    const f = fakeSvc([
      { time: 1_000 * HOUR, fundingRate: toUnits('0.0001') },
      { time: 1_001 * HOUR, fundingRate: toUnits('0.0001') },
    ]);
    await f.poller.poll();
    expect(f.applied).toHaveLength(0); // boot seed never retro-charges
    expect(f.published).toHaveLength(1); // but it does publish a display rate
  });

  it('applies a new epoch exactly once, even across repeated polls (idempotent)', async () => {
    const f = fakeSvc([{ time: 1_000 * HOUR, fundingRate: toUnits('0.0001') }]);
    await f.poller.poll(); // seed @1000h
    f.setPoints([
      { time: 1_000 * HOUR, fundingRate: toUnits('0.0001') },
      { time: 1_001 * HOUR, fundingRate: toUnits('0.0002') },
    ]);
    await f.poller.poll(); // applies 1001h once
    await f.poller.poll(); // same data again → no double charge
    await f.poller.poll();
    expect(f.applied).toHaveLength(1);
    expect(f.applied[0]!.rate).toBe(toUnits('0.0002'));
    expect(f.applied[0]!.ts).toBe(1_001 * HOUR); // drives off HL epoch, not wall-clock
  });

  it('catches up multiple missed epochs in chronological order', async () => {
    const f = fakeSvc([{ time: 1_000 * HOUR, fundingRate: toUnits('0.0001') }]);
    await f.poller.poll(); // seed @1000h
    f.setPoints([
      { time: 1_000 * HOUR, fundingRate: toUnits('0.0001') },
      { time: 1_001 * HOUR, fundingRate: toUnits('0.0002') },
      { time: 1_002 * HOUR, fundingRate: toUnits('0.0003') },
      { time: 1_003 * HOUR, fundingRate: toUnits('0.0004') },
    ]);
    await f.poller.poll();
    expect(f.applied.map((a) => a.ts)).toEqual([1_001 * HOUR, 1_002 * HOUR, 1_003 * HOUR]);
    expect(f.applied.map((a) => a.rate)).toEqual([
      toUnits('0.0002'),
      toUnits('0.0003'),
      toUnits('0.0004'),
    ]);
  });

  it('skips zero-rate epochs (no payment) but still advances the watermark', async () => {
    const f = fakeSvc([{ time: 1_000 * HOUR, fundingRate: toUnits('0.0001') }]);
    await f.poller.poll();
    f.setPoints([
      { time: 1_000 * HOUR, fundingRate: toUnits('0.0001') },
      { time: 1_001 * HOUR, fundingRate: 0n },
      { time: 1_002 * HOUR, fundingRate: toUnits('0.0005') },
    ]);
    await f.poller.poll();
    await f.poller.poll();
    expect(f.applied.map((a) => a.ts)).toEqual([1_002 * HOUR]); // 1001h zero skipped, not re-tried
  });
});
