import { divUnits } from '@dex/shared';
import { formatPct, formatPrice, formatQty } from '../lib/format.js';
import type { Level } from '../stores/book.js';

export interface OrderBookProps {
  tickSize: bigint;
  bids: Level[];
  asks: Level[];
  onPriceClick?: (price: bigint) => void;
  depth?: number;
}

interface RowData {
  price: bigint;
  qty: bigint;
  cum: bigint;
}

function withCumulative(levels: Level[]): RowData[] {
  let cum = 0n;
  return levels.map((l) => {
    cum += l.qty;
    return { price: l.price, qty: l.qty, cum };
  });
}

/** Depth-bar width in % with 2dp — display-only number math. */
function barWidth(cum: bigint, max: bigint): string {
  if (max <= 0n) return '0%';
  const bps = Number((cum * 10_000n) / max); // 0..10000, small & safe
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Presentational orderbook: asks (red, ascending away from spread) on top with
 * the best ask adjacent to the spread row, bids (green) below, cumulative
 * depth bars, click-to-fill price.
 */
export function OrderBook({ tickSize, bids, asks, onPriceClick, depth = 12 }: OrderBookProps) {
  const askRows = withCumulative(asks.slice(0, depth));
  const bidRows = withCumulative(bids.slice(0, depth));
  const maxAskCum = askRows.length > 0 ? askRows[askRows.length - 1]!.cum : 0n;
  const maxBidCum = bidRows.length > 0 ? bidRows[bidRows.length - 1]!.cum : 0n;
  const maxCum = maxAskCum > maxBidCum ? maxAskCum : maxBidCum;

  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : null;
  const spreadRate = spread !== null && bestAsk !== undefined && bestAsk > 0n ? divUnits(spread, bestAsk) : null;

  const renderRow = (row: RowData, side: 'ask' | 'bid', index: number) => (
    <button
      key={`${side}-${row.price.toString()}`}
      type="button"
      className={`ob-row ${side}`}
      data-testid={`${side}-row-${index}`}
      onClick={() => onPriceClick?.(row.price)}
    >
      <span
        className={`ob-bar ${side}`}
        data-testid={`${side}-bar-${index}`}
        style={{ width: barWidth(row.cum, maxCum) }}
      />
      <span className={`ob-price ${side === 'ask' ? 'neg' : 'pos'}`}>{formatPrice(row.price, tickSize)}</span>
      <span className="ob-qty">{formatQty(row.qty)}</span>
      <span className="ob-cum">{formatQty(row.cum)}</span>
    </button>
  );

  return (
    <div className="ob" data-testid="orderbook">
      <div className="ob-head">
        <span>가격</span>
        <span>수량</span>
        <span>누적</span>
      </div>
      <div className="ob-side ob-asks">
        {/* render reversed: worst ask at the top, best ask adjacent to the spread row */}
        {[...askRows].reverse().map((row, i) => renderRow(row, 'ask', askRows.length - 1 - i))}
      </div>
      <div className="ob-spread" data-testid="spread">
        <span className="dim">스프레드</span>
        <span>{spread !== null ? formatPrice(spread, tickSize) : '–'}</span>
        <span className="dim">{spreadRate !== null ? formatPct(spreadRate, false) : ''}</span>
      </div>
      <div className="ob-side ob-bids">{bidRows.map((row, i) => renderRow(row, 'bid', i))}</div>
    </div>
  );
}
