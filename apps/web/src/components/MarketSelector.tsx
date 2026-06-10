import { useMemo, useState } from 'react';
import type { Market } from '../lib/api.js';
import { formatPct, formatPrice } from '../lib/format.js';
import { useMarketStore } from '../stores/market.js';

type FilterTab = 'all' | 'spot' | 'perp';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'spot', label: 'KRW' },
  { key: 'perp', label: 'PERP' },
];

function matches(market: Market, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  return (
    market.base.toLowerCase().includes(q) ||
    market.id.toLowerCase().includes(q) ||
    (market.koreanName ?? '').toLowerCase().includes(q) ||
    (market.englishName ?? '').toLowerCase().includes(q)
  );
}

export function MarketSelector() {
  const open = useMarketStore((s) => s.selectorOpen);
  const setOpen = useMarketStore((s) => s.setSelectorOpen);
  const markets = useMarketStore((s) => s.markets);
  const tickers = useMarketStore((s) => s.tickers);
  const selectMarket = useMarketStore((s) => s.selectMarket);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<FilterTab>('all');

  const filtered = useMemo(
    () => markets.filter((m) => (tab === 'all' || m.type === tab) && matches(m, query)),
    [markets, tab, query],
  );

  if (!open) return null;

  return (
    <div className="modal-overlay" data-testid="market-selector" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <input
            type="text"
            autoFocus
            placeholder="코인 검색 (비트코인, BTC…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="close-btn dim" aria-label="닫기" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="market-list">
          {filtered.length === 0 ? (
            <div className="empty dim">검색 결과가 없습니다</div>
          ) : (
            filtered.map((m) => {
              const ticker = tickers[m.id];
              const cls =
                ticker === undefined ? '' : ticker.change24h > 0n ? 'pos' : ticker.change24h < 0n ? 'neg' : '';
              return (
                <button
                  key={m.id}
                  type="button"
                  className="market-row"
                  data-testid="market-row"
                  onClick={() => selectMarket(m.id)}
                >
                  <span className="market-row-symbol">
                    {m.base}/{m.quote}
                    <span className={`badge mini ${m.type === 'perp' ? 'perp' : 'spot'}`}>
                      {m.type === 'perp' ? 'PERP' : 'KRW'}
                    </span>
                  </span>
                  <span className="dim market-row-name">{m.koreanName ?? m.englishName ?? ''}</span>
                  <span className="market-row-price">
                    {ticker !== undefined ? formatPrice(ticker.price, m.tickSize) : '–'}
                  </span>
                  <span className={`market-row-change ${cls}`}>
                    {ticker !== undefined ? formatPct(ticker.change24h) : ''}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
