/**
 * Exchange — pure, deterministic, synchronous matching engine facade.
 * Every mutation returns EngineEvent[]; no I/O, no Date.now(), no randomness.
 */
import {
  CLEARING_ACCOUNT,
  DexError,
  FEE_ACCOUNT,
  absBig,
  divRound,
  feeOn,
  isMultipleOf,
  maxBig,
  minBig,
  mulUnits,
  signBig,
  type AccountSummary,
  type Balance,
  type BalanceReason,
  type CancelReason,
  type EngineEvent,
  type MarketConfig,
  type Order,
  type OrderRequest,
  type OrderbookSnapshot,
  type Position,
  type Side,
  type Trade,
} from '@dex/shared';
import { Ledger } from './ledger.js';
import { OrderBook, remainingQty, toPublicOrder, type EngineOrder } from './orderbook.js';
import { PositionBook, maintenanceMargin, unrealizedPnl, vwapEntry } from './perp.js';
import { perpLock, spotBuyLock, spotSellLock } from './locks.js';

interface MarketState {
  config: MarketConfig;
  book: OrderBook;
}

interface PerpSettleResult {
  fee: bigint;
  realized: bigint;
  clearingTouched: boolean;
}

const DEFAULT_DEPTH = 50;

export class Exchange {
  private readonly markets = new Map<string, MarketState>();
  private readonly ledger = new Ledger(new Set([CLEARING_ACCOUNT]));
  private readonly positions = new PositionBook();
  /** LIVE (resting/open) orders only — bounded by the live book, not by churn */
  private readonly orders = new Map<string, EngineOrder>();
  /**
   * Bounded insertion-ordered cache of recently terminal (filled/cancelled)
   * orders so `getOrder` still answers right after an order settles. Capped so
   * the book mirror's high-churn requoting cannot grow memory without bound;
   * full order history lives in the DB projection, not here.
   */
  private readonly terminalOrders = new Map<string, EngineOrder>();
  private static readonly TERMINAL_CACHE = 20_000;
  /** ids of RESTING (open, in-book) orders per user */
  private readonly openByUser = new Map<string, Set<string>>();
  /** userId -> (clientOrderId -> orderId) for LIVE orders, to reject duplicates */
  private readonly clientIds = new Map<string, Map<string, string>>();
  /** `${userId} ${marketId}` -> leverage */
  private readonly leverages = new Map<string, number>();
  private readonly markPrices = new Map<string, bigint>();
  private seqCounter = 0;
  /** when true, bad debt that insurance can't cover is socialized via ADL
   * (auto-deleveraging profitable counterparties) before the house clearing
   * account absorbs the irreducible remainder. Off by default. */
  private readonly adlEnabled: boolean;

  constructor(opts?: { markets?: MarketConfig[]; adl?: boolean }) {
    this.adlEnabled = opts?.adl ?? false;
    for (const m of opts?.markets ?? []) this.addMarket(m);
  }

  get seq(): number {
    return this.seqCounter;
  }

  private nextSeq(): number {
    return ++this.seqCounter;
  }

  addMarket(config: MarketConfig): void {
    if (this.markets.has(config.id)) {
      throw new DexError('INVALID_ORDER', `market ${config.id} already exists`);
    }
    if (config.tickSize <= 0n || config.lotSize <= 0n || config.minNotional < 0n) {
      throw new DexError('INVALID_ORDER', `invalid market config ${config.id}`);
    }
    if (!Number.isInteger(config.maxLeverage) || config.maxLeverage < 1) {
      throw new DexError('INVALID_ORDER', `invalid maxLeverage for ${config.id}`);
    }
    this.markets.set(config.id, { config: { ...config }, book: new OrderBook() });
  }

  // ---------------------------------------------------------------- balances

  private emitBalance(
    evts: EngineEvent[],
    ts: number,
    userId: string,
    asset: string,
    reason: BalanceReason,
  ): void {
    const { available, locked } = this.ledger.get(userId, asset);
    evts.push({ kind: 'balanceChanged', seq: this.nextSeq(), ts, userId, asset, available, locked, reason });
  }

  deposit(userId: string, asset: string, amount: bigint, ts: number): EngineEvent[] {
    if (amount <= 0n) throw new DexError('INVALID_ORDER', 'deposit amount must be > 0');
    this.ledger.credit(userId, asset, amount);
    const evts: EngineEvent[] = [];
    this.emitBalance(evts, ts, userId, asset, 'deposit');
    return evts;
  }

  withdraw(userId: string, asset: string, amount: bigint, ts: number): EngineEvent[] {
    if (amount <= 0n) throw new DexError('INVALID_ORDER', 'withdraw amount must be > 0');
    if (this.ledger.available(userId, asset) < amount) {
      throw new DexError('INSUFFICIENT_BALANCE', `insufficient ${asset} to withdraw`);
    }
    this.ledger.debit(userId, asset, amount);
    const evts: EngineEvent[] = [];
    this.emitBalance(evts, ts, userId, asset, 'withdraw');
    return evts;
  }

  // ------------------------------------------------------------------ orders

  private leverageOf(userId: string, marketId: string): number {
    return this.leverages.get(`${userId} ${marketId}`) ?? 1;
  }

  /** Σ remaining qty of user's resting reduceOnly orders on a market. */
  private openReduceOnlyQty(userId: string, marketId: string, excludeId?: string): bigint {
    let total = 0n;
    for (const id of this.openByUser.get(userId) ?? []) {
      if (id === excludeId) continue;
      const o = this.orders.get(id);
      if (o && o.status === 'open' && o.marketId === marketId && o.reduceOnly) {
        total += remainingQty(o);
      }
    }
    return total;
  }

  submitOrder(userId: string, req: OrderRequest, ts: number): EngineEvent[] {
    const evts: EngineEvent[] = [];
    const reject = (code: string, reason: string): EngineEvent[] => {
      evts.push({
        kind: 'orderRejected',
        seq: this.nextSeq(),
        ts,
        userId,
        marketId: req.marketId,
        code,
        reason,
        clientOrderId: req.clientOrderId ?? null,
      });
      return evts;
    };

    // 1. market exists
    const ms = this.markets.get(req.marketId);
    if (!ms) return reject('MARKET_NOT_FOUND', `unknown market ${req.marketId}`);
    const m = ms.config;

    // structural validity
    if (req.type === 'market' && req.price === undefined) {
      return reject('INVALID_ORDER', 'market orders require a worst-acceptable price bound');
    }
    if (req.type === 'limit' && req.price === undefined) {
      return reject('INVALID_ORDER', 'limit orders require a price');
    }
    if (req.type === 'market' && req.postOnly) {
      return reject('INVALID_ORDER', 'market orders cannot be postOnly');
    }

    // clientOrderId must be unique among the user's LIVE orders (idempotency)
    if (req.clientOrderId !== undefined && this.clientIds.get(userId)?.has(req.clientOrderId)) {
      return reject('DUPLICATE_CLIENT_ORDER_ID', `clientOrderId ${req.clientOrderId} already in use`);
    }
    if (req.type === 'market' && req.tif === 'GTC') {
      return reject('INVALID_ORDER', 'market orders must be IOC or FOK');
    }

    // 2. price > 0 & tick multiple (limit price or market bound)
    const price = req.price!;
    if (price <= 0n) return reject('INVALID_ORDER', 'price must be > 0');
    if (!isMultipleOf(price, m.tickSize)) return reject('TICK_SIZE', 'price not a tick multiple');

    // 3. qty > 0 & lot multiple
    if (req.qty <= 0n) return reject('INVALID_ORDER', 'qty must be > 0');
    if (!isMultipleOf(req.qty, m.lotSize)) return reject('LOT_SIZE', 'qty not a lot multiple');

    // 4. minNotional at price-or-bound
    if (mulUnits(price, req.qty) < m.minNotional) {
      return reject('MIN_NOTIONAL', 'order notional below minimum');
    }

    // 5. reduceOnly rules
    const reduceOnly = req.reduceOnly === true;
    if (reduceOnly) {
      if (m.type !== 'perp') return reject('REDUCE_ONLY_VIOLATION', 'reduceOnly is perp-only');
      const pos = this.positions.get(userId, req.marketId);
      const dir = req.side === 'buy' ? 1n : -1n;
      if (!pos || signBig(pos.size) !== -dir) {
        return reject('REDUCE_ONLY_VIOLATION', 'no opposite position to reduce');
      }
      const others = this.openReduceOnlyQty(userId, req.marketId);
      if (req.qty + others > absBig(pos.size)) {
        return reject('REDUCE_ONLY_VIOLATION', 'reduceOnly qty exceeds position');
      }
    }

    // 6. leverage / balance lock requirement
    const leverage = m.type === 'perp' ? this.leverageOf(userId, req.marketId) : 1;
    let lockAsset: string | null = null;
    let required = 0n;
    if (m.type === 'spot') {
      if (req.side === 'buy') {
        lockAsset = m.quote;
        required = spotBuyLock(price, req.qty, m.takerFeeBps);
      } else {
        lockAsset = m.base;
        required = spotSellLock(req.qty);
      }
    } else if (!reduceOnly) {
      lockAsset = m.quote;
      required = perpLock(price, req.qty, leverage, m.takerFeeBps);
    }
    if (required > 0n && this.ledger.available(userId, lockAsset!) < required) {
      return reject(
        m.type === 'spot' ? 'INSUFFICIENT_BALANCE' : 'INSUFFICIENT_MARGIN',
        'insufficient balance to lock for order',
      );
    }

    // 7. postOnly / FOK
    const oppSide = ms.book.opposite(req.side);
    if (req.postOnly) {
      const best = oppSide.best();
      if (best && oppSide.inBound(best.price, price)) {
        return reject('POST_ONLY_WOULD_CROSS', 'postOnly order would cross');
      }
    }
    if (req.tif === 'FOK') {
      // Exact dry-run of the matching loop: a static depth sum over-counts
      // because fills can evaporate book qty mid-match (a maker's position
      // shrinks -> their resting reduceOnly orders get auto-trimmed before
      // the taker reaches them) and own orders are STP-cancelled, not filled.
      const fillable = this.simulateFillable(ms, userId, req.side, req.qty, price);
      if (fillable < req.qty) return reject('FOK_NOT_FILLED', 'FOK cannot fill fully');
    }

    // 8. accept + lock + match
    const s = this.nextSeq();
    const order: EngineOrder = {
      id: `o${s}`,
      userId,
      marketId: req.marketId,
      side: req.side,
      type: req.type,
      price,
      qty: req.qty,
      filledQty: 0n,
      status: 'open',
      tif: req.tif,
      postOnly: req.postOnly === true,
      reduceOnly,
      clientOrderId: req.clientOrderId ?? null,
      seq: s,
      ts,
      lockRemaining: required,
      lockAsset,
      leverage,
      resting: false,
    };
    // NOTE: `orders` holds only LIVE (resting) orders — it is populated when
    // the order rests (below) and deleted on terminal transitions, mirroring
    // `openByUser`. This bounds memory under the book mirror's high-churn
    // requoting (terminal order history lives in the DB projection, not here).
    evts.push({ kind: 'orderAccepted', seq: s, ts, order: toPublicOrder(order) });
    if (required > 0n) {
      this.ledger.lock(userId, lockAsset!, required);
      this.emitBalance(evts, ts, userId, lockAsset!, 'lock');
    }

    this.matchOrder(ms, order, evts, ts);

    // remainder handling
    if (order.status === 'open' && remainingQty(order) > 0n) {
      if (order.type === 'market') {
        const reason: CancelReason = ms.book.opposite(order.side).isEmpty()
          ? 'bookExhausted'
          : 'slippage';
        this.cancelInternal(ms, order, reason, evts, ts);
      } else if (order.tif === 'IOC') {
        this.cancelInternal(ms, order, 'ioc', evts, ts);
      } else {
        ms.book.side(order.side).insert(order);
        order.resting = true;
        this.orders.set(order.id, order); // now live — track it
        let set = this.openByUser.get(userId);
        if (!set) {
          set = new Set();
          this.openByUser.set(userId, set);
        }
        set.add(order.id);
        if (order.clientOrderId !== null) {
          let cids = this.clientIds.get(userId);
          if (!cids) {
            cids = new Map();
            this.clientIds.set(userId, cids);
          }
          cids.set(order.clientOrderId, order.id);
        }
      }
    }
    return evts;
  }

  // ---------------------------------------------------------------- matching

  /** Move a now-terminal order out of the live map into the bounded cache. */
  private retire(o: EngineOrder): void {
    this.orders.delete(o.id);
    if (o.clientOrderId !== null) {
      const cids = this.clientIds.get(o.userId);
      if (cids?.get(o.clientOrderId) === o.id) {
        cids.delete(o.clientOrderId);
        if (cids.size === 0) this.clientIds.delete(o.userId);
      }
    }
    this.terminalOrders.set(o.id, o);
    if (this.terminalOrders.size > Exchange.TERMINAL_CACHE) {
      const oldest = this.terminalOrders.keys().next().value;
      if (oldest !== undefined) this.terminalOrders.delete(oldest);
    }
  }

  private matchOrder(ms: MarketState, taker: EngineOrder, evts: EngineEvent[], ts: number): void {
    const m = ms.config;
    const opp = ms.book.opposite(taker.side);
    const bound = taker.price!;
    while (remainingQty(taker) > 0n) {
      const lvl = opp.best();
      if (!lvl || !opp.inBound(lvl.price, bound)) break;
      const maker = lvl.orders[0]!;
      if (maker.userId === taker.userId) {
        // self-trade prevention: cancel the RESTING order, continue matching
        this.cancelInternal(ms, maker, 'selfTrade', evts, ts);
        continue;
      }
      let q = minBig(remainingQty(taker), remainingQty(maker));
      if (maker.reduceOnly) {
        // safety guard — the auto-trim invariant should make this a no-op
        const pos = this.positions.get(maker.userId, m.id);
        const dir = maker.side === 'buy' ? 1n : -1n;
        const closable = pos && signBig(pos.size) === -dir ? absBig(pos.size) : 0n;
        if (closable === 0n) {
          this.cancelInternal(ms, maker, 'user', evts, ts);
          continue;
        }
        q = minBig(q, closable);
      }
      this.executeFill(ms, maker, taker, lvl.price, q, evts, ts);
      if (remainingQty(maker) === 0n) {
        opp.remove(maker);
        maker.resting = false;
        this.openByUser.get(maker.userId)?.delete(maker.id);
        this.retire(maker); // terminal — move to the bounded cache
      }
    }
    if (remainingQty(taker) === 0n) {
      taker.status = 'filled';
      this.retire(taker); // fully-filled taker never rested — cache it for getOrder
    }
  }

  private executeFill(
    ms: MarketState,
    maker: EngineOrder,
    taker: EngineOrder,
    price: bigint,
    q: bigint,
    evts: EngineEvent[],
    ts: number,
  ): void {
    const m = ms.config;
    maker.filledQty += q;
    taker.filledQty += q;
    let makerFee = 0n;
    let takerFee = 0n;
    let makerPerp: PerpSettleResult | null = null;
    let takerPerp: PerpSettleResult | null = null;

    if (m.type === 'spot') {
      const buy = maker.side === 'buy' ? maker : taker;
      const sell = maker.side === 'buy' ? taker : maker;
      const buyBps = buy === maker ? m.makerFeeBps : m.takerFeeBps;
      const sellBps = sell === maker ? m.makerFeeBps : m.takerFeeBps;
      const r = this.settleSpotFill(m, buy, sell, price, q, buyBps, sellBps);
      makerFee = maker === buy ? r.buyFee : r.sellFee;
      takerFee = taker === buy ? r.buyFee : r.sellFee;
    } else {
      makerPerp = this.settlePerpSide(m, maker, price, q, m.makerFeeBps);
      takerPerp = this.settlePerpSide(m, taker, price, q, m.takerFeeBps);
      makerFee = makerPerp.fee;
      takerFee = takerPerp.fee;
    }

    if (remainingQty(maker) === 0n) {
      maker.status = 'filled';
      if (maker.lockRemaining !== 0n) throw new DexError('INTERNAL', 'filled maker holds lock');
    }
    if (remainingQty(taker) === 0n) {
      taker.status = 'filled';
      if (taker.lockRemaining !== 0n) throw new DexError('INTERNAL', 'filled taker holds lock');
    }

    const s = this.nextSeq();
    const trade: Trade = {
      id: `t${s}`,
      marketId: m.id,
      price,
      qty: q,
      takerSide: taker.side,
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      makerUserId: maker.userId,
      takerUserId: taker.userId,
      makerFee,
      takerFee,
      seq: s,
      ts,
    };
    evts.push({ kind: 'trade', seq: s, ts, trade, makerOrder: toPublicOrder(maker), takerOrder: toPublicOrder(taker) });

    if (m.type === 'spot') {
      const buy = maker.side === 'buy' ? maker : taker;
      const sell = maker.side === 'buy' ? taker : maker;
      this.emitBalance(evts, ts, buy.userId, m.quote, 'trade');
      this.emitBalance(evts, ts, buy.userId, m.base, 'trade');
      this.emitBalance(evts, ts, sell.userId, m.base, 'trade');
      this.emitBalance(evts, ts, sell.userId, m.quote, 'trade');
      this.emitBalance(evts, ts, FEE_ACCOUNT, m.quote, 'fee');
    } else {
      for (const [o, r] of [
        [maker, makerPerp!],
        [taker, takerPerp!],
      ] as const) {
        this.emitBalance(evts, ts, o.userId, m.quote, 'trade');
        const pos = this.positions.get(o.userId, m.id);
        evts.push({
          kind: 'positionChanged',
          seq: this.nextSeq(),
          ts,
          userId: o.userId,
          marketId: m.id,
          size: pos?.size ?? 0n,
          entryPrice: pos?.entryPrice ?? 0n,
          leverage: pos?.leverage ?? o.leverage,
          margin: pos?.margin ?? 0n,
          realizedPnl: r.realized,
        });
      }
      if (makerFee + takerFee > 0n) this.emitBalance(evts, ts, FEE_ACCOUNT, m.quote, 'fee');
      if (makerPerp!.clearingTouched || takerPerp!.clearingTouched) {
        this.emitBalance(evts, ts, CLEARING_ACCOUNT, m.quote, 'pnl');
      }
      this.trimReduceOnly(ms, maker.userId, new Set([maker.id, taker.id]), evts, ts);
      this.trimReduceOnly(ms, taker.userId, new Set([maker.id, taker.id]), evts, ts);
    }
  }

  private settleSpotFill(
    m: MarketConfig,
    buy: EngineOrder,
    sell: EngineOrder,
    p: bigint,
    q: bigint,
    buyBps: number,
    sellBps: number,
  ): { buyFee: bigint; sellFee: bigint } {
    // buyer: spend from lock; maintain lockRemaining == spotBuyLock(price, remaining)
    const target = spotBuyLock(buy.price!, remainingQty(buy), m.takerFeeBps);
    const budget = buy.lockRemaining - target;
    const n = mulUnits(p, q);
    if (budget < n) throw new DexError('INTERNAL', 'spot buy lock underflow');
    let buyFee = feeOn(n, buyBps);
    if (buyFee > budget - n) buyFee = budget - n; // rounding-crumb clamp, never undercollect otherwise
    const refund = budget - n - buyFee;
    this.ledger.spendLocked(buy.userId, m.quote, n + buyFee);
    if (refund > 0n) this.ledger.unlock(buy.userId, m.quote, refund);
    buy.lockRemaining = target;
    this.ledger.credit(buy.userId, m.base, q);
    // seller: deliver base from lock, receive notional - fee
    this.ledger.spendLocked(sell.userId, m.base, q);
    sell.lockRemaining -= q;
    let sellFee = feeOn(n, sellBps);
    if (sellFee > n) sellFee = n;
    this.ledger.credit(sell.userId, m.quote, n - sellFee);
    this.ledger.credit(FEE_ACCOUNT, m.quote, buyFee + sellFee);
    return { buyFee, sellFee };
  }

  private settlePerpSide(
    m: MarketConfig,
    o: EngineOrder,
    p: bigint,
    q: bigint,
    roleBps: number,
  ): PerpSettleResult {
    const user = o.userId;
    const dir = o.side === 'buy' ? 1n : -1n;
    // release this fill's slice of the IM lock (non-reduceOnly orders)
    let budget = 0n;
    if (!o.reduceOnly) {
      const target = perpLock(o.price!, remainingQty(o), o.leverage, m.takerFeeBps);
      budget = o.lockRemaining - target;
      if (budget < 0n) throw new DexError('INTERNAL', 'perp lock underflow');
      this.ledger.spendLocked(user, m.quote, budget);
      o.lockRemaining = target;
    }
    let pos = this.positions.get(user, m.id);
    const closeQty = pos && signBig(pos.size) === -dir ? minBig(q, absBig(pos.size)) : 0n;
    const openQty = q - closeQty;
    let fee = 0n;
    let realized = 0n;
    let clearingDelta = 0n;
    let cashToAvail = 0n;

    if (closeQty > 0n) {
      const nC = mulUnits(p, closeQty);
      const absSize = absBig(pos!.size);
      realized =
        pos!.size > 0n ? mulUnits(p - pos!.entryPrice, closeQty) : mulUnits(pos!.entryPrice - p, closeQty);
      const released = (pos!.margin * closeQty) / absSize;
      pos!.margin -= released;
      pos!.size += dir * closeQty;
      let feeClose = feeOn(nC, roleBps);
      const pot = released + realized - feeClose;
      if (pot >= 0n) {
        cashToAvail += pot;
        clearingDelta -= realized;
      } else {
        // shortfall cascade: remaining margin -> available -> fee -> clearing
        let owe = -pot;
        const s1 = minBig(owe, pos!.margin);
        pos!.margin -= s1;
        owe -= s1;
        const avail = maxBig(this.ledger.available(user, m.quote), 0n);
        const s2 = minBig(owe, avail);
        if (s2 > 0n) this.ledger.debit(user, m.quote, s2);
        owe -= s2;
        const s3 = minBig(owe, feeClose);
        feeClose -= s3;
        owe -= s3;
        clearingDelta += -realized - owe; // clearing absorbs any unpaid remainder
      }
      fee += feeClose;
      if (pos!.size === 0n) {
        this.positions.remove(user, m.id);
        pos = undefined;
      }
    }

    if (openQty > 0n) {
      const nO = mulUnits(p, openQty);
      let feeOpen = feeOn(nO, roleBps);
      if (feeOpen > budget) feeOpen = budget;
      let marginAdd = divRound(nO, BigInt(o.leverage), 'floor');
      if (marginAdd > budget - feeOpen) marginAdd = budget - feeOpen;
      budget -= feeOpen + marginAdd;
      fee += feeOpen;
      pos = this.positions.get(user, m.id);
      if (pos) {
        const absOld = absBig(pos.size);
        pos.entryPrice = vwapEntry(pos.entryPrice, absOld, p, openQty);
        pos.size += dir * openQty;
        pos.margin += marginAdd;
      } else {
        this.positions.set({
          userId: user,
          marketId: m.id,
          size: dir * openQty,
          entryPrice: p,
          leverage: o.leverage,
          margin: marginAdd,
        });
      }
    }

    const toAvail = budget + cashToAvail; // unused lock slice + close proceeds
    if (toAvail > 0n) this.ledger.credit(user, m.quote, toAvail);
    if (fee > 0n) this.ledger.credit(FEE_ACCOUNT, m.quote, fee);
    if (clearingDelta !== 0n) this.ledger.credit(CLEARING_ACCOUNT, m.quote, clearingDelta);
    return { fee, realized, clearingTouched: clearingDelta !== 0n };
  }

  /**
   * Mutation-free replay of `matchOrder` semantics: how much of a hypothetical
   * taker order would ACTUALLY fill against the current book within `bound`.
   * Mirrors, against simulated state: STP (own resting orders cancel, fill 0),
   * reduceOnly closable capping, and the post-fill reduceOnly auto-trim that
   * `matchOrder` performs after every perp fill (a maker's earlier fill can
   * evaporate their deeper resting reduceOnly orders before the taker reaches
   * them). Used by the FOK all-or-none pre-check.
   */
  private simulateFillable(
    ms: MarketState,
    takerUserId: string,
    takerSide: Side,
    takerQty: bigint,
    bound: bigint,
  ): bigint {
    const m = ms.config;
    const opp = ms.book.opposite(takerSide);
    /** simulated signed position per user for this market (lazy from live state) */
    const simPos = new Map<string, bigint>();
    const posOf = (u: string): bigint => {
      let p = simPos.get(u);
      if (p === undefined) {
        p = this.positions.get(u, m.id)?.size ?? 0n;
        simPos.set(u, p);
      }
      return p;
    };
    /** simulated extra filled qty per resting order */
    const simFilled = new Map<string, bigint>();
    const remOf = (o: EngineOrder): bigint => remainingQty(o) - (simFilled.get(o.id) ?? 0n);
    /** orders simulated as cancelled (STP / trimmed / unfillable reduceOnly) */
    const dead = new Set<string>();

    /** mirror of trimReduceOnly against the simulated state */
    const simTrim = (userId: string, exclude: ReadonlySet<string>): void => {
      const set = this.openByUser.get(userId);
      if (!set || set.size === 0) return;
      const ps = posOf(userId);
      const posSign = signBig(ps);
      let cap = absBig(ps);
      const ros: EngineOrder[] = [];
      for (const id of set) {
        const o = this.orders.get(id);
        if (o && o.status === 'open' && !dead.has(o.id) && o.marketId === m.id && o.reduceOnly) {
          ros.push(o);
        }
      }
      ros.sort((a, b) => a.seq - b.seq);
      for (const o of ros) {
        if (!exclude.has(o.id)) continue;
        const dir = o.side === 'buy' ? 1n : -1n;
        if (posSign === -dir) cap = maxBig(0n, cap - remOf(o));
      }
      let used = 0n;
      for (const o of ros) {
        if (exclude.has(o.id)) continue;
        const dir = o.side === 'buy' ? 1n : -1n;
        const rem = remOf(o);
        if (posSign !== -dir || used + rem > cap) dead.add(o.id);
        else used += rem;
      }
    };

    let need = takerQty;
    let filled = 0n;
    for (const lvl of opp.levels) {
      if (need === 0n) break;
      if (!opp.inBound(lvl.price, bound)) break;
      for (const maker of [...lvl.orders]) {
        if (need === 0n) break;
        if (dead.has(maker.id)) continue;
        if (maker.userId === takerUserId) {
          dead.add(maker.id); // STP: resting own order is cancelled, fills nothing
          continue;
        }
        let q = minBig(need, remOf(maker));
        if (q === 0n) continue;
        if (maker.reduceOnly) {
          const ps = posOf(maker.userId);
          const dir = maker.side === 'buy' ? 1n : -1n;
          const closable = signBig(ps) === -dir ? absBig(ps) : 0n;
          if (closable === 0n) {
            dead.add(maker.id);
            continue;
          }
          q = minBig(q, closable);
        }
        simFilled.set(maker.id, (simFilled.get(maker.id) ?? 0n) + q);
        filled += q;
        need -= q;
        if (m.type === 'perp') {
          simPos.set(maker.userId, posOf(maker.userId) + (maker.side === 'buy' ? q : -q));
          simPos.set(takerUserId, posOf(takerUserId) + (takerSide === 'buy' ? q : -q));
          const excl = new Set([maker.id]);
          simTrim(maker.userId, excl);
          simTrim(takerUserId, excl);
        }
      }
    }
    return filled;
  }

  /** Cancel reduceOnly orders that can no longer reduce (position shrank/flipped/closed). */
  private trimReduceOnly(
    ms: MarketState,
    userId: string,
    exclude: ReadonlySet<string>,
    evts: EngineEvent[],
    ts: number,
  ): void {
    const set = this.openByUser.get(userId);
    if (!set || set.size === 0) return;
    const pos = this.positions.get(userId, ms.config.id);
    const posSign = pos ? signBig(pos.size) : 0n;
    let cap = pos ? absBig(pos.size) : 0n;
    const ros: EngineOrder[] = [];
    for (const id of set) {
      const o = this.orders.get(id);
      if (o && o.status === 'open' && o.marketId === ms.config.id && o.reduceOnly) ros.push(o);
    }
    ros.sort((a, b) => a.seq - b.seq);
    // in-flight excluded orders still consume closable capacity
    for (const o of ros) {
      if (!exclude.has(o.id)) continue;
      const dir = o.side === 'buy' ? 1n : -1n;
      if (posSign === -dir) cap = maxBig(0n, cap - remainingQty(o));
    }
    let used = 0n;
    for (const o of ros) {
      if (exclude.has(o.id)) continue;
      const dir = o.side === 'buy' ? 1n : -1n;
      const rem = remainingQty(o);
      if (posSign !== -dir || used + rem > cap) {
        this.cancelInternal(ms, o, 'user', evts, ts);
      } else {
        used += rem;
      }
    }
  }

  // ----------------------------------------------------------------- cancels

  private cancelInternal(
    ms: MarketState,
    o: EngineOrder,
    reason: CancelReason,
    evts: EngineEvent[],
    ts: number,
  ): void {
    if (o.status !== 'open') throw new DexError('INTERNAL', `cancel of non-open order ${o.id}`);
    o.status = 'cancelled';
    if (o.resting) {
      ms.book.side(o.side).remove(o);
      o.resting = false;
      this.openByUser.get(o.userId)?.delete(o.id);
    }
    this.retire(o); // terminal — move to the bounded cache
    const rel = o.lockRemaining;
    evts.push({
      kind: 'orderCancelled',
      seq: this.nextSeq(),
      ts,
      orderId: o.id,
      userId: o.userId,
      marketId: o.marketId,
      remainingQty: remainingQty(o),
      reason,
    });
    if (rel > 0n && o.lockAsset !== null) {
      this.ledger.unlock(o.userId, o.lockAsset, rel);
      o.lockRemaining = 0n;
      this.emitBalance(evts, ts, o.userId, o.lockAsset, 'unlock');
    }
  }

  cancelOrder(userId: string, orderId: string, ts: number): EngineEvent[] {
    const o = this.orders.get(orderId);
    if (!o || o.status !== 'open' || !o.resting) {
      throw new DexError('ORDER_NOT_FOUND', `order ${orderId} not found or not open`);
    }
    if (o.userId !== userId) {
      throw new DexError('NOT_AUTHORIZED', `order ${orderId} belongs to another user`);
    }
    const ms = this.markets.get(o.marketId)!;
    const evts: EngineEvent[] = [];
    this.cancelInternal(ms, o, 'user', evts, ts);
    return evts;
  }

  // ------------------------------------------------------- leverage and mark

  setLeverage(userId: string, marketId: string, leverage: number, ts: number): void {
    void ts;
    const ms = this.markets.get(marketId);
    if (!ms) throw new DexError('MARKET_NOT_FOUND', `unknown market ${marketId}`);
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new DexError('INVALID_ORDER', 'leverage must be a positive integer');
    }
    if (leverage > ms.config.maxLeverage) {
      throw new DexError('LEVERAGE_EXCEEDED', `leverage above max ${ms.config.maxLeverage}`);
    }
    if (this.positions.get(userId, marketId)) {
      throw new DexError('LEVERAGE_IN_USE', 'open position on market');
    }
    for (const id of this.openByUser.get(userId) ?? []) {
      const o = this.orders.get(id);
      if (o && o.status === 'open' && o.marketId === marketId) {
        throw new DexError('LEVERAGE_IN_USE', 'open orders on market');
      }
    }
    this.leverages.set(`${userId} ${marketId}`, leverage);
  }

  setMarkPrice(marketId: string, price: bigint, ts: number): EngineEvent[] {
    const ms = this.markets.get(marketId);
    if (!ms) throw new DexError('MARKET_NOT_FOUND', `unknown market ${marketId}`);
    if (price <= 0n) throw new DexError('INVALID_ORDER', 'mark price must be > 0');
    this.markPrices.set(marketId, price);
    const evts: EngineEvent[] = [];
    evts.push({ kind: 'markPrice', seq: this.nextSeq(), ts, marketId, price });
    this.liquidationSweep(ms, evts, ts);
    return evts;
  }

  // ------------------------------------------------------------- liquidation

  private liquidationSweep(ms: MarketState, evts: EngineEvent[], ts: number): void {
    const m = ms.config;
    if (m.type !== 'perp') return;
    const mark = this.markPrices.get(m.id);
    if (mark === undefined) return;
    for (const pos of this.positions.ofMarket(m.id)) {
      const upnl = unrealizedPnl(pos, mark);
      const mm = maintenanceMargin(pos, mark, m);
      if (pos.margin + upnl >= mm) continue;
      // force-close at mark (backstop, no book interaction)
      const userId = pos.userId;
      const size = pos.size;
      const margin = pos.margin;
      const realized = upnl;
      this.positions.remove(userId, m.id);
      const pot = margin + realized;
      const payout = maxBig(0n, pot);
      this.ledger.credit(CLEARING_ACCOUNT, m.quote, -realized);
      if (payout > 0n) this.ledger.credit(userId, m.quote, payout);
      let feeCover = 0n;
      if (pot < 0n) {
        // bad-debt waterfall: insurance (FEE_ACCOUNT) → ADL (socialize onto
        // profitable counterparties) → house clearing absorbs the remainder
        const deficit = -pot;
        feeCover = minBig(deficit, maxBig(this.ledger.available(FEE_ACCOUNT, m.quote), 0n));
        if (feeCover > 0n) this.ledger.debit(FEE_ACCOUNT, m.quote, feeCover);
        let rest = deficit - feeCover;
        rest = this.adlClawback(ms, mark, rest, evts, ts);
        if (rest > 0n) this.ledger.credit(CLEARING_ACCOUNT, m.quote, -rest);
      }
      evts.push({ kind: 'liquidation', seq: this.nextSeq(), ts, userId, marketId: m.id, size, markPrice: mark, reason: 'maintenance' });
      evts.push({
        kind: 'positionChanged',
        seq: this.nextSeq(),
        ts,
        userId,
        marketId: m.id,
        size: 0n,
        entryPrice: 0n,
        leverage: pos.leverage,
        margin: 0n,
        realizedPnl: realized,
      });
      this.emitBalance(evts, ts, userId, m.quote, 'liquidation');
      this.emitBalance(evts, ts, CLEARING_ACCOUNT, m.quote, 'liquidation');
      if (feeCover > 0n) this.emitBalance(evts, ts, FEE_ACCOUNT, m.quote, 'liquidation');
      // cancel the user's open orders on this market
      for (const id of [...(this.openByUser.get(userId) ?? [])]) {
        const o = this.orders.get(id);
        if (o && o.status === 'open' && o.marketId === m.id) {
          this.cancelInternal(ms, o, 'liquidation', evts, ts);
        }
      }
    }
  }

  /**
   * Auto-deleveraging: socialize `rest` of bad debt onto the most-profitable,
   * highest-leverage counterparties (ranked by uPnL × leverage, like a real
   * venue). Each is force-closed at mark, but its payout is HAIRCUT by its share
   * of the deficit — so it gives up part of its profit to fund the shortfall and
   * the house clearing account stays whole. The haircut never exceeds a winner's
   * profit, so no ADL'd account ever drops below its own margin (no user is
   * pushed negative). Returns the deficit still uncovered after ADL (0 when fully
   * socialized; > 0 only if there isn't enough open profit to absorb it).
   * No-op unless ADL is enabled. Conservation is exact: each close moves
   * −margin (positions) − realized (clearing mirror) + (margin + realized −
   * haircut) (user) = −haircut, matching the deficit it retires.
   */
  private adlClawback(ms: MarketState, mark: bigint, rest0: bigint, evts: EngineEvent[], ts: number): bigint {
    let rest = rest0;
    if (!this.adlEnabled || rest <= 0n) return rest;
    const m = ms.config;
    const winners = this.positions
      .ofMarket(m.id)
      .map((pos) => ({ pos, upnl: unrealizedPnl(pos, mark) }))
      .filter((w) => w.upnl > 0n)
      .sort((a, b) => {
        const sa = a.upnl * BigInt(a.pos.leverage);
        const sb = b.upnl * BigInt(b.pos.leverage);
        return sa < sb ? 1 : sa > sb ? -1 : 0; // highest ADL score first
      });
    for (const { pos, upnl } of winners) {
      if (rest <= 0n) break;
      const userId = pos.userId;
      const margin = pos.margin;
      const size = pos.size;
      const realized = upnl; // close at mark
      const haircut = minBig(rest, realized); // ≤ profit ⇒ payout ≥ margin
      this.positions.remove(userId, m.id);
      this.ledger.credit(CLEARING_ACCOUNT, m.quote, -realized); // mirror the realized PnL
      const payout = margin + realized - haircut;
      if (payout > 0n) this.ledger.credit(userId, m.quote, payout);
      rest -= haircut;
      evts.push({ kind: 'liquidation', seq: this.nextSeq(), ts, userId, marketId: m.id, size, markPrice: mark, reason: 'adl' });
      evts.push({
        kind: 'positionChanged',
        seq: this.nextSeq(),
        ts,
        userId,
        marketId: m.id,
        size: 0n,
        entryPrice: 0n,
        leverage: pos.leverage,
        margin: 0n,
        realizedPnl: realized,
      });
      this.emitBalance(evts, ts, userId, m.quote, 'liquidation');
      this.emitBalance(evts, ts, CLEARING_ACCOUNT, m.quote, 'liquidation');
      for (const id of [...(this.openByUser.get(userId) ?? [])]) {
        const o = this.orders.get(id);
        if (o && o.status === 'open' && o.marketId === m.id) {
          this.cancelInternal(ms, o, 'liquidation', evts, ts);
        }
      }
    }
    return rest;
  }

  // ----------------------------------------------------------------- funding

  applyFunding(marketId: string, rate: bigint, ts: number): EngineEvent[] {
    const ms = this.markets.get(marketId);
    if (!ms) throw new DexError('MARKET_NOT_FOUND', `unknown market ${marketId}`);
    const m = ms.config;
    const holders = this.positions.ofMarket(marketId);
    if (holders.length === 0) return [];
    const mark = this.markPrices.get(marketId);
    if (mark === undefined) return [];
    const evts: EngineEvent[] = [];
    let sumPayments = 0n;
    for (const pos of holders) {
      let payment = -mulUnits(mulUnits(pos.size, mark), rate);
      if (payment < -pos.margin) payment = -pos.margin; // margin can never go negative
      pos.margin += payment;
      this.ledger.credit(CLEARING_ACCOUNT, m.quote, -payment);
      sumPayments += payment;
      evts.push({
        kind: 'fundingApplied',
        seq: this.nextSeq(),
        ts,
        marketId,
        userId: pos.userId,
        rate,
        payment,
        markPrice: mark,
      });
    }
    // transfer the residual so funding nets to exactly zero on the clearing
    // account, FEE_ACCOUNT absorbing it (clamped so FEE never goes negative)
    let residual = -sumPayments;
    if (residual < 0n) residual = maxBig(residual, -maxBig(this.ledger.available(FEE_ACCOUNT, m.quote), 0n));
    if (residual !== 0n) {
      this.ledger.credit(FEE_ACCOUNT, m.quote, residual);
      this.ledger.credit(CLEARING_ACCOUNT, m.quote, -residual);
    }
    this.emitBalance(evts, ts, CLEARING_ACCOUNT, m.quote, 'funding');
    if (residual !== 0n) this.emitBalance(evts, ts, FEE_ACCOUNT, m.quote, 'funding');
    this.liquidationSweep(ms, evts, ts);
    return evts;
  }

  // ----------------------------------------------------------------- queries

  getOrderbook(marketId: string, depth = DEFAULT_DEPTH): OrderbookSnapshot {
    const ms = this.markets.get(marketId);
    if (!ms) throw new DexError('MARKET_NOT_FOUND', `unknown market ${marketId}`);
    return ms.book.snapshot(marketId, this.seqCounter, depth);
  }

  getOpenOrders(userId: string, marketId?: string): Order[] {
    const out: Order[] = [];
    for (const id of this.openByUser.get(userId) ?? []) {
      const o = this.orders.get(id);
      if (o && o.status === 'open' && (marketId === undefined || o.marketId === marketId)) {
        out.push(toPublicOrder(o));
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  getOrder(orderId: string): Order | undefined {
    const o = this.orders.get(orderId) ?? this.terminalOrders.get(orderId);
    return o ? toPublicOrder(o) : undefined;
  }

  /** Memory-bound observability: live (resting) + cached-terminal order counts. */
  orderMapSizes(): { live: number; terminalCache: number } {
    return { live: this.orders.size, terminalCache: this.terminalOrders.size };
  }

  getBalances(userId: string): Balance[] {
    return this.ledger.balancesOf(userId);
  }

  /** Extra read-only helper (additive to the contract): every balance row. */
  getAllBalances(): { userId: string; asset: string; available: bigint; locked: bigint }[] {
    return this.ledger.allRows();
  }

  getPositions(userId: string): Position[] {
    return this.positions.ofUser(userId).map((p) => ({ ...p }));
  }

  getPosition(userId: string, marketId: string): Position | undefined {
    const p = this.positions.get(userId, marketId);
    return p ? { ...p } : undefined;
  }

  getMarkPrice(marketId: string): bigint | undefined {
    return this.markPrices.get(marketId);
  }

  getAccountSummary(userId: string): AccountSummary {
    const positions = this.getPositions(userId);
    const usdc = this.ledger.get(userId, 'USDC');
    let marginUsed = 0n;
    let upnlSum = 0n;
    for (const p of positions) {
      marginUsed += p.margin;
      const mark = this.markPrices.get(p.marketId) ?? p.entryPrice;
      upnlSum += unrealizedPnl(p, mark);
    }
    return {
      address: userId,
      balances: this.getBalances(userId),
      positions,
      perpEquity: usdc.available + usdc.locked + marginUsed + upnlSum,
      marginUsed,
    };
  }

  getMarkets(): MarketConfig[] {
    return [...this.markets.values()].map((ms) => ({ ...ms.config }));
  }

  getMarket(marketId: string): MarketConfig | undefined {
    const ms = this.markets.get(marketId);
    return ms ? { ...ms.config } : undefined;
  }

  // ----------------------------------------------------------------- restore

  restoreState(state: {
    balances: { userId: string; asset: string; available: bigint; locked: bigint }[];
    positions: Position[];
    leverages: { userId: string; marketId: string; leverage: number }[];
    openOrders: Order[];
    markPrices: { marketId: string; price: bigint }[];
    lastSeq: number;
  }): void {
    this.ledger.clear();
    this.positions.clear();
    this.orders.clear();
    this.terminalOrders.clear();
    this.openByUser.clear();
    this.clientIds.clear();
    this.leverages.clear();
    this.markPrices.clear();
    for (const ms of this.markets.values()) {
      ms.book.bids.levels.length = 0;
      ms.book.asks.levels.length = 0;
    }
    for (const b of state.balances) this.ledger.setRow(b.userId, b.asset, b.available, b.locked);
    for (const p of state.positions) this.positions.set({ ...p });
    for (const l of state.leverages) this.leverages.set(`${l.userId} ${l.marketId}`, l.leverage);
    for (const mp of state.markPrices) this.markPrices.set(mp.marketId, mp.price);
    const sorted = [...state.openOrders].sort((a, b) => a.seq - b.seq);
    for (const o of sorted) {
      const ms = this.markets.get(o.marketId);
      if (!ms) throw new DexError('MARKET_NOT_FOUND', `restore: unknown market ${o.marketId}`);
      if (o.status !== 'open' || o.price === null) {
        throw new DexError('INTERNAL', `restore: order ${o.id} not restorable`);
      }
      const m = ms.config;
      const rem = o.qty - o.filledQty;
      const leverage = m.type === 'perp' ? this.leverageOf(o.userId, o.marketId) : 1;
      let lockAsset: string | null = null;
      let lockRemaining = 0n;
      if (m.type === 'spot') {
        lockAsset = o.side === 'buy' ? m.quote : m.base;
        lockRemaining = o.side === 'buy' ? spotBuyLock(o.price, rem, m.takerFeeBps) : spotSellLock(rem);
      } else if (!o.reduceOnly) {
        lockAsset = m.quote;
        lockRemaining = perpLock(o.price, rem, leverage, m.takerFeeBps);
      }
      const eo: EngineOrder = { ...o, lockRemaining, lockAsset, leverage, resting: true };
      this.orders.set(eo.id, eo);
      ms.book.side(eo.side).insert(eo);
      let set = this.openByUser.get(eo.userId);
      if (!set) {
        set = new Set();
        this.openByUser.set(eo.userId, set);
      }
      set.add(eo.id);
      if (eo.clientOrderId !== null) {
        let cids = this.clientIds.get(eo.userId);
        if (!cids) {
          cids = new Map();
          this.clientIds.set(eo.userId, cids);
        }
        cids.set(eo.clientOrderId, eo.id);
      }
    }
    this.seqCounter = state.lastSeq;
  }
}
