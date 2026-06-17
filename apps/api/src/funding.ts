/**
 * Perp funding using REAL Hyperliquid funding rates. A single poll loop:
 *   - display: publish the latest observed rate + next-settlement time on
 *     funding:<mkt> every minute so traders see a live rate + countdown.
 *   - settle: apply every HL funding epoch strictly newer than the last one we
 *     applied, in ascending order (catch-up), through the pipeline. Idempotent
 *     across duplicate timer ticks, drifting clocks, and process restarts — the
 *     watermark is the HL funding `time`, never a local wall-clock interval, so
 *     the same epoch is never charged twice and missed hours are caught up.
 *
 * On boot the watermark is SEEDED to the latest epoch without applying it:
 * funding that predates this process is already reflected in restored position
 * margins, so we never retroactively double-charge after a restart.
 */
import type { Services, Stoppable } from './services.js';

const SETTLE_INTERVAL_MS = 60 * 60_000; // Hyperliquid settles hourly
const POLL_MS = 60_000; // display refresh + settlement catch-up cadence
const LOOKBACK_MS = 6 * 60 * 60_000; // window wide enough to catch up missed hours

/** Next top-of-hour settlement boundary strictly after `now`. */
function nextFundingTs(now: number): number {
  const boundary = Math.ceil(now / SETTLE_INTERVAL_MS) * SETTLE_INTERVAL_MS;
  return boundary === now ? now + SETTLE_INTERVAL_MS : boundary;
}

export interface FundingPoller {
  /** one pass: refresh display rates + settle any new funding epochs */
  poll(): Promise<void>;
  stop(): void;
}

/** The funding poll loop, detached from the timer so it can be driven in tests. */
export function createFundingPoller(svc: Services): FundingPoller {
  const { engine, pipeline, hl, hub, log } = svc;
  let stopped = false;
  // marketId → HL funding `time` (epoch ms) of the most recently applied epoch
  const lastApplied = new Map<string, number>();

  const poll = async (): Promise<void> => {
    for (const m of engine.getMarkets()) {
      if (stopped) return;
      if (m.type !== 'perp') continue;
      try {
        const points = await hl.fundingHistory(m.base, Date.now() - LOOKBACK_MS);
        if (points.length === 0) continue;
        const last = points[points.length - 1]!;

        // display: always surface the latest observed rate + countdown
        const now = Date.now();
        hub.publishFunding({
          marketId: m.id,
          rate: last.fundingRate,
          intervalMs: SETTLE_INTERVAL_MS,
          nextFundingTs: nextFundingTs(now),
          ts: now,
        });

        const watermark = lastApplied.get(m.id);
        if (watermark === undefined) {
          // boot seed: adopt the latest epoch as already-settled (prior funding
          // is already baked into restored margins), apply only future epochs
          lastApplied.set(m.id, last.time);
          continue;
        }
        // settle every NEW epoch in chronological order (catch-up)
        const fresh = points.filter((p) => p.time > watermark).sort((a, b) => a.time - b.time);
        for (const p of fresh) {
          if (stopped) return;
          if (p.fundingRate !== 0n) {
            const events = await pipeline.exec(() => engine.applyFunding(m.id, p.fundingRate, p.time));
            if (events.length > 0) {
              log(`funding ${m.id} @${p.time}: rate=${p.fundingRate} events=${events.length}`);
            }
          }
          lastApplied.set(m.id, p.time);
        }
      } catch (e) {
        log(`funding ${m.id} failed: ${String(e)}`);
      }
    }
  };

  return {
    poll,
    stop() {
      stopped = true;
    },
  };
}

export function startFunding(svc: Services): Stoppable {
  const poller = createFundingPoller(svc);
  void poller.poll(); // prime display + seed watermarks immediately
  const timer = setInterval(() => void poller.poll(), POLL_MS);
  timer.unref?.();

  return {
    stop() {
      poller.stop();
      clearInterval(timer);
    },
  };
}
