import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { absBig, divUnits, fromUnits, mulDiv, mulUnits, roundToTick } from '@dex/shared';
import { api, koMessage } from '../lib/api.js';
import type { PlaceOrderBody } from '../lib/api.js';
import { formatAmount, formatPct, formatPrice, formatQty, formatTime } from '../lib/format.js';
import { useMarketStore } from '../stores/market.js';
import { useUserStore } from '../stores/user.js';
import { toast } from '../stores/toast.js';

type BottomTab = 'positions' | 'orders' | 'fills' | 'balances';

export function PositionsTable() {
  const positions = useUserStore((s) => s.positions);
  const byId = useMarketStore((s) => s.byId);
  const tickers = useMarketStore((s) => s.tickers);
  const queryClient = useQueryClient();

  const closePosition = async (marketId: string, size: bigint, mark: bigint, tickSize: bigint): Promise<void> => {
    const side = size > 0n ? 'sell' : 'buy';
    const raw = side === 'buy' ? mulDiv(mark, 105n, 100n) : mulDiv(mark, 95n, 100n);
    const bound = roundToTick(raw, tickSize, side === 'buy' ? 'ceil' : 'floor');
    const body: PlaceOrderBody = {
      marketId,
      side,
      type: 'market',
      price: fromUnits(bound),
      qty: fromUnits(absBig(size)),
      tif: 'IOC',
      reduceOnly: true,
    };
    try {
      await api.placeOrder(body);
      toast.success('포지션 종료 주문이 접수되었습니다');
      await queryClient.invalidateQueries({ queryKey: ['account'] });
    } catch (e) {
      toast.error(koMessage(e));
    }
  };

  if (positions.length === 0) return <div className="empty dim">보유 포지션이 없습니다</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>마켓</th>
          <th>방향</th>
          <th>크기</th>
          <th>진입가</th>
          <th>청산가</th>
          <th>마크</th>
          <th>미실현 손익</th>
          <th>증거금</th>
          <th>레버리지</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const market = byId[p.marketId];
          const tickSize = market?.tickSize ?? 1n;
          // Only a real ticker price is a valid mark. When the feed is missing,
          // do NOT substitute entryPrice — that fabricates a +0 / 0.00% PnL.
          const mark = tickers[p.marketId]?.price ?? null;
          const uPnl = mark !== null ? mulUnits(p.size, mark - p.entryPrice) : null;
          const roe = mark !== null && p.margin > 0n ? divUnits(uPnl ?? 0n, p.margin) : 0n;
          const cls = uPnl === null ? '' : uPnl > 0n ? 'pos' : uPnl < 0n ? 'neg' : '';
          const long = p.size > 0n;
          return (
            <tr key={p.marketId}>
              <td>{p.marketId}</td>
              <td>
                <span className={`badge mini ${long ? 'long' : 'short'}`}>{long ? '롱' : '숏'}</span>
              </td>
              <td>{formatQty(absBig(p.size))}</td>
              <td>{formatPrice(p.entryPrice, tickSize)}</td>
              <td>
                {p.liquidationPrice !== null ? (
                  <span className="neg" data-testid={`liq-${p.marketId}`}>
                    {formatPrice(p.liquidationPrice, tickSize)}
                  </span>
                ) : (
                  <span className="dim" data-testid={`liq-${p.marketId}`}>
                    —
                  </span>
                )}
              </td>
              <td>{mark !== null ? formatPrice(mark, tickSize) : <span className="dim">—</span>}</td>
              <td>
                {uPnl !== null ? (
                  <span className={`pnl ${cls}`} data-testid={`pnl-${p.marketId}`}>
                    {uPnl > 0n ? '+' : ''}
                    {formatAmount(uPnl)} ({formatPct(roe)})
                  </span>
                ) : (
                  <span className="pnl dim" data-testid={`pnl-${p.marketId}`}>
                    —
                  </span>
                )}
              </td>
              <td>{formatAmount(p.margin)}</td>
              <td>{p.leverage}x</td>
              <td>
                <button
                  type="button"
                  className="small-btn danger"
                  disabled={mark === null}
                  onClick={() => {
                    if (mark === null) return;
                    void closePosition(p.marketId, p.size, mark, tickSize);
                  }}
                >
                  시장가 종료
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface EditState {
  id: string;
  price: string;
  qty: string;
}

export function OpenOrdersTable() {
  const orders = useUserStore((s) => s.openOrders);
  const byId = useMarketStore((s) => s.byId);
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<EditState | null>(null);

  const refresh = (): Promise<unknown> =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['account'] }),
    ]);

  const cancel = async (orderId: string): Promise<void> => {
    try {
      await api.cancelOrder(orderId);
      toast.success('주문이 취소되었습니다');
      await refresh();
    } catch (e) {
      toast.error(koMessage(e));
    }
  };

  const submitEdit = async (): Promise<void> => {
    if (edit === null) return;
    try {
      await api.amendOrder(edit.id, { price: edit.price, qty: edit.qty });
      setEdit(null);
      toast.success('주문이 수정되었습니다');
      await refresh();
    } catch (e) {
      toast.error(koMessage(e));
    }
  };

  if (orders.length === 0) return <div className="empty dim">미체결 주문이 없습니다</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>시간</th>
          <th>마켓</th>
          <th>방향</th>
          <th>유형</th>
          <th>가격</th>
          <th>수량</th>
          <th>체결</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const tickSize = byId[o.marketId]?.tickSize ?? 1n;
          const trigger = o.trigger;
          const editing = edit?.id === o.id;
          // only a plain resting limit order (no trigger) can be amended in place
          const amendable = o.type === 'limit' && trigger === null && o.price !== null;
          return (
            <tr key={o.id}>
              <td className="dim">{formatTime(o.ts)}</td>
              <td>{o.marketId}</td>
              <td className={o.side === 'buy' ? 'pos' : 'neg'}>{o.side === 'buy' ? '매수' : '매도'}</td>
              <td>
                {o.type === 'limit' ? '지정가' : '시장가'}
                {trigger !== null && (
                  <span className="badge mini trigger" data-testid={`trigger-badge-${o.id}`}>
                    트리거
                  </span>
                )}
              </td>
              <td>
                {editing ? (
                  <input
                    className="inline-edit"
                    aria-label="주문 가격 수정"
                    value={edit.price}
                    onChange={(e) => {
                      setEdit({ ...edit, price: e.target.value });
                    }}
                  />
                ) : trigger !== null ? (
                  <span className="trigger-cond" data-testid={`trigger-cond-${o.id}`}>
                    {trigger.direction === 'above' ? '≥' : '≤'} {formatPrice(trigger.price, tickSize)}
                  </span>
                ) : o.price !== null ? (
                  formatPrice(o.price, tickSize)
                ) : (
                  '시장가'
                )}
              </td>
              <td>
                {editing ? (
                  <input
                    className="inline-edit"
                    aria-label="주문 수량 수정"
                    value={edit.qty}
                    onChange={(e) => {
                      setEdit({ ...edit, qty: e.target.value });
                    }}
                  />
                ) : (
                  formatQty(o.qty)
                )}
              </td>
              <td>{formatQty(o.filledQty)}</td>
              <td className="order-actions">
                {editing ? (
                  <>
                    <button
                      type="button"
                      className="small-btn primary"
                      onClick={() => {
                        void submitEdit();
                      }}
                    >
                      확인
                    </button>
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        setEdit(null);
                      }}
                    >
                      되돌리기
                    </button>
                  </>
                ) : (
                  <>
                    {amendable && (
                      <button
                        type="button"
                        className="small-btn"
                        data-testid={`amend-${o.id}`}
                        onClick={() => {
                          setEdit({ id: o.id, price: fromUnits(o.price as bigint), qty: fromUnits(o.qty) });
                        }}
                      >
                        수정
                      </button>
                    )}
                    <button
                      type="button"
                      className="small-btn"
                      onClick={() => {
                        void cancel(o.id);
                      }}
                    >
                      취소
                    </button>
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function FillsTable() {
  const fills = useUserStore((s) => s.fills);
  const byId = useMarketStore((s) => s.byId);

  if (fills.length === 0) return <div className="empty dim">체결 내역이 없습니다</div>;

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>시간</th>
          <th>마켓</th>
          <th>방향</th>
          <th>가격</th>
          <th>수량</th>
          <th>수수료</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const tickSize = byId[f.marketId]?.tickSize ?? 1n;
          return (
            <tr key={f.id}>
              <td className="dim">{formatTime(f.ts)}</td>
              <td>{f.marketId}</td>
              <td className={f.side === 'buy' ? 'pos' : f.side === 'sell' ? 'neg' : ''}>
                {f.side === 'buy' ? '매수' : f.side === 'sell' ? '매도' : '–'}
              </td>
              <td>{formatPrice(f.price, tickSize)}</td>
              <td>{formatQty(f.qty)}</td>
              <td>{f.fee !== null ? formatAmount(f.fee) : '–'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function BalancesTable() {
  const balances = useUserStore((s) => s.balances);
  const queryClient = useQueryClient();
  const [claiming, setClaiming] = useState(false);

  const claimFaucet = async (): Promise<void> => {
    setClaiming(true);
    try {
      await api.faucet();
      toast.success('테스트 자금이 지급되었습니다');
      await queryClient.invalidateQueries({ queryKey: ['account'] });
    } catch (e) {
      toast.error(koMessage(e));
    } finally {
      setClaiming(false);
    }
  };

  const entries = Object.entries(balances);

  return (
    <div className="balances">
      <div className="balances-actions">
        <button
          type="button"
          className="small-btn accent-btn"
          disabled={claiming}
          onClick={() => {
            void claimFaucet();
          }}
        >
          테스트 자금 받기
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="empty dim">잔고가 없습니다. 테스트 자금을 받아보세요.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>자산</th>
              <th>사용 가능</th>
              <th>주문 중</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([asset, b]) => (
              <tr key={asset}>
                <td>{asset}</td>
                <td>{formatAmount(b.available)}</td>
                <td>{formatAmount(b.locked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function BottomPanel() {
  const [tab, setTab] = useState<BottomTab>('positions');
  const positions = useUserStore((s) => s.positions);
  const orders = useUserStore((s) => s.openOrders);

  const tabs: { key: BottomTab; label: string }[] = [
    { key: 'positions', label: `포지션 (${positions.length})` },
    { key: 'orders', label: `미체결 주문 (${orders.length})` },
    { key: 'fills', label: '체결 내역' },
    { key: 'balances', label: '잔고' },
  ];

  return (
    <div className="bottom-panel">
      <div className="tabs" role="tablist" aria-label="계정 정보">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? 'active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="bottom-body">
        {tab === 'positions' && <PositionsTable />}
        {tab === 'orders' && <OpenOrdersTable />}
        {tab === 'fills' && <FillsTable />}
        {tab === 'balances' && <BalancesTable />}
      </div>
    </div>
  );
}
