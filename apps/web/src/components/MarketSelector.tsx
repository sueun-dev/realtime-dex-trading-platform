import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Market } from '../lib/api.js';
import { formatPct, formatPrice } from '../lib/format.js';
import { useMarketStore } from '../stores/market.js';

type FilterTab = 'all' | 'spot' | 'perp';

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'spot', label: 'USDC' },
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
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Element focused before the modal opened, so we can restore focus on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Remember the trigger (market button) when the modal opens.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  const filtered = useMemo(
    () => markets.filter((m) => (tab === 'all' || m.type === tab) && matches(m, query)),
    [markets, tab, query],
  );

  if (!open) return null;

  const close = (): void => {
    setOpen(false);
    // Restore focus to the trigger (market button) for keyboard users.
    restoreFocusRef.current?.focus?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Trap Tab within the modal.
    const root = modalRef.current;
    if (root === null) return;
    const focusable = root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-overlay" data-testid="market-selector" onClick={close}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="마켓 선택"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <input
            type="text"
            autoFocus
            placeholder="코인 검색 (비트코인, BTC…)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="close-btn dim" aria-label="닫기" onClick={close}>
            ✕
          </button>
        </div>
        <div className="tabs" role="group" aria-label="마켓 필터">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
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
                      {m.type === 'perp' ? 'PERP' : 'USDC'}
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
