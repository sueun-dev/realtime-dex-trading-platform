import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dispose, init, type Chart, type KLineData } from 'klinecharts';
import { SCALE, type CandleInterval } from '@dex/shared';
import { api } from '../lib/api.js';
import { useMarketStore } from '../stores/market.js';

const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

/** Main-pane overlay indicators (drawn on the candles) the user can toggle. */
const OVERLAYS = ['MA', 'EMA', 'BOLL'] as const;
/** Sub-pane indicators (their own row below the candles). */
const SUBS = ['VOL', 'MACD', 'RSI', 'KDJ'] as const;
type Overlay = (typeof OVERLAYS)[number];
type Sub = (typeof SUBS)[number];

const NUM = Number(SCALE); // 1e8 — scale bigint price/qty units back to human values

export function ChartPanel() {
  const marketId = useMarketStore((s) => s.selectedId);
  const [interval, setIntervalValue] = useState<CandleInterval>('15m');
  const [overlay, setOverlay] = useState<Overlay>('MA');
  const [sub, setSub] = useState<Sub>('VOL');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  const overlayPaneRef = useRef<string | null>(null);
  const subPaneRef = useRef<string | null>(null);

  const { data } = useQuery({
    queryKey: ['candles', marketId, interval],
    queryFn: () => api.candles(marketId, interval, 300),
    refetchInterval: 5000,
  });

  // ---- chart lifecycle (init once) ----
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const chart = init(el, {
      styles: {
        grid: { horizontal: { color: '#151c24' }, vertical: { color: '#151c24' } },
        candle: {
          bar: {
            upColor: '#1fa67d',
            downColor: '#ed7088',
            upBorderColor: '#50d2c1',
            downBorderColor: '#ed7088',
            upWickColor: '#50d2c1',
            downWickColor: '#ed7088',
          },
          priceMark: {
            high: { color: '#949e9c' },
            low: { color: '#949e9c' },
            last: { text: { color: '#06090c' } },
          },
          tooltip: { rect: { color: '#10151b', borderColor: '#1c242e' } },
        },
        xAxis: { axisLine: { color: '#1c242e' }, tickText: { color: '#949e9c' } },
        yAxis: { axisLine: { color: '#1c242e' }, tickText: { color: '#949e9c' } },
        crosshair: {
          horizontal: { line: { color: '#50d2c1' }, text: { backgroundColor: '#1fa67d' } },
          vertical: { line: { color: '#50d2c1' }, text: { backgroundColor: '#1fa67d' } },
        },
      },
    });
    chartRef.current = chart ?? null;
    return () => {
      dispose(el);
      chartRef.current = null;
      overlayPaneRef.current = null;
      subPaneRef.current = null;
    };
  }, []);

  // ---- indicator selection (klinecharts v9: removeIndicator(paneId, name?)) ----
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    if (overlayPaneRef.current !== null) chart.removeIndicator('candle_pane', overlayPaneRef.current);
    // overlay indicators share the main candle pane
    chart.createIndicator(overlay, true, { id: 'candle_pane' });
    overlayPaneRef.current = overlay;
  }, [overlay]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    if (subPaneRef.current !== null) chart.removeIndicator(subPaneRef.current);
    const paneId = chart.createIndicator(sub, false);
    subPaneRef.current = typeof paneId === 'string' ? paneId : null;
  }, [sub]);

  // ---- data ----
  const klines = useMemo<KLineData[]>(() => {
    if (data === undefined) return [];
    return [...data]
      .sort((a, b) => a.t - b.t)
      .filter((c, i, arr) => i === 0 || c.t !== arr[i - 1]!.t)
      .map((c) => ({
        timestamp: c.t,
        open: Number(c.o) / NUM,
        high: Number(c.h) / NUM,
        low: Number(c.l) / NUM,
        close: Number(c.c) / NUM,
        volume: Number(c.v) / NUM,
      }));
  }, [data]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || klines.length === 0) return;
    chart.applyNewData(klines); // klinecharts preserves zoom/pan across applyNewData
  }, [klines]);

  return (
    <div className="chart-panel">
      <div className="chart-toolbar">
        <div className="tabs chart-tabs" role="tablist" aria-label="차트 간격">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              role="tab"
              aria-selected={interval === iv}
              className={`tab ${interval === iv ? 'active' : ''}`}
              onClick={() => setIntervalValue(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
        <div className="chart-indicators">
          <select
            aria-label="보조지표 (메인)"
            className="ind-select"
            value={overlay}
            onChange={(e) => setOverlay(e.target.value as Overlay)}
          >
            {OVERLAYS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <select
            aria-label="보조지표 (하단)"
            className="ind-select"
            value={sub}
            onChange={(e) => setSub(e.target.value as Sub)}
          >
            {SUBS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="chart-container" ref={containerRef} data-testid="chart" />
    </div>
  );
}
