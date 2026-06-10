/**
 * Soak test: run the FULL production stack (live universe, live feeds, real
 * book mirror, funding) for SOAK_MINUTES (default 30) under constant trading
 * + websocket churn, sampling memory/handles/listeners, then render a
 * leak/stability verdict.
 *
 *   SOAK_MINUTES=30 pnpm soak
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { toUnits, fromUnits, roundToTick } from '@dex/shared';
import { buildServices } from '../src/services.js';
import { buildApp } from '../src/server.js';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 30);
const PORT = Number(process.env.SOAK_PORT ?? 3210);
const SAMPLE_MS = 30_000;
const REPORT_PATH = join(process.cwd(), 'soak-report.json');

interface Sample {
  minute: number;
  rssMb: number;
  heapMb: number;
  externalMb: number;
  activeResources: number;
  wsConns: number;
  tickerListeners: number;
  engineSeq: number;
  requests: number;
  errors5xx: number;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const services = await buildServices({
    dataDir: mkdtempSync(join(tmpdir(), 'dex-soak-')),
    universe: 'live',
    feeds: true,
    marketMaker: true,
    funding: true,
    rateLimit: false, // the soak traders are intentionally hyperactive
    log: (m) => {
      if (/failed|error/i.test(m)) errors.push(m);
    },
  });
  const app = await buildApp(services);
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`[soak] up on :${PORT} — ${MINUTES} minutes, sampling every ${SAMPLE_MS / 1000}s`);

  // ---- synthetic traders (token minted directly; faucet via engine) ---------
  const traders: { address: string; token: string }[] = [];
  for (const c of ['a', 'b', 'c']) {
    const address = `0x${c.repeat(40)}`;
    await services.repos.users.getOrCreate(address, Date.now());
    await services.pipeline.exec(() => [
      ...services.engine.deposit(address, 'USDC', toUnits(10_000_000_000), Date.now()),
      ...services.engine.deposit(address, 'BTC', toUnits(100), Date.now()),
    ]);
    traders.push({ address, token: await services.auth.issueToken(address) });
  }

  let requests = 0;
  let errors5xx = 0;
  const call = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<unknown> => {
    requests += 1;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status >= 500) {
      errors5xx += 1;
      errors.push(`${method} ${path} -> ${res.status}`);
    }
    return res.json().catch(() => null);
  };

  const M = 'BTC-USDC';
  const tick = services.engine.getMarket(M)!.tickSize;
  let nthAction = 0;
  const tradeTimer = setInterval(() => {
    void (async () => {
      const trader = traders[nthAction % traders.length]!;
      const ticker = services.priceCache.get(M);
      if (!ticker) return;
      const kind = nthAction++ % 5;
      if (kind === 0) {
        await call('GET', '/api/account', trader.token);
      } else if (kind <= 2) {
        // resting limit far enough away that it churns the book without filling
        const off = (BigInt(1 + (nthAction % 5)) * ticker.price) / 100n;
        const side = nthAction % 2 === 0 ? 'buy' : 'sell';
        const price = roundToTick(side === 'buy' ? ticker.price - off : ticker.price + off, tick, 'floor');
        await call('POST', '/api/orders', trader.token, {
          marketId: M,
          side,
          type: 'limit',
          price: fromUnits(price),
          qty: '0.001',
          tif: 'GTC',
        });
      } else if (kind === 3) {
        const open = (await call('GET', '/api/orders', trader.token)) as { id: string }[] | null;
        if (open && open.length > 0) {
          await call('DELETE', `/api/orders/${open[nthAction % open.length]!.id}`, trader.token);
        }
      } else {
        await call('POST', '/api/orders', trader.token, {
          marketId: M,
          side: nthAction % 2 === 0 ? 'buy' : 'sell',
          type: 'market',
          qty: '0.0005',
          tif: 'IOC',
        });
      }
    })().catch((e: unknown) => errors.push(`trader: ${String(e)}`));
  }, 1000);

  // ---- websocket churn -------------------------------------------------------
  const wsPool: WebSocket[] = [];
  const wsTimer = setInterval(() => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      for (const ch of [`orderbook:${M}`, `trades:${M}`, 'allTickers']) {
        ws.send(JSON.stringify({ op: 'subscribe', channel: ch, market: M }));
      }
    });
    ws.on('error', () => {});
    wsPool.push(ws);
    while (wsPool.length > 15) wsPool.shift()?.close();
  }, 10_000);

  // ---- sampling ---------------------------------------------------------------
  const samples: Sample[] = [];
  const started = Date.now();
  const sampleTimer = setInterval(() => {
    const mem = process.memoryUsage();
    samples.push({
      minute: Math.round((Date.now() - started) / 6000) / 10,
      rssMb: mb(mem.rss),
      heapMb: mb(mem.heapUsed),
      externalMb: mb(mem.external),
      activeResources: process.getActiveResourcesInfo().length,
      wsConns: services.hub.connectionCount,
      tickerListeners: services.priceCache.listenerCount('ticker'),
      engineSeq: services.engine.seq,
      requests,
      errors5xx,
    });
    const s = samples.at(-1)!;
    console.log(
      `[soak] ${s.minute}m rss=${s.rssMb}MB heap=${s.heapMb}MB res=${s.activeResources} ` +
        `ws=${s.wsConns} seq=${s.engineSeq} req=${s.requests} 5xx=${s.errors5xx}`,
    );
  }, SAMPLE_MS);

  await new Promise((r) => setTimeout(r, MINUTES * 60_000));

  clearInterval(tradeTimer);
  clearInterval(wsTimer);
  clearInterval(sampleTimer);
  for (const ws of wsPool) ws.close();
  await app.close();
  await services.stop();

  // ---- verdict ------------------------------------------------------------------
  // baseline: minutes 2-5 (after caches warm); final: last 3 minutes
  const baseline = samples.filter((s) => s.minute >= 2 && s.minute <= 5);
  const tail = samples.slice(-6);
  const rssGrowth = median(tail.map((s) => s.rssMb)) - median(baseline.map((s) => s.rssMb));
  const heapGrowth = median(tail.map((s) => s.heapMb)) - median(baseline.map((s) => s.heapMb));
  const resourceGrowth =
    median(tail.map((s) => s.activeResources)) - median(baseline.map((s) => s.activeResources));
  const listenerSpread =
    Math.max(...samples.map((s) => s.tickerListeners)) -
    Math.min(...samples.map((s) => s.tickerListeners));

  const checks: [string, boolean, string][] = [
    ['no 5xx responses', errors5xx === 0, `${errors5xx} errors`],
    ['rss growth < 200MB', rssGrowth < 200, `${rssGrowth}MB`],
    ['heap growth < 150MB', heapGrowth < 150, `${heapGrowth}MB`],
    ['active resource growth < 100', resourceGrowth < 100, `${resourceGrowth}`],
    ['ticker listener count stable', listenerSpread <= 2, `spread ${listenerSpread}`],
    ['traffic actually flowed', requests > MINUTES * 30, `${requests} requests`],
  ];

  const pass = checks.every(([, ok]) => ok);
  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ minutes: MINUTES, pass, checks, samples, errors: errors.slice(0, 50) }, null, 2),
  );
  for (const [name, ok, detail] of checks) {
    console.log(`[soak] ${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
  }
  console.log(`[soak] ${pass ? 'ALL PASS' : 'FAILED'} — report: ${REPORT_PATH}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('[soak] fatal:', e);
  process.exit(1);
});
