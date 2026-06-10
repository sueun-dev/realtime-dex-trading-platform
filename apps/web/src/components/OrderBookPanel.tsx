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
  const setPriceStr = useOrderFormStore((s) => s.setPriceStr);

  return (
    <div className="book-panel">
      <div className="tabs">
        <button type="button" className={`tab ${tab === 'book' ? 'active' : ''}`} onClick={() => setTab('book')}>
          호가
        </button>
        <button type="button" className={`tab ${tab === 'trades' ? 'active' : ''}`} onClick={() => setTab('trades')}>
          체결
        </button>
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
