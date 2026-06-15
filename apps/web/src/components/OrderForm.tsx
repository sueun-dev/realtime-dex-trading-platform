import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { divRound, feeOn, fromUnits, mulDiv, mulUnits, roundToLot, roundToTick, toUnits } from '@dex/shared';
import type { OrderType, Side, TimeInForce } from '@dex/shared';
import { api, koMessage } from '../lib/api.js';
import type { PlaceOrderBody } from '../lib/api.js';
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
  const [submitting, setSubmitting] = useState(false);
  const leverageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const marketId = market?.id;
  useEffect(() => {
    setQtyStr('');
    setPriceStr('');
    setLeverage(1);
    setReduceOnly(false);
    setPostOnly(false);
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

    let price: bigint;
    let tif: TimeInForce;
    if (type === 'limit') {
      if (limitPrice === null || limitPrice <= 0n) {
        toast.error('가격을 입력해주세요');
        return;
      }
      price = limitPrice;
      tif = 'GTC';
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
      price: fromUnits(price),
      qty: fromUnits(qty),
      tif,
    };
    if (type === 'limit' && !isPerp) body.postOnly = postOnly;
    if (isPerp) body.reduceOnly = reduceOnly;

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
