import { useEffect, useRef, useState } from 'react';
import { koMessage } from '../lib/api.js';
import { useAuthStore } from '../lib/auth.js';
import { getWs } from '../lib/ws.js';
import { formatKRW, formatPct, formatPrice, truncateAddress } from '../lib/format.js';
import { useMarketStore } from '../stores/market.js';
import { toast } from '../stores/toast.js';

export function TopBar() {
  const market = useMarketStore((s) => s.byId[s.selectedId]);
  const ticker = useMarketStore((s) => s.tickers[s.selectedId]);
  const setSelectorOpen = useMarketStore((s) => s.setSelectorOpen);
  const address = useAuthStore((s) => s.address);
  const login = useAuthStore((s) => s.login);
  const [connecting, setConnecting] = useState(false);

  const changeCls = ticker === undefined ? '' : ticker.change24h > 0n ? 'pos' : ticker.change24h < 0n ? 'neg' : '';

  // flash the price green/red on every tick
  const prevPrice = useRef<bigint | null>(null);
  const [tickCls, setTickCls] = useState('');
  useEffect(() => {
    if (ticker === undefined) return;
    const prev = prevPrice.current;
    prevPrice.current = ticker.price;
    if (prev !== null && ticker.price !== prev) {
      setTickCls(ticker.price > prev ? 'tick-up' : 'tick-down');
    }
  }, [ticker]);

  const onWallet = async (): Promise<void> => {
    if (address !== null) return;
    setConnecting(true);
    try {
      const token = await login();
      getWs().auth(token);
      toast.success('지갑이 연결되었습니다');
    } catch (e) {
      toast.error(koMessage(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <header className="topbar">
      <div className="logo accent">DEX</div>

      <button type="button" className="market-btn" onClick={() => setSelectorOpen(true)} data-testid="market-button">
        <span className="market-pair">
          {market !== undefined ? `${market.base}/${market.quote}` : '—'}
          <span className="dim market-korean">{market?.koreanName ?? ''}</span>
        </span>
        {market !== undefined && ticker !== undefined && (
          <>
            <span key={ticker.ts} className={`market-price ${changeCls} ${tickCls}`}>
              {formatPrice(ticker.price, market.tickSize)}
            </span>
            <span className={`market-change ${changeCls}`}>{formatPct(ticker.change24h)}</span>
          </>
        )}
        <span className="caret dim">▾</span>
      </button>

      {market !== undefined && ticker !== undefined && (
        <div className="stats-strip">
          <div className="stat">
            <span className="dim">24h 고가</span>
            <span>{formatPrice(ticker.high24h, market.tickSize)}</span>
          </div>
          <div className="stat">
            <span className="dim">24h 저가</span>
            <span>{formatPrice(ticker.low24h, market.tickSize)}</span>
          </div>
          <div className="stat">
            <span className="dim">24h 거래대금</span>
            <span>
              {formatKRW(ticker.volume24h)} {market.quote}
            </span>
          </div>
        </div>
      )}

      <span className={`badge ${market?.type === 'perp' ? 'perp' : 'spot'}`}>
        {market?.type === 'perp' ? 'PERP' : 'KRW'}
      </span>

      <button
        type="button"
        className={`wallet-btn ${address !== null ? 'connected' : ''}`}
        disabled={connecting}
        onClick={() => {
          void onWallet();
        }}
      >
        {address !== null ? truncateAddress(address) : connecting ? '연결 중…' : '지갑 연결'}
      </button>
    </header>
  );
}
