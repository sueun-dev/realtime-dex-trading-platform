import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { login, makeApp, type TestApp } from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.stop();
});

describe('wallet-signature auth', () => {
  it('full nonce → sign → verify flow yields a working JWT', async () => {
    const user = await login(t.app);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/account',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { address: string; balances: unknown[] };
    expect(body.address).toBe(user.address);
    expect(body.balances).toEqual([]);
  });

  it('rejects a signature from a different key', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase();
    const { nonce } = (
      await t.app.inject({ method: 'POST', url: '/api/auth/nonce', payload: { address } })
    ).json() as { nonce: string };
    const signature = await attacker.signMessage({ message: nonce });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('NOT_AUTHORIZED');
  });

  it('nonces are single-use (replay rejected)', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const address = account.address.toLowerCase();
    const { nonce } = (
      await t.app.inject({ method: 'POST', url: '/api/auth/nonce', payload: { address } })
    ).json() as { nonce: string };
    const signature = await account.signMessage({ message: nonce });
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature },
    });
    expect(first.statusCode).toBe(200);
    const replay = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address, signature },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects verify without a prior nonce', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: 'dex-login:fabricated' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: { address: account.address.toLowerCase(), signature },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects garbage / missing tokens on authed routes', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer not-a-jwt' },
      { authorization: 'Bearer ' },
      { authorization: 'Basic abc' },
    ]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/account', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const other = await makeApp({ jwtSecret: 'other-secret' });
    try {
      const user = await login(other.app);
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/account',
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await other.stop();
    }
  });

  it('validates the address shape', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/nonce',
      payload: { address: 'robert; DROP TABLE users;--' },
    });
    expect(res.statusCode).toBe(422);
  });
});
