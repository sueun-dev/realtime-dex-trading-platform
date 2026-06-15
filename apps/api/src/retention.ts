/**
 * Retention GC. The book mirror continuously cancels+re-submits house quotes
 * across every active market, so the durable projection's orders table (and,
 * more slowly, trades/funding/liquidations) would grow without bound. This
 * periodically prunes terminal order rows and caps the append-only tables,
 * serialized through the pipeline so it never interleaves with projector
 * writes. loadRestoreState reads only status='open' orders, so pruning
 * terminal rows never affects restore correctness.
 */
import type { Services, Stoppable } from './services.js';

const GC_INTERVAL_MS = 30_000;
/** keep terminal orders this long before pruning (covers in-flight + recent UI) */
const ORDER_RETENTION_MS = 120_000;
const TRADES_KEEP = 100_000;
const EVENTS_KEEP = 50_000;

export function startRetention(svc: Services): Stoppable {
  const { repos, pipeline, log } = svc;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await pipeline.runDb(async () => {
      const pruned = await repos.retention.prune({
        terminalOrdersBeforeTs: Date.now() - ORDER_RETENTION_MS,
        tradesKeep: TRADES_KEEP,
        eventsKeep: EVENTS_KEEP,
      });
      const total = pruned.orders + pruned.trades + pruned.funding + pruned.liquidations;
      if (total > 0) {
        log(
          `retention: pruned ${pruned.orders} orders, ${pruned.trades} trades, ` +
            `${pruned.funding} funding, ${pruned.liquidations} liquidations`,
        );
      }
    });
  };

  const timer = setInterval(() => {
    void tick().catch((e: unknown) => log(`retention GC failed: ${String(e)}`));
  }, GC_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
