import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { toUnits, type MarketConfig } from '@dex/shared';
import type { FastifyInstance } from 'fastify';
import { buildServices, type ServiceOptions, type Services } from '../src/services.js';
import { buildApp } from '../src/server.js';

export const u = toUnits;

/**
 * Synthetic USDC-quoted test markets — deterministic ticks/lots so assertions
 * are exact. Distinct maker/taker fees (5/10 bps) verify the engine reads
 * per-market fees rather than a global constant.
 */
export const TEST_SPOT: MarketConfig = {
  id: 'TBT-USDC',
  type: 'spot',
  base: 'TBT',
  quote: 'USDC',
  koreanName: '테스트비트',
  englishName: 'Testbit',
  tickSize: u('0.01'),
  lotSize: u('0.001'),
  minNotional: u('1'),
  makerFeeBps: 5,
  takerFeeBps: 10,
  maxLeverage: 1,
};

export const TEST_PERP: MarketConfig = {
  id: 'TBT-PERP',
  type: 'perp',
  base: 'TBT',
  quote: 'USDC',
  koreanName: null,
  englishName: 'Testbit Perp',
  tickSize: u(1),
  lotSize: u('0.001'),
  minNotional: u(10),
  makerFeeBps: 2,
  takerFeeBps: 5,
  maxLeverage: 20,
};

export interface TestApp {
  svc: Services;
  app: FastifyInstance;
  stop(): Promise<void>;
}

export async function makeApp(opts: Partial<ServiceOptions> = {}): Promise<TestApp> {
  const svc = await buildServices({
    universe: [TEST_SPOT, TEST_PERP],
    feeds: false,
    marketMaker: false,
    funding: false,
    jwtSecret: 'test-secret',
    log: () => {},
    ...opts,
  });
  const app = await buildApp(svc);
  return {
    svc,
    app,
    async stop() {
      await app.close();
      await svc.stop();
    },
  };
}

export interface TestUser {
  account: PrivateKeyAccount;
  address: string;
  token: string;
}

/** Full wallet-signature login flow against the real auth endpoints. */
export async function login(app: FastifyInstance): Promise<TestUser> {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();
  const nonceRes = await app.inject({
    method: 'POST',
    url: '/api/auth/nonce',
    payload: { address },
  });
  if (nonceRes.statusCode !== 200) throw new Error(`nonce failed: ${nonceRes.body}`);
  const { nonce } = nonceRes.json() as { nonce: string };
  const signature = await account.signMessage({ message: nonce });
  const verifyRes = await app.inject({
    method: 'POST',
    url: '/api/auth/verify',
    payload: { address, signature },
  });
  if (verifyRes.statusCode !== 200) throw new Error(`verify failed: ${verifyRes.body}`);
  const { token } = verifyRes.json() as { token: string };
  return { account, address, token };
}

export async function loginAndFund(app: FastifyInstance): Promise<TestUser> {
  const user = await login(app);
  const res = await authed(app, user, 'POST', '/api/account/faucet');
  if (res.statusCode !== 200) throw new Error(`faucet failed: ${res.body}`);
  return user;
}

export async function authed(
  app: FastifyInstance,
  user: TestUser,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${user.token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

export interface OrderBody {
  marketId: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price?: string;
  qty: string;
  tif?: 'GTC' | 'IOC' | 'FOK';
  postOnly?: boolean;
  reduceOnly?: boolean;
  triggerPrice?: string;
  triggerDirection?: 'above' | 'below';
  trailDistance?: string;
  clientOrderId?: string;
  ocoGroup?: string;
}

export async function placeOrder(
  app: FastifyInstance,
  user: TestUser,
  body: OrderBody,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return authed(app, user, 'POST', '/api/orders', body);
}
