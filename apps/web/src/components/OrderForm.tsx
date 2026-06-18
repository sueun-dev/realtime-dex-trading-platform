import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { divRound, feeOn, fromUnits, mulDiv, mulUnits, roundToLot, roundToTick, toUnits } from '@dex/shared';
import type { OrderType, Side, TimeInForce } from '@dex/shared';
import { api, koMessage } from '../lib/api.js';
import type { PlaceOrderBody, TriggerDirection, TwapBody } from '../lib/api.js';
import { formatAmount, formatQty } from '../lib/format.js';
import { useAuthStore } from '../lib/auth.js';
import { useBookStore } from '../stores/book.js';
import { useMarketStore } from '../stores/market.js';
import { useOrderFormStore } from '../stores/orderform.js';
import { useUserStore } from '../stores/user.js';
import { toast } from '../stores/toast.js';

const DECIMAL_INPUT_RE = /^\d+(\.\d+)?$/;

function parseUnitsSafe(s: string): bigint | null {
  const trimmed = s.trim();
  if (!DECIMAL_INPUT_RE.test(trimmed)) return null;
  try {
    return toUnits(trimmed);
  } catch {
    return null;
  }
}

const PCT_OPTIONS = [25, 50, 75, 100] as const;

/**
 * Effective price the engine will lock for a market order: best±5% slippage
 * bound, tick-aligned. Buys round up at +5%, sells round down at -5%. Sizing
 * (applyPct) and submission must use the SAME bound, otherwise a 100% market
 * order is sized against the raw best price but locked at the inflated bound →
 * INSUFFICIENT_BALANCE/MARGIN.
 */
export function marketBound(best: bigint, side: Side, tickSize: bigint): bigint {
  const raw = side === 'buy' ? mulDiv(best, 105n, 100n) : mulDiv(best, 95n, 100n);
  return roundToTick(raw, tickSize, side === 'buy' ? 'ceil' : 'floor');
}

export function OrderForm() {
  const market = useMarketStore((s) => s.byId[s.selectedId]);
  const bestAsk = useBookStore((s) => s.asks[0]?.price);
  const bestBid = useBookStore((s) => s.bids[0]?.price);
  const balances = useUserStore((s) => s.balances);
  const token = useAuthStore((s) => s.token);
  const priceStr = useOrderFormStore((s) => s.priceStr);
  const setPriceStr = useOrderFormStore((s) => s.setPriceStr);
  const queryClient = useQueryClient();

  const [side, setSide] = useState<Side>('buy');
  const [type, setType] = useState<OrderType>('limit');
  const [qtyStr, setQtyStr] = useState('');
  const [leverage, setLeverage] = useState(1);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [postOnly, setPostOnly] = useState(false);
  const [triggerOn, setTriggerOn] = useState(false);
  const [triggerStr, setTriggerStr] = useState('');
  const [trailingOn, setTrailingOn] = useState(false);
  const [trailStr, setTrailStr] = useState('');
  const [twapOn, setTwapOn] = useState(false);
  const [twapSlices, setTwapSlices] = useState('5');
  const [twapMinutes, setTwapMinutes] = useState('30');
  // null = user hasn't overridden, so the direction follows the side default
  // (sell → below = stop-loss, buy → above = stop-buy).
  const [triggerDir, setTriggerDir] = useState<TriggerDirection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const leverageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const marketId = market?.id;
  useEffect(() => {
    setQtyStr('');
    setPriceStr('');
    setLeverage(1);
    setReduceOnly(false);
    setPostOnly(false);
    setTriggerOn(false);
    setTriggerStr('');
    setTriggerDir(null);
  }, [marketId, setPriceStr]);

  useEffect(
    () => () => {
      if (leverageTimer.current !== null) clearTimeout(leverageTimer.current);
    },
    [],
  );

  if (market === undefined) {
    return <div className="order-form dim">마켓 로딩 중…</div>;
  }

  const isPerp = market.type === 'perp';
  const limitPrice = parseUnitsSafe(priceStr);
  const referencePrice =
    type === 'market' ? ((side === 'buy' ? bestAsk : bestBid) ?? null) : limitPrice;
  const qty = parseUnitsSafe(qtyStr);

  const notional = qty !== null && qty > 0n && referencePrice !== null ? mulUnits(qty, referencePrice) : null;
  const feeBps = type === 'limit' && postOnly ? market.makerFeeBps : market.takerFeeBps;
  const fee = notional !== null ? feeOn(notional, feeBps) : null;
  const margin = isPerp && notional !== null ? divRound(notional, BigInt(leverage), 'ceil') : null;

  const availableAsset = !isPerp && side === 'sell' ? market.base : market.quote;
  const available = balances[availableAsset]?.available ?? 0n;

  // Default: sell → stop-loss (below), buy → stop-buy / breakout (above). The
  // user can override via the selector; once overridden we keep their choice.
  const defaultTriggerDir: TriggerDirection = side === 'sell' ? 'below' : 'above';
  const effectiveTriggerDir = triggerDir ?? defaultTriggerDir;

  const applyPct = (pct: number): void => {
    if (!isPerp && side === 'sell') {
      const target = roundToLot((available * BigInt(pct)) / 100n, market.lotSize);
      setQtyStr(fromUnits(target));
      return;
    }
    if (referencePrice === null || referencePrice <= 0n) {
      toast.error(type === 'market' ? '호가 정보가 없습니다' : '가격을 먼저 입력해주세요');
      return;
    }
    // For market orders, the engine locks at the slippage-bound price (best±5%),
    // not the raw best. Size against that SAME bound so 100% never over-sizes.
    const priceForSizing =
      type === 'market' ? marketBound(referencePrice, side, market.tickSize) : referencePrice;
    if (priceForSizing <= 0n) return;
    // 100% market orders get a 0.1% safety haircut so tick/fee rounding can't
    // tip the locked cost just past the available balance.
    const budget =
      type === 'market' && pct === 100
        ? (available * 999n) / 1000n
        : (available * BigInt(pct)) / 100n;
    // per-unit cost: margin (notional/leverage for perps) + worst-case taker fee
    const lev = isPerp ? BigInt(leverage) : 1n;
    const perUnit = divRound(priceForSizing, lev, 'ceil') + feeOn(priceForSizing, market.takerFeeBps);
    if (perUnit <= 0n) return;
    const target = roundToLot(divRound(budget * 10n ** 8n, perUnit, 'floor'), market.lotSize);
    setQtyStr(fromUnits(target));
  };

  const onLeverageChange = (next: number): void => {
    setLeverage(next);
    if (token === null) return;
    if (leverageTimer.current !== null) clearTimeout(leverageTimer.current);
    leverageTimer.current = setTimeout(() => {
      leverageTimer.current = null;
      api.setLeverage(market.id, next).catch((e: unknown) => toast.error(koMessage(e)));
    }, 400);
  };

  const submit = async (): Promise<void> => {
    if (token === null) {
      toast.error('지갑을 먼저 연결해주세요');
      return;
    }
    if (qty === null || qty <= 0n) {
      toast.error('수량을 입력해주세요');
      return;
    }

    // TWAP: slice the parent order over time (its own endpoint, mutually
    // exclusive with the trigger/trailing conditional path)
    if (twapOn) {
      const slices = Number(twapSlices);
      const minutes = Number(twapMinutes);
      if (!Number.isInteger(slices) || slices < 2) {
        toast.error('분할 횟수는 2회 이상이어야 합니다');
        return;
      }
      if (!Number.isFinite(minutes) || minutes <= 0) {
        toast.error('실행 시간(분)을 입력해주세요');
        return;
      }
      if (type === 'limit' && (limitPrice === null || limitPrice <= 0n)) {
        toast.error('가격을 입력해주세요');
        return;
      }
      const tbody: TwapBody = {
        marketId: market.id,
        side,
        totalQty: fromUnits(qty),
        durationMs: Math.round(minutes * 60_000),
        slices,
        type,
        ...(type === 'limit' && limitPrice !== null ? { limitPrice: fromUnits(limitPrice) } : {}),
        ...(isPerp ? { reduceOnly } : {}),
      };
      setSubmitting(true);
      try {
        await api.createTwap(tbody);
        toast.success('TWAP 주문이 시작되었습니다');
        setQtyStr('');
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['twaps'] }),
          queryClient.invalidateQueries({ queryKey: ['account'] }),
        ]);
      } catch (e) {
        toast.error(koMessage(e));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // A conditional order needs either a tick-valid trigger price, or — for a
    // trailing stop — a tick-valid trail distance (the engine seeds the stop).
    let triggerPrice: bigint | null = null;
    let trailDistance: bigint | null = null;
    if (triggerOn && trailingOn) {
      const parsed = parseUnitsSafe(trailStr);
      const dist = parsed === null ? null : roundToTick(parsed, market.tickSize, 'half-up');
      if (dist === null || dist <= 0n) {
        toast.error('트레일 간격을 입력해주세요');
        return;
      }
      trailDistance = dist;
    } else if (triggerOn) {
      const parsed = parseUnitsSafe(triggerStr);
      if (parsed === null || parsed <= 0n) {
        toast.error('트리거 가격을 입력해주세요');
        return;
      }
      triggerPrice = roundToTick(parsed, market.tickSize, 'half-up');
      if (triggerPrice <= 0n) {
        toast.error('트리거 가격을 입력해주세요');
        return;
      }
    }

    let price: bigint | null;
    let tif: TimeInForce;
    if (type === 'limit') {
      if (limitPrice === null || limitPrice <= 0n) {
        toast.error('가격을 입력해주세요');
        return;
      }
      price = limitPrice;
      tif = 'GTC';
    } else if (triggerOn) {
      // stop-MARKET: send NO price — the engine derives the bound at activation.
      price = null;
      tif = 'IOC';
    } else {
      // market order: IOC with a best±5% slippage bound, tick-aligned
      const base = side === 'buy' ? bestAsk : bestBid;
      if (base === undefined || base <= 0n) {
        toast.error('호가 정보가 없습니다');
        return;
      }
      price = marketBound(base, side, market.tickSize);
      tif = 'IOC';
    }

    const body: PlaceOrderBody = {
      marketId: market.id,
      side,
      type,
      qty: fromUnits(qty),
      tif,
    };
    if (price !== null) body.price = fromUnits(price);
    if (type === 'limit' && !isPerp) body.postOnly = postOnly;
    if (isPerp) body.reduceOnly = reduceOnly;
    if (trailDistance !== null) {
      body.trailDistance = fromUnits(trailDistance);
      body.triggerDirection = effectiveTriggerDir;
    } else if (triggerPrice !== null) {
      body.triggerPrice = fromUnits(triggerPrice);
      body.triggerDirection = effectiveTriggerDir;
    }

    setSubmitting(true);
    try {
      await api.placeOrder(body);
      toast.success('주문이 접수되었습니다');
      setQtyStr('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['account'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['fills'] }),
      ]);
    } catch (e) {
      toast.error(koMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="order-form" data-testid="order-form">
      <div className="side-toggle" role="group" aria-label="주문 방향">
        <button
          type="button"
          aria-pressed={side === 'buy'}
          className={`side-btn buy ${side === 'buy' ? 'active' : ''}`}
          onClick={() => setSide('buy')}
        >
          매수
        </button>
        <button
          type="button"
          aria-pressed={side === 'sell'}
          className={`side-btn sell ${side === 'sell' ? 'active' : ''}`}
          onClick={() => setSide('sell')}
        >
          매도
        </button>
      </div>

      <div className="tabs type-tabs" role="group" aria-label="주문 유형">
        <button
          type="button"
          aria-pressed={type === 'limit'}
          className={`tab ${type === 'limit' ? 'active' : ''}`}
          onClick={() => setType('limit')}
        >
          지정가
        </button>
        <button
          type="button"
          aria-pressed={type === 'market'}
          className={`tab ${type === 'market' ? 'active' : ''}`}
          onClick={() => setType('market')}
        >
          시장가
        </button>
      </div>

      <label className="field">
        <span className="field-label dim">가격 ({market.quote})</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder={type === 'market' ? '시장가' : '가격'}
          value={type === 'market' ? '' : priceStr}
          disabled={type === 'market'}
          onChange={(e) => setPriceStr(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label dim">수량 ({market.base})</span>
        <input
          type="text"
          inputMode="decimal"
          placeholder="수량"
          value={qtyStr}
          onChange={(e) => setQtyStr(e.target.value)}
        />
      </label>

      <div className="pct-row">
        {PCT_OPTIONS.map((pct) => (
          <button key={pct} type="button" className="pct-btn" onClick={() => applyPct(pct)}>
            {pct}%
          </button>
        ))}
      </div>

      {isPerp ? (
        <>
          <label className="field">
            <span className="field-label dim">
              레버리지 <strong className="accent">{leverage}x</strong>
            </span>
            <input
              type="range"
              min={1}
              max={market.maxLeverage}
              step={1}
              value={leverage}
              aria-label="레버리지"
              onChange={(e) => onLeverageChange(Number(e.target.value))}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
            <span>Reduce Only</span>
          </label>
        </>
      ) : (
        type === 'limit' && (
          <label className="check">
            <input type="checkbox" checked={postOnly} onChange={(e) => setPostOnly(e.target.checked)} />
            <span>Post Only</span>
          </label>
        )
      )}

      <div className="trigger-section">
        <label className="check trigger-toggle">
          <input
            type="checkbox"
            checked={twapOn}
            onChange={(e) => setTwapOn(e.target.checked)}
          />
          <span>TWAP 분할 주문</span>
        </label>
        {twapOn && (
          <div className="trigger-body">
            <label className="field">
              <span className="field-label dim">분할 횟수</span>
              <input
                type="text"
                inputMode="numeric"
                aria-label="분할 횟수"
                value={twapSlices}
                onChange={(e) => setTwapSlices(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label dim">실행 시간 (분)</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label="실행 시간(분)"
                value={twapMinutes}
                onChange={(e) => setTwapMinutes(e.target.value)}
              />
            </label>
            <p className="trigger-hint dim">
              {twapSlices || '…'}회로 나눠 {twapMinutes || '…'}분 동안 실행됩니다
            </p>
          </div>
        )}
      </div>

      {!twapOn && (
      <div className="trigger-section">
        <label className="check trigger-toggle">
          <input
            type="checkbox"
            checked={triggerOn}
            onChange={(e) => setTriggerOn(e.target.checked)}
          />
          <span>트리거 주문 (스탑/익절)</span>
        </label>
        {triggerOn && (
          <div className="trigger-body">
            <label className="check trailing-toggle">
              <input
                type="checkbox"
                checked={trailingOn}
                onChange={(e) => setTrailingOn(e.target.checked)}
              />
              <span>트레일링 스탑</span>
            </label>
            {trailingOn ? (
              <label className="field">
                <span className="field-label dim">트레일 간격 ({market.quote})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="트레일 간격"
                  aria-label="트레일 간격"
                  value={trailStr}
                  onChange={(e) => setTrailStr(e.target.value)}
                />
              </label>
            ) : (
              <label className="field">
                <span className="field-label dim">트리거 가격 ({market.quote})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="트리거 가격"
                  aria-label="트리거 가격"
                  value={triggerStr}
                  onChange={(e) => setTriggerStr(e.target.value)}
                />
              </label>
            )}
            <div className="trigger-dir" role="group" aria-label="트리거 방향">
              <button
                type="button"
                aria-pressed={effectiveTriggerDir === 'above'}
                className={`trigger-dir-btn ${effectiveTriggerDir === 'above' ? 'active' : ''}`}
                onClick={() => setTriggerDir('above')}
              >
                이상 ↑
              </button>
              <button
                type="button"
                aria-pressed={effectiveTriggerDir === 'below'}
                className={`trigger-dir-btn ${effectiveTriggerDir === 'below' ? 'active' : ''}`}
                onClick={() => setTriggerDir('below')}
              >
                이하 ↓
              </button>
            </div>
            <p className="trigger-hint dim">
              {trailingOn
                ? `스탑이 시장가를 ${effectiveTriggerDir === 'above' ? '위로' : '아래로'} ${trailStr || '…'} 간격으로 따라갑니다`
                : `시장가가 트리거 ${effectiveTriggerDir === 'above' ? '이상' : '이하'}일 때 주문이 활성화됩니다`}
            </p>
          </div>
        )}
      </div>
      )}

      <div className="summary">
        <div className="summary-row">
          <span className="dim">주문 가능</span>
          <span data-testid="available-value">
            {formatQty(available)} {availableAsset}
          </span>
        </div>
        <div className="summary-row">
          <span className="dim">주문금액</span>
          <span data-testid="notional-value">
            {notional !== null ? `${formatAmount(notional)} ${market.quote}` : '–'}
          </span>
        </div>
        <div className="summary-row">
          <span className="dim">수수료</span>
          <span data-testid="fee-value">{fee !== null ? `${formatAmount(fee)} ${market.quote}` : '–'}</span>
        </div>
        {isPerp && (
          <div className="summary-row">
            <span className="dim">필요 증거금</span>
            <span data-testid="margin-value">{margin !== null ? `${formatAmount(margin)} USDC` : '–'}</span>
          </div>
        )}
      </div>

      <button
        type="button"
        className={`submit-btn ${side}`}
        disabled={submitting}
        onClick={() => {
          void submit();
        }}
      >
        {side === 'buy' ? '매수' : '매도'} {market.base}
      </button>
    </div>
  );
}
