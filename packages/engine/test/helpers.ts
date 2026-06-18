import {
  CLEARING_ACCOUNT,
  FEE_ACCOUNT,
  toUnits,
  type EngineEvent,
  type MarketConfig,
  type OrderRequest,
  type Side,
  type TimeInForce,
  type Trade,
} from '@dex/shared';
import { Exchange } from '../src/index.js';

export const u = toUnits;

export const SPOT: MarketConfig = {
  id: 'KRW-BTC',
  type: 'spot',
  base: 'BTC',
  quote: 'KRW',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  tickSize: u(1000),
  lotSize: u('0.0001'),
  minNotional: u(1),
  makerFeeBps: 5,
  takerFeeBps: 10,
  maxLeverage: 1,
};

export const PERP: MarketConfig = {
  id: 'BTC-PERP',
  type: 'perp',
  base: 'BTC',
  quote: 'USDC',
  koreanName: null,
  englishName: 'Bitcoin Perp',
  tickSize: u(1),
  lotSize: u('0.001'),
  minNotional: u(10),
  makerFeeBps: 2,
  takerFeeBps: 5,
  maxLeverage: 20,
};

export function newExchange(): Exchange {
  return new Exchange({ markets: [SPOT, PERP] });
}

export function req(
  marketId: string,
  side: Side,
  type: 'limit' | 'market',
  price: bigint | undefined,
  qty: bigint,
  opts: {
    tif?: TimeInForce;
    postOnly?: boolean;
    reduceOnly?: boolean;
    clientOrderId?: string;
    trigger?: { price: bigint; direction: 'above' | 'below'; trail?: bigint };
    ocoGroup?: string;
  } = {},
): OrderRequest {
  const r: OrderRequest = {
    marketId,
    side,
    type,
    qty,
    tif: opts.tif ?? (type === 'market' ? 'IOC' : 'GTC'),
    postOnly: opts.postOnly ?? false,
    reduceOnly: opts.reduceOnly ?? false,
  };
  if (price !== undefined) r.price = price;
  if (opts.clientOrderId !== undefined) r.clientOrderId = opts.clientOrderId;
  if (opts.trigger !== undefined) r.trigger = opts.trigger;
  if (opts.ocoGroup !== undefined) r.ocoGroup = opts.ocoGroup;
  return r;
}

export function trades(evts: EngineEvent[]): Trade[] {
  return evts.filter((e) => e.kind === 'trade').map((e) => e.trade);
}

export function kinds(evts: EngineEvent[]): string[] {
  return evts.map((e) => e.kind);
}

export function rejection(evts: EngineEvent[]): { code: string } | undefined {
  const e = evts.find((e) => e.kind === 'orderRejected');
  return e && e.kind === 'orderRejected' ? { code: e.code } : undefined;
}

export function acceptedId(evts: EngineEvent[]): string {
  const e = evts.find((e) => e.kind === 'orderAccepted');
  if (!e || e.kind !== 'orderAccepted') throw new Error('no orderAccepted event');
  return e.order.id;
}

/**
 * Conservation invariant: per asset, Σ over all ledger rows of
 * (available + locked) + Σ position margins (USDC) == net deposits.
 * Also asserts non-negativity everywhere (clearing available exempt).
 */
export function checkConservation(ex: Exchange, netDeposits: Map<string, bigint>): void {
  const sums = new Map<string, bigint>();
  for (const row of ex.getAllBalances()) {
    if (row.locked < 0n) throw new Error(`negative locked: ${row.userId} ${row.asset}`);
    if (row.available < 0n && row.userId !== CLEARING_ACCOUNT) {
      throw new Error(`negative available: ${row.userId} ${row.asset}`);
    }
    sums.set(row.asset, (sums.get(row.asset) ?? 0n) + row.available + row.locked);
  }
  for (const m of ex.getMarkets()) {
    if (m.type !== 'perp') continue;
    // every user's positions on this market
    for (const row of allPositions(ex, m.id)) {
      if (row.margin < 0n) throw new Error(`negative margin: ${row.userId} ${m.id}`);
      sums.set(m.quote, (sums.get(m.quote) ?? 0n) + row.margin);
    }
  }
  const assets = new Set([...sums.keys(), ...netDeposits.keys()]);
  for (const asset of assets) {
    const got = sums.get(asset) ?? 0n;
    const want = netDeposits.get(asset) ?? 0n;
    if (got !== want) {
      throw new Error(`conservation broken for ${asset}: have ${got}, deposited ${want}`);
    }
  }
}

/** All positions on a market across the known + internal accounts. */
export function allPositions(ex: Exchange, marketId: string) {
  const out = [];
  for (const userId of knownUsers(ex)) {
    const p = ex.getPosition(userId, marketId);
    if (p) out.push(p);
  }
  return out;
}

/** Every account that has ever had a balance row. */
export function knownUsers(ex: Exchange): string[] {
  const seen = new Set<string>();
  for (const row of ex.getAllBalances()) seen.add(row.userId);
  seen.add(FEE_ACCOUNT);
  seen.add(CLEARING_ACCOUNT);
  return [...seen];
}

/** Apply events-returning op and track net deposits for conservation checks. */
export class ConservationTracker {
  readonly netDeposits = new Map<string, bigint>();
  deposit(asset: string, amount: bigint): void {
    this.netDeposits.set(asset, (this.netDeposits.get(asset) ?? 0n) + amount);
  }
  withdraw(asset: string, amount: bigint): void {
    this.netDeposits.set(asset, (this.netDeposits.get(asset) ?? 0n) - amount);
  }
  check(ex: Exchange): void {
    checkConservation(ex, this.netDeposits);
  }
}
