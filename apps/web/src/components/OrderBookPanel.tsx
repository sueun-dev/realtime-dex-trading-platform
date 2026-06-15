import { useState } from 'react';
import { fromUnits } from '@dex/shared';
import { OrderBook } from './OrderBook.js';
import { RecentTrades } from './RecentTrades.js';
import { useBookStore } from '../stores/book.js';
import { useMarketStore } from '../stores/market.js';
import { useOrderFormStore } from '../stores/orderform.js';

export function OrderBookPanel() {
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  const market = useMarketStore((s) => s.byId[s.selectedId]);
  const bids = useBookStore((s) => s.bids);
  const asks = useBookStore((s) => s.asks);
  const stale = useBookStore((s) => s.stale);
  const setPriceStr = useOrderFormStore((s) => s.setPriceStr);

  const showStale = tab === 'book' && stale;

  return (
    <div className={`book-panel${showStale ? ' stale' : ''}`}>
      <div className="tabs" role="tablist" aria-label="호가/체결">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'book'}
          className={`tab ${tab === 'book' ? 'active' : ''}`}
          onClick={() => setTab('book')}
        >
          호가
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'trades'}
          className={`tab ${tab === 'trades' ? 'active' : ''}`}
          onClick={() => setTab('trades')}
        >
          체결
        </button>
        {showStale && (
          <span className="stale-badge" data-testid="orderbook-stale" role="status" title="데이터가 지연되고 있습니다">
            데이터 지연
          </span>
        )}
      </div>
      {tab === 'book' ? (
        <OrderBook
          tickSize={market?.tickSize ?? 1n}
          bids={bids}
          asks={asks}
          onPriceClick={(price) => setPriceStr(fromUnits(price))}
        />
      ) : (
        <RecentTrades />
      )}
    </div>
  );
}
