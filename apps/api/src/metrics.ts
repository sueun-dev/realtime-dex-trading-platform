/**
 * Real Prometheus metrics via prom-client (default process/GC/heap metrics plus
 * exchange gauges collected live from the engine + WS hub). Replaces the
 * hand-rolled text endpoint with a proper registry, metric types, and labels.
 */
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import type { Services } from './services.js';

export interface Metrics {
  registry: Registry;
  ordersAccepted: Counter<'market' | 'type'>;
  ordersRejected: Counter<'code'>;
  tradesExecuted: Counter<string>;
}

export function createMetrics(svc: Services): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'dex-exchange' });
  collectDefaultMetrics({ register: registry }); // process cpu/mem/gc/event-loop

  const { engine, hub } = svc;

  // live gauges — read straight from the source of truth on each scrape
  new Gauge({
    name: 'dex_engine_seq',
    help: 'monotonic engine event sequence number',
    registers: [registry],
    collect() {
      this.set(engine.seq);
    },
  });
  new Gauge({
    name: 'dex_orders_live',
    help: 'resting orders currently in the engine book',
    registers: [registry],
    collect() {
      this.set(engine.orderMapSizes().live);
    },
  });
  new Gauge({
    name: 'dex_orders_terminal_cache',
    help: 'bounded cache of recently terminal orders',
    registers: [registry],
    collect() {
      this.set(engine.orderMapSizes().terminalCache);
    },
  });
  new Gauge({
    name: 'dex_ws_connections',
    help: 'open websocket connections',
    registers: [registry],
    collect() {
      this.set(hub.connectionCount);
    },
  });
  new Gauge({
    name: 'dex_markets_total',
    help: 'configured markets',
    registers: [registry],
    collect() {
      this.set(engine.getMarkets().length);
    },
  });
  new Gauge({
    name: 'dex_feed_stale_markets',
    help: 'markets whose live venue feed is currently stale',
    registers: [registry],
    collect() {
      this.set(engine.getMarkets().filter((m) => hub.isFeedStale(m.id)).length);
    },
  });

  const ordersAccepted = new Counter({
    name: 'dex_orders_accepted_total',
    help: 'orders accepted by the engine',
    labelNames: ['market', 'type'] as const,
    registers: [registry],
  });
  const ordersRejected = new Counter({
    name: 'dex_orders_rejected_total',
    help: 'orders rejected, by error code',
    labelNames: ['code'] as const,
    registers: [registry],
  });
  const tradesExecuted = new Counter({
    name: 'dex_trades_executed_total',
    help: 'fills produced by the matching engine',
    registers: [registry],
  });

  return { registry, ordersAccepted, ordersRejected, tradesExecuted };
}
