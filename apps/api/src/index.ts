/**
 * DEX API server entrypoint: real Upbit+Hyperliquid universe, live feeds,
 * liquidity bot, hourly funding, durable PGlite projection.
 */
import { buildServices } from './services.js';
import { buildApp } from './server.js';

const PORT = Number(process.env.DEX_PORT ?? 3001);
const HOST = process.env.DEX_HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DEX_DATA_DIR ?? '.pglite-data';

async function main(): Promise<void> {
  const services = await buildServices({
    dataDir: DATA_DIR,
    universe: 'live',
    feeds: true,
    marketMaker: true,
    funding: true,
    retention: true,
    // a projection failure means engine and durable store have diverged — exit
    // non-zero so the supervisor restarts and boot-restore re-establishes a
    // consistent engine from the last durable watermark
    onFatal: () => {
      setTimeout(() => process.exit(70), 50);
    },
    // generous enough for an active trader, hostile to scrapers/bots
    rateLimit: { max: 600, windowSec: 60, authMax: 30 },
  });
  const app = await buildApp(services);
  await app.listen({ port: PORT, host: HOST });
  services.log(`listening on http://${HOST}:${PORT} (markets: ${services.engine.getMarkets().length})`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    services.log(`${signal} — shutting down`);
    void app
      .close()
      .then(() => services.stop())
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        console.error(e);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e: unknown) => {
  console.error('[dex-api] fatal boot error:', e);
  process.exit(1);
});
