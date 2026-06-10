/**
 * Hourly perp funding using REAL Hyperliquid funding rates (latest point from
 * fundingHistory). Applied through the pipeline so payments persist+broadcast.
 */
import type { Services, Stoppable } from './services.js';

const FUNDING_INTERVAL_MS = 60 * 60_000;
const LOOKBACK_MS = 3 * 60 * 60_000;

export function startFunding(svc: Services): Stoppable {
  const { engine, pipeline, hl, log } = svc;
  let stopped = false;

  const applyAll = async (): Promise<void> => {
    for (const m of engine.getMarkets()) {
      if (stopped) return;
      if (m.type !== 'perp') continue;
      try {
        const points = await hl.fundingHistory(m.base, Date.now() - LOOKBACK_MS);
        const latest = points.at(-1);
        if (!latest || latest.fundingRate === 0n) continue;
        const events = await pipeline.exec(() =>
          engine.applyFunding(m.id, latest.fundingRate, Date.now()),
        );
        if (events.length > 0) {
          log(`funding ${m.id}: rate=${latest.fundingRate} events=${events.length}`);
        }
      } catch (e) {
        log(`funding ${m.id} failed: ${String(e)}`);
      }
    }
  };

  const timer = setInterval(() => void applyAll(), FUNDING_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
