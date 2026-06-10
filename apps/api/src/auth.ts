import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { verifyMessage } from 'viem';

const NONCE_TTL_MS = 5 * 60_000;
const TOKEN_TTL = '24h';

/**
 * Wallet-signature auth: the client signs the issued nonce string (EIP-191
 * personal_sign via viem) and exchanges it for a JWT. Nonces are single-use
 * and expire after 5 minutes.
 */
export class AuthService {
  readonly #nonces = new Map<string, { nonce: string; exp: number }>();
  readonly #secret: Uint8Array;
  readonly #now: () => number;

  constructor(jwtSecret: string, now: () => number = () => Date.now()) {
    this.#secret = new TextEncoder().encode(jwtSecret);
    this.#now = now;
  }

  issueNonce(address: string): string {
    const nonce = `dex-login:${randomUUID()}`;
    this.#nonces.set(address.toLowerCase(), { nonce, exp: this.#now() + NONCE_TTL_MS });
    return nonce;
  }

  /** Verifies the signature over the issued nonce; consumes the nonce. */
  async verifySignature(address: string, signature: `0x${string}`): Promise<boolean> {
    const key = address.toLowerCase();
    const entry = this.#nonces.get(key);
    if (!entry || entry.exp < this.#now()) {
      this.#nonces.delete(key);
      return false;
    }
    this.#nonces.delete(key); // single-use regardless of outcome
    try {
      return await verifyMessage({
        address: key as `0x${string}`,
        message: entry.nonce,
        signature,
      });
    } catch {
      return false;
    }
  }

  async issueToken(address: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(address.toLowerCase())
      .setIssuedAt()
      .setExpirationTime(TOKEN_TTL)
      .sign(this.#secret);
  }

  /** Returns the authenticated address, or null for any invalid/expired token. */
  async verifyToken(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.#secret);
      return typeof payload.sub === 'string' && /^0x[0-9a-f]{40}$/.test(payload.sub)
        ? payload.sub
        : null;
    } catch {
      return null;
    }
  }
}
