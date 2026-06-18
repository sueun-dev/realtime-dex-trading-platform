import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CLEARING_ACCOUNT,
  DexError,
  FEE_ACCOUNT,
  absBig,
  divRound,
  feeOn,
  mulUnits,
  type Position,
} from '@dex/shared';
import {
  Exchange,
  liquidationPrice,
  maintenanceMargin,
  tieredMmRate,
  unrealizedPnl,
} from '../src/index.js';
import { ConservationTracker, PERP, acceptedId, newExchange, rejection, req, trades, u } from './helpers.js';

const M = PERP.id;
let TS = 10_000;

function setup(lev = 1): { ex: Exchange; t: ConservationTracker } {
  const ex = newExchange();
  const t = new ConservationTracker();
  for (const user of ['alice', 'bob', 'carol']) {
    ex.deposit(user, 'USDC', u(100_000), TS++);
    t.deposit('USDC', u(100_000));
    if (lev > 1) ex.setLeverage(user, M, lev, TS++);
  }
  return { ex, t };
}

/** alice long qty @ price, bob short qty @ price (bob maker, alice taker). */
function openPair(ex: Exchange, price: bigint, qty: bigint): void {
  ex.submitOrder('bob', req(M, 'sell', 'limit', price, qty), TS++);
  const evts = ex.submitOrder('alice', req(M, 'buy', 'limit', price, qty), TS++);
  if (trades(evts).length === 0) throw new Error('openPair did not fill');
}

function usdc(ex: Exchange, user: string): { available: bigint; locked: bigint } {
  const b = ex.getBalances(user).find((x) => x.asset === 'USDC');
  return b ? { available: b.available, locked: b.locked } : { available: 0n, locked: 0n };
}

describe('perp engine', () => {
  it('opens isolated-margin positions: margin = notional/leverage, fees from lock', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1));
    const alice = ex.getPosition('alice', M)!;
    const bob = ex.getPosition('bob', M)!;
    expect(alice.size).toBe(u(1));
    expect(alice.entryPrice).toBe(u(100));
    expect(alice.margin).toBe(u(100)); // leverage 1
    expect(bob.size).toBe(-u(1));
    expect(bob.margin).toBe(u(100));
    const n = u(100);
    const makerFee = feeOn(n, PERP.makerFeeBps);
    const takerFee = feeOn(n, PERP.takerFeeBps);
    expect(usdc(ex, FEE_ACCOUNT).available).toBe(makerFee + takerFee);
    expect(usdc(ex, 'alice').available).toBe(u(100_000) - u(100) - takerFee);
    expect(usdc(ex, 'alice').locked).toBe(0n);
    expect(usdc(ex, 'bob').available).toBe(u(100_000) - u(100) - makerFee);
    t.check(ex);
  });

  it('leverage divides the IM lock and margin', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1));
    const alice = ex.getPosition('alice', M)!;
    expect(alice.margin).toBe(u(10));
    expect(alice.leverage).toBe(10);
    t.check(ex);
  });

  it('lock for a perp order is IM + taker-fee reserve; cancel releases it exactly', () => {
    const { ex, t } = setup(10);
    const id = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(100), u(2)), TS++));
    const n = mulUnits(u(100), u(2));
    const lock = divRound(n, 10n, 'ceil') + feeOn(n, PERP.takerFeeBps);
    expect(usdc(ex, 'alice').locked).toBe(lock);
    ex.cancelOrder('alice', id, TS++);
    expect(usdc(ex, 'alice').locked).toBe(0n);
    expect(usdc(ex, 'alice').available).toBe(u(100_000));
    t.check(ex);
  });

  it('increasing a position computes volume-weighted entry', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1));
    openPair(ex, u(110), u(1));
    const alice = ex.getPosition('alice', M)!;
    expect(alice.size).toBe(u(2));
    expect(alice.entryPrice).toBe(u(105));
    expect(alice.margin).toBe(u(210));
    t.check(ex);
  });

  it('reducing realizes signed PnL and releases proportional margin, mirrored on clearing', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(2)); // alice long 2 @100 margin 200, bob short
    // alice sells 1 @110 to carol (carol maker buys, goes long)
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(110), u(1)), TS++);
    const before = usdc(ex, 'alice').available;
    const evts = ex.submitOrder('alice', req(M, 'sell', 'limit', u(110), u(1)), TS++);
    expect(trades(evts)).toHaveLength(1);
    const alice = ex.getPosition('alice', M)!;
    expect(alice.size).toBe(u(1));
    expect(alice.entryPrice).toBe(u(100)); // entry unchanged on reduce
    expect(alice.margin).toBe(u(100));
    const pc = evts.find((e) => e.kind === 'positionChanged' && e.userId === 'alice');
    if (!pc || pc.kind !== 'positionChanged') throw new Error('no positionChanged');
    expect(pc.realizedPnl).toBe(u(10)); // (110-100)*1
    // cash: released 100 + pnl 10 - takerFee on 110 + unused IM lock for the order
    const nC = u(110);
    const takerFee = feeOn(nC, PERP.takerFeeBps);
    const orderLock = divRound(nC, 1n, 'ceil') + feeOn(nC, PERP.takerFeeBps);
    expect(usdc(ex, 'alice').available - before).toBe(u(100) + u(10) - takerFee + orderLock - orderLock);
    // clearing mirrors -realized for alice... and bob/carol have no realized pnl yet
    expect(usdc(ex, CLEARING_ACCOUNT).available).toBe(-u(10));
    t.check(ex);
  });

  it('losing reduce deducts negative PnL from released margin', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(2));
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(90), u(1)), TS++);
    const before = usdc(ex, 'alice').available;
    ex.submitOrder('alice', req(M, 'sell', 'limit', u(90), u(1)), TS++);
    const takerFee = feeOn(u(90), PERP.takerFeeBps);
    // released 100, pnl -10, fee
    expect(usdc(ex, 'alice').available - before).toBe(u(100) - u(10) - takerFee);
    expect(usdc(ex, CLEARING_ACCOUNT).available).toBe(u(10));
    t.check(ex);
  });

  it('full close removes the position; excess qty flips into a new position', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1)); // alice long 1
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(100), u('1.5')), TS++);
    ex.submitOrder('alice', req(M, 'sell', 'limit', u(100), u('1.5')), TS++);
    const alice = ex.getPosition('alice', M)!;
    expect(alice.size).toBe(-u('0.5'));
    expect(alice.entryPrice).toBe(u(100));
    expect(alice.margin).toBe(u(50));
    t.check(ex);
  });

  it('reduceOnly: requires opposite position and bounded total qty', () => {
    const { ex, t } = setup();
    expect(
      rejection(ex.submitOrder('alice', req(M, 'sell', 'limit', u(100), u(1), { reduceOnly: true }), TS++))?.code,
    ).toBe('REDUCE_ONLY_VIOLATION');
    openPair(ex, u(100), u(1)); // alice long 1
    // same-direction reduceOnly rejected
    expect(
      rejection(ex.submitOrder('alice', req(M, 'buy', 'limit', u(100), u(1), { reduceOnly: true }), TS++))?.code,
    ).toBe('REDUCE_ONLY_VIOLATION');
    // qty beyond position rejected
    expect(
      rejection(ex.submitOrder('alice', req(M, 'sell', 'limit', u(120), u(2), { reduceOnly: true }), TS++))?.code,
    ).toBe('REDUCE_ONLY_VIOLATION');
    // first RO ok and locks nothing
    const before = usdc(ex, 'alice');
    const ok = ex.submitOrder('alice', req(M, 'sell', 'limit', u(120), u('0.6'), { reduceOnly: true }), TS++);
    expect(rejection(ok)).toBeUndefined();
    expect(usdc(ex, 'alice')).toEqual(before);
    // second RO exceeding remaining capacity rejected (0.6 + 0.5 > 1)
    expect(
      rejection(ex.submitOrder('alice', req(M, 'sell', 'limit', u(121), u('0.5'), { reduceOnly: true }), TS++))?.code,
    ).toBe('REDUCE_ONLY_VIOLATION');
    t.check(ex);
  });

  it('reduceOnly fill reduces and never flips; stale RO orders are auto-trimmed', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1)); // alice long 1
    const roId = acceptedId(
      ex.submitOrder('alice', req(M, 'sell', 'limit', u(120), u(1), { reduceOnly: true }), TS++),
    );
    // alice closes 0.7 via a regular sell -> position 0.3, resting RO 1 > 0.3 -> trimmed
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(100), u('0.7')), TS++);
    ex.submitOrder('alice', req(M, 'sell', 'limit', u(100), u('0.7')), TS++);
    expect(ex.getPosition('alice', M)!.size).toBe(u('0.3'));
    expect(ex.getOrder(roId)!.status).toBe('cancelled');
    t.check(ex);
  });

  it('reduceOnly taker closes the position', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1));
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(105), u(1)), TS++);
    const evts = ex.submitOrder('alice', req(M, 'sell', 'limit', u(105), u(1), { reduceOnly: true }), TS++);
    expect(trades(evts)).toHaveLength(1);
    expect(ex.getPosition('alice', M)).toBeUndefined();
    expect(ex.getOpenOrders('alice')).toHaveLength(0);
    t.check(ex);
  });

  it('setLeverage rules: exceeded, in use by position, in use by open orders', () => {
    const { ex } = setup();
    expect(() => ex.setLeverage('alice', M, 21, TS)).toThrow(/LEVERAGE|max/i);
    expect(() => ex.setLeverage('alice', M, 0, TS)).toThrowError(DexError);
    expect(() => ex.setLeverage('alice', 'NO-PERP', 5, TS)).toThrow(/market/i);
    const id = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(100), u(1)), TS++));
    expect(() => ex.setLeverage('alice', M, 5, TS)).toThrow(/in use|orders/i);
    ex.cancelOrder('alice', id, TS++);
    ex.setLeverage('alice', M, 5, TS++); // ok now
    openPair(ex, u(100), u(1));
    expect(() => ex.setLeverage('alice', M, 2, TS)).toThrow(/in use|position/i);
  });

  it('setMarkPrice emits markPrice and liquidates when margin + uPnL < MM', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1)); // alice long margin 10, bob short margin 10
    const e1 = ex.setMarkPrice(M, u(95), TS++);
    expect(e1.map((e) => e.kind)).toEqual(['markPrice']); // 10-5=5 >= 95/40=2.375 -> safe
    expect(ex.getMarkPrice(M)).toBe(u(95));
    const evts = ex.setMarkPrice(M, u(92), TS++); // 10-8=2 < 92/40=2.3 -> liquidated
    const liq = evts.find((e) => e.kind === 'liquidation');
    if (!liq || liq.kind !== 'liquidation') throw new Error('no liquidation');
    expect(liq.userId).toBe('alice');
    expect(liq.size).toBe(u(1));
    expect(liq.markPrice).toBe(u(92));
    expect(ex.getPosition('alice', M)).toBeUndefined();
    expect(ex.getPosition('bob', M)).toBeDefined(); // bob is in profit, untouched
    // payout = max(0, margin + uPnL) = 10 - 8 = 2
    const pc = evts.find((e) => e.kind === 'positionChanged' && e.userId === 'alice');
    if (!pc || pc.kind !== 'positionChanged') throw new Error('no positionChanged');
    expect(pc.realizedPnl).toBe(-u(8));
    expect(pc.size).toBe(0n);
    t.check(ex);
  });

  it('liquidation cancels the user’s open orders on that market', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1));
    const oid = acceptedId(ex.submitOrder('alice', req(M, 'buy', 'limit', u(50), u(1)), TS++));
    const spotOid = acceptedId(ex.submitOrder('alice', req(M, 'sell', 'limit', u(150), u('0.5'), { reduceOnly: true }), TS++));
    const evts = ex.setMarkPrice(M, u(91), TS++);
    const cancels = evts.filter((e) => e.kind === 'orderCancelled');
    expect(cancels.map((c) => (c.kind === 'orderCancelled' ? c.reason : ''))).toEqual(['liquidation', 'liquidation']);
    expect(ex.getOrder(oid)!.status).toBe('cancelled');
    expect(ex.getOrder(spotOid)!.status).toBe('cancelled');
    expect(usdc(ex, 'alice').locked).toBe(0n);
    t.check(ex);
  });

  it('bad debt at liquidation: payout 0, insurance (fee account) then clearing absorb', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1));
    const feeBefore = usdc(ex, FEE_ACCOUNT).available;
    const clearingBefore = usdc(ex, CLEARING_ACCOUNT).available;
    const availBefore = usdc(ex, 'alice').available;
    ex.setMarkPrice(M, u(80), TS++); // uPnL -20, margin 10 -> pot -10
    expect(usdc(ex, 'alice').available).toBe(availBefore); // payout 0
    const feeAfter = usdc(ex, FEE_ACCOUNT).available;
    const clearingAfter = usdc(ex, CLEARING_ACCOUNT).available;
    expect(feeAfter).toBeGreaterThanOrEqual(0n);
    // total absorbed = deficit 10; clearing also received the +20 mirror
    expect(feeBefore - feeAfter + (clearingBefore + u(20) - clearingAfter)).toBe(u(10));
    t.check(ex);
  });

  it('funding: longs pay positive rate; zero-sum incl. clearing; sweep liquidates eroded margins', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1));
    ex.setMarkPrice(M, u(100), TS++);
    const rate = u('0.0001');
    const evts = ex.applyFunding(M, rate, TS++);
    const fund = evts.filter((e) => e.kind === 'fundingApplied');
    expect(fund).toHaveLength(2);
    const byUser = new Map(fund.map((e) => (e.kind === 'fundingApplied' ? [e.userId, e.payment] : ['', 0n])));
    expect(byUser.get('alice')).toBe(-u('0.01')); // long pays
    expect(byUser.get('bob')).toBe(u('0.01')); // short receives
    // payer's funding erodes isolated margin; receiver's funding is credited to
    // the withdrawable wallet (available), not locked into margin
    const bobAvailBefore = u(100_000) - u(100) - feeOn(u(100), PERP.makerFeeBps);
    expect(ex.getPosition('alice', M)!.margin).toBe(u(100) - u('0.01'));
    expect(ex.getPosition('bob', M)!.margin).toBe(u(100));
    expect(usdc(ex, 'bob').available).toBe(bobAvailBefore + u('0.01'));
    t.check(ex);
  });

  it('funding rounding remainder is absorbed by the fee account, clearing nets to zero', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u('0.103'));
    const clearingBefore = usdc(ex, CLEARING_ACCOUNT).available;
    ex.setMarkPrice(M, 9_999_999_999n, TS++);
    const feeBefore = usdc(ex, FEE_ACCOUNT).available;
    const evts = ex.applyFunding(M, 100n, TS++);
    const payments = evts
      .filter((e) => e.kind === 'fundingApplied')
      .map((e) => (e.kind === 'fundingApplied' ? e.payment : 0n));
    const sum = payments.reduce((a, b) => a + b, 0n);
    expect(sum).not.toBe(0n); // asymmetric floor rounding
    // clearing unchanged by funding; fee absorbed the remainder exactly
    expect(usdc(ex, CLEARING_ACCOUNT).available).toBe(clearingBefore);
    expect(usdc(ex, FEE_ACCOUNT).available - feeBefore).toBe(-sum);
    t.check(ex);
  });

  it('funding with no positions emits nothing; funding without mark price is a no-op', () => {
    const { ex } = setup();
    expect(ex.applyFunding(M, u('0.0001'), TS++)).toEqual([]);
    openPair(ex, u(100), u(1));
    expect(ex.applyFunding(M, u('0.0001'), TS++)).toEqual([]); // no mark yet
  });

  it('funding erosion triggers the liquidation sweep', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1)); // margins 10
    ex.setMarkPrice(M, u(100), TS++); // MM = 2.5, margin 10: safe
    // huge positive rate: longs pay 8 -> alice margin 2 < 2.5
    const evts = ex.applyFunding(M, u('0.08'), TS++);
    expect(evts.some((e) => e.kind === 'liquidation' && e.userId === 'alice')).toBe(true);
    expect(ex.getPosition('alice', M)).toBeUndefined();
    t.check(ex);
  });

  it('funding payment is clamped so margin never goes negative', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1));
    ex.setMarkPrice(M, u(100), TS++);
    const evts = ex.applyFunding(M, u('0.5'), TS++); // would charge 50 > margin 10
    const pay = evts.find((e) => e.kind === 'fundingApplied' && e.userId === 'alice');
    if (!pay || pay.kind !== 'fundingApplied') throw new Error('no funding event');
    expect(pay.payment).toBe(-u(10));
    t.check(ex);
  });

  it('funding residual transfer is clamped when the fee account is empty (clearing keeps it)', () => {
    // restore positions directly so FEE_ACCOUNT holds zero
    const ex = newExchange();
    ex.restoreState({
      balances: [
        { userId: 'alice', asset: 'USDC', available: u(1000), locked: 0n },
        { userId: 'bob', asset: 'USDC', available: u(1000), locked: 0n },
      ],
      positions: [
        { userId: 'alice', marketId: M, size: u('0.103'), entryPrice: u(100), leverage: 1, margin: u(11) },
        { userId: 'bob', marketId: M, size: -u('0.103'), entryPrice: u(100), leverage: 1, margin: u(11) },
      ],
      leverages: [],
      openOrders: [],
      markPrices: [{ marketId: M, price: 9_999_999_999n }],
      lastSeq: 100,
    });
    const evts = ex.applyFunding(M, 100n, TS++);
    const payments = evts
      .filter((e) => e.kind === 'fundingApplied')
      .map((e) => (e.kind === 'fundingApplied' ? e.payment : 0n));
    const sum = payments.reduce((a, b) => a + b, 0n);
    expect(sum).toBe(1n); // floor asymmetry: shorts gain one extra unit
    const fee = ex.getBalances(FEE_ACCOUNT).find((b) => b.asset === 'USDC')?.available ?? 0n;
    const clearing = ex.getBalances(CLEARING_ACCOUNT).find((b) => b.asset === 'USDC')?.available ?? 0n;
    expect(fee).toBe(0n); // cannot go negative -> transfer clamped
    expect(clearing).toBe(-sum); // clearing carries the crumb instead
    // full equity still conserves exactly (no money created). The receiver's
    // funding now lands in available (not margin), so conservation is checked
    // across the whole system: wallets + margins + clearing + fee.
    const aliceEq = usdc(ex, 'alice').available + ex.getPosition('alice', M)!.margin;
    const bobEq = usdc(ex, 'bob').available + ex.getPosition('bob', M)!.margin;
    expect(aliceEq + bobEq + clearing + fee).toBe(u(2022)); // 2×(1000 wallet + 11 margin)
  });

  it('liquidation price: equity equals maintenance margin at the computed mark (long & short)', () => {
    const { ex } = setup(10);
    openPair(ex, u(100), u(1)); // alice long, bob short, margin 10 each
    for (const user of ['alice', 'bob']) {
      const pos = ex.getPosition(user, M)!;
      const liq = liquidationPrice(pos, PERP)!;
      expect(liq).toBeGreaterThan(0n);
      const equity = pos.margin + unrealizedPnl(pos, liq);
      const mm = maintenanceMargin(pos, liq, PERP);
      // equity exactly meets MM at the liquidation price (within fixed-point rounding)
      expect(absBig(equity - mm)).toBeLessThanOrEqual(u(1) / 100n); // ≤ 0.01 USDC
    }
  });

  it('liquidation price marks the boundary: below liquidates a long, above survives', () => {
    const { ex, t } = setup(10);
    openPair(ex, u(100), u(1));
    const liq = liquidationPrice(ex.getPosition('alice', M)!, PERP)!;
    ex.setMarkPrice(M, liq + u(2), TS++); // a touch above → long survives
    expect(ex.getPosition('alice', M)).toBeDefined();
    ex.setMarkPrice(M, liq - u(1), TS++); // below → long is liquidated by the sweep
    expect(ex.getPosition('alice', M)).toBeUndefined();
    t.check(ex);
  });

  it('a 1x long has no positive liquidation price (margin covers a drop toward zero)', () => {
    const { ex } = setup(); // leverage 1: margin == notional
    openPair(ex, u(100), u(1));
    expect(liquidationPrice(ex.getPosition('alice', M)!, PERP)).toBeNull();
  });

  it('insufficient margin rejection uses INSUFFICIENT_MARGIN', () => {
    const ex = newExchange();
    ex.deposit('poor', 'USDC', u(10), TS++);
    expect(rejection(ex.submitOrder('poor', req(M, 'buy', 'limit', u(100), u(1)), TS++))?.code).toBe('INSUFFICIENT_MARGIN');
  });

  it('opposite-direction non-reduceOnly order locks full IM and releases unused lock', () => {
    const { ex, t } = setup();
    openPair(ex, u(100), u(1)); // alice long 1 margin 100
    const availBefore = usdc(ex, 'alice').available;
    // alice places a closing sell (non-RO): locks full IM even though it reduces
    acceptedId(ex.submitOrder('alice', req(M, 'sell', 'limit', u(110), u(1)), TS++));
    const n = mulUnits(u(110), u(1));
    expect(usdc(ex, 'alice').locked).toBe(n + feeOn(n, PERP.takerFeeBps));
    // carol lifts it -> close; entire lock comes back (margin funds the close)
    ex.submitOrder('carol', req(M, 'buy', 'limit', u(110), u(1)), TS++);
    expect(usdc(ex, 'alice').locked).toBe(0n);
    const fee = feeOn(n, PERP.makerFeeBps); // alice was maker
    expect(usdc(ex, 'alice').available).toBe(availBefore + u(100) + u(10) - fee);
    t.check(ex);
  });

  it('account summary aggregates equity and margin in use', () => {
    const { ex } = setup();
    openPair(ex, u(100), u(1));
    ex.setMarkPrice(M, u(110), TS++);
    const s = ex.getAccountSummary('alice');
    expect(s.marginUsed).toBe(u(100));
    const usdcRow = s.balances.find((b) => b.asset === 'USDC')!;
    expect(s.perpEquity).toBe(usdcRow.available + usdcRow.locked + u(100) + u(10));
  });
});

describe('tiered maintenance margin (real-venue margin tiers)', () => {
  const pos = (size: bigint): Position => ({
    userId: 'x',
    marketId: M,
    size,
    entryPrice: u(100_000),
    leverage: 1,
    margin: 0n,
  });
  const MARK = u(100_000); // $100k mark so notional = |size| × 100k

  it('tieredMmRate steps up by notional bracket', () => {
    expect(tieredMmRate(u(49_999))).toBe(0n); //          ≤ $50k → base
    expect(tieredMmRate(u(50_000))).toBe(0n);
    expect(tieredMmRate(u(50_001))).toBe(u('0.01')); //   $50k–250k → 1%
    expect(tieredMmRate(u(250_000))).toBe(u('0.01'));
    expect(tieredMmRate(u(250_001))).toBe(u('0.02')); //  $250k–1M → 2%
    expect(tieredMmRate(u(1_000_000))).toBe(u('0.02'));
    expect(tieredMmRate(u(1_000_001))).toBe(u('0.05')); // $1M–5M → 5%
    expect(tieredMmRate(u(5_000_000))).toBe(u('0.05'));
    expect(tieredMmRate(u(5_000_001))).toBe(u('0.1')); //  > $5M → 10%
  });

  it('small positions are unchanged (base = notional/(2·maxLev))', () => {
    // size 0.1 @ $100k = $10k notional, base tier → exactly the old flat formula
    const notional = mulUnits(MARK, u('0.1'));
    const base = divRound(notional, 2n * BigInt(PERP.maxLeverage), 'ceil');
    expect(maintenanceMargin(pos(u('0.1')), MARK, PERP)).toBe(base);
  });

  it('large positions require a strictly higher MM than the flat rate (liquidate earlier)', () => {
    // size 20 @ $100k = $2M notional → 5% tier. flat (maxLev 20) = 2.5% = $50k.
    const notional = mulUnits(MARK, u(20)); // $2,000,000
    const flat = divRound(notional, 2n * BigInt(PERP.maxLeverage), 'ceil'); // $50,000
    const mm = maintenanceMargin(pos(u(20)), MARK, PERP);
    expect(mm).toBe(mulUnits(notional, u('0.05'), 'ceil')); // $100,000 (5%)
    expect(mm > flat).toBe(true);
  });

  it('property: maintenance margin is non-decreasing in position size', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2_000n }),
        fc.bigInt({ min: 1n, max: 2_000n }),
        (a, b) => {
          const sa = a * u('0.01');
          const sb = b * u('0.01');
          const mmA = maintenanceMargin(pos(sa), MARK, PERP);
          const mmB = maintenanceMargin(pos(sb), MARK, PERP);
          if (sa <= sb) expect(mmA <= mmB).toBe(true);
        },
      ),
    );
  });

  it('property: MM is always >= the flat base rate (tiers only tighten, never loosen)', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 100_000n }), (k) => {
        const size = k * u('0.001');
        const notional = mulUnits(MARK, size);
        const base = divRound(notional, 2n * BigInt(PERP.maxLeverage), 'ceil');
        expect(maintenanceMargin(pos(size), MARK, PERP) >= base).toBe(true);
      }),
    );
  });
});

describe('ADL — auto-deleveraging bad-debt waterfall (opt-in)', () => {
  const M2 = PERP.id;
  let TS2 = 500_000;
  function adlSetup(): { ex: Exchange; t: ConservationTracker } {
    const ex = new Exchange({ markets: [PERP], adl: true });
    const t = new ConservationTracker();
    for (const user of ['alice', 'bob', 'carol']) {
      ex.deposit(user, 'USDC', u(100_000), TS2++);
      t.deposit('USDC', u(100_000));
      ex.setLeverage(user, M2, 10, TS2++);
    }
    return { ex, t };
  }
  function openPair2(ex: Exchange, price: bigint, qty: bigint, longUser: string, shortUser: string): void {
    ex.submitOrder(shortUser, req(M2, 'sell', 'limit', price, qty), TS2++);
    const e = ex.submitOrder(longUser, req(M2, 'buy', 'limit', price, qty), TS2++);
    if (trades(e).length === 0) throw new Error('openPair2 did not fill');
  }
  const usdcOf = (ex: Exchange, u2: string): bigint =>
    ex.getBalances(u2).find((b) => b.asset === 'USDC')?.available ?? 0n;

  it('socializes bad debt onto the profitable counterparty; clearing stays whole; conservation exact', () => {
    const { ex, t } = adlSetup();
    // alice long 1 @100 (margin 10), bob short 1 @100 (margin 10, the winner)
    openPair2(ex, u(100), u(1), 'alice', 'bob');
    const bobBefore = usdcOf(ex, 'bob');
    const clearingBefore = usdcOf(ex, CLEARING_ACCOUNT);
    // crash to 80: alice uPnL -20 (pot = 10-20 = -10 bad debt); bob uPnL +20 (winner)
    const evts = ex.setMarkPrice(M2, u(80), TS2++);
    // alice liquidated for maintenance; bob auto-deleveraged to fund the deficit
    const reasons = evts.filter((e) => e.kind === 'liquidation').map((e) => (e.kind === 'liquidation' ? e.reason : ''));
    expect(reasons).toContain('maintenance');
    expect(reasons).toContain('adl');
    // both positions closed
    expect(ex.getPosition('alice', M2)).toBeUndefined();
    expect(ex.getPosition('bob', M2)).toBeUndefined();
    // alice forfeited her margin (payout 0)
    // bob realized +20 profit but was HAIRCUT by the 10 deficit (insurance had
    // only the fees), so bob nets margin 10 + 20 - haircut. bob never below margin.
    const bobAfter = usdcOf(ex, 'bob');
    expect(bobAfter).toBeGreaterThanOrEqual(bobBefore + u(10)); // got >= margin back
    // clearing did not absorb bad debt (ADL covered it) — unchanged from before
    expect(usdcOf(ex, CLEARING_ACCOUNT)).toBe(clearingBefore);
    // no real user is ever negative; conservation exact
    for (const usr of ['alice', 'bob', 'carol']) expect(usdcOf(ex, usr) >= 0n).toBe(true);
    t.check(ex);
  });

  it('ADL haircut never pushes the deleveraged winner below its own margin', () => {
    const { ex, t } = adlSetup();
    openPair2(ex, u(100), u(1), 'alice', 'bob');
    ex.setMarkPrice(M2, u(80), TS2++);
    // bob (winner) closed: profit was 20, deficit <= 10, so bob keeps margin + (>=10)
    expect(usdcOf(ex, 'bob') >= u(100_000)).toBe(true); // started 100k, came out ahead
    t.check(ex);
  });

  it('with ADL disabled (default), the house clearing absorbs bad debt instead', () => {
    const ex = new Exchange({ markets: [PERP] }); // adl off
    const t = new ConservationTracker();
    for (const usr of ['alice', 'bob']) {
      ex.deposit(usr, 'USDC', u(100_000), TS2++);
      t.deposit('USDC', u(100_000));
      ex.setLeverage(usr, M2, 10, TS2++);
    }
    ex.submitOrder('bob', req(M2, 'sell', 'limit', u(100), u(1)), TS2++);
    ex.submitOrder('alice', req(M2, 'buy', 'limit', u(100), u(1)), TS2++);
    const evts = ex.setMarkPrice(M2, u(80), TS2++);
    // only a maintenance liquidation — bob (winner) is NOT auto-deleveraged
    expect(evts.filter((e) => e.kind === 'liquidation').map((e) => (e.kind === 'liquidation' ? e.reason : ''))).toEqual(['maintenance']);
    expect(ex.getPosition('bob', M2)).toBeDefined(); // winner keeps the position (no ADL)
    t.check(ex);
  });

  it('property: through ADL liquidations, no real user is ever negative and conservation holds', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 60, max: 140 }), { minLength: 2, maxLength: 12 }), (marks) => {
        const ex = new Exchange({ markets: [PERP], adl: true });
        const t = new ConservationTracker();
        const users = ['u0', 'u1', 'u2', 'u3'];
        let ts = 700_000;
        for (const usr of users) {
          ex.deposit(usr, 'USDC', u(50_000), ts++);
          t.deposit('USDC', u(50_000));
          ex.setLeverage(usr, M2, 10, ts++);
        }
        // build offsetting positions
        ex.submitOrder('u1', req(M2, 'sell', 'limit', u(100), u(2)), ts++);
        ex.submitOrder('u0', req(M2, 'buy', 'limit', u(100), u(2)), ts++);
        ex.submitOrder('u3', req(M2, 'sell', 'limit', u(100), u(1)), ts++);
        ex.submitOrder('u2', req(M2, 'buy', 'limit', u(100), u(1)), ts++);
        for (const mk of marks) {
          ex.setMarkPrice(M2, u(mk), ts++);
          t.check(ex); // conservation + per-user non-negativity (CLEARING exempt) after every mark
        }
      }),
      { numRuns: 80 },
    );
  });
});
