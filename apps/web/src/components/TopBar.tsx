import { useEffect, useRef, useState } from 'react';
import { koMessage } from '../lib/api.js';
import { useAuthStore } from '../lib/auth.js';
import { getWs } from '../lib/ws.js';
import type { WsStatus } from '../lib/ws.js';
import { formatAmount, formatPct, formatPrice, truncateAddress } from '../lib/format.js';
import { useMarketStore } from '../stores/market.js';
import { toast } from '../stores/toast.js';

const WS_LABEL: Record<WsStatus, string> = {
  open: 'LIVE',
  connecting: '재연결 중…',
  closed: '연결 끊김',
};

/** A 1e8 hourly funding rate as a signed percent with 4 decimals (e.g. +0.0100%). */
function fundingPctStr(rate: bigint): string {
  const tenKths = rate / 100n; // rate/1e8 × 100% × 10000
  const neg = tenKths < 0n;
  const abs = neg ? -tenKths : tenKths;
  const frac = (abs % 10_000n).toString().padStart(4, '0');
  return `${neg ? '-' : '+'}${abs / 10_000n}.${frac}%`;
}

/** Remaining time to the next funding as mm:ss (clamped at 0). */
function countdownStr(nextTs: number, now: number): string {
  const secs = Math.max(0, Math.floor((nextTs - now) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function TopBar() {
  const market = useMarketStore((s) => s.byId[s.selectedId]);
  const ticker = useMarketStore((s) => s.tickers[s.selectedId]);
  const funding = useMarketStore((s) => s.funding[s.selectedId]);
  const setSelectorOpen = useMarketStore((s) => s.setSelectorOpen);
  const address = useAuthStore((s) => s.address);
  const login = useAuthStore((s) => s.login);
  const [connecting, setConnecting] = useState(false);
  const [wsStatus, setWsStatus] = useState<WsStatus>(() => getWs().status);
  const isPerp = market?.type === 'perp';

  // tick once a second so the funding countdown stays live (perp markets only)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isPerp || funding === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isPerp, funding]);

  useEffect(() => {
    const ws = getWs();
    setWsStatus(ws.status);
    return ws.onStatus(setWsStatus);
  }, []);

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
              {formatAmount(ticker.volume24h)} {market.quote}
            </span>
          </div>
          {isPerp && funding !== undefined && (
            <div className="stat" data-testid="funding-stat">
              <span className="dim">펀딩 / 정산까지</span>
              <span>
                <span
                  className={funding.rate > 0n ? 'neg' : funding.rate < 0n ? 'pos' : 'dim'}
                  data-testid="funding-rate"
                >
                  {fundingPctStr(funding.rate)}
                </span>
                <span className="dim"> / {countdownStr(funding.nextFundingTs, now)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      <span className={`badge ${market?.type === 'perp' ? 'perp' : 'spot'}`}>
        {market?.type === 'perp' ? 'PERP' : 'USDC'}
      </span>

      <span
        className={`ws-status ${wsStatus === 'open' ? 'live' : 'down'}`}
        data-testid="ws-status"
        role="status"
        aria-label={`연결 상태: ${WS_LABEL[wsStatus]}`}
        title={WS_LABEL[wsStatus]}
      >
        <span className="ws-dot" aria-hidden="true" />
        {WS_LABEL[wsStatus]}
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
