import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CandlestickSeries, ColorType, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { CandleInterval } from '@dex/shared';
import { api } from '../lib/api.js';
import { useMarketStore } from '../stores/market.js';

const INTERVALS: CandleInterval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

const COLORS = {
  up: '#1fa67d',
  upBright: '#50d2c1',
  down: '#ed7088',
  text: '#949e9c',
  grid: '#151c24',
  border: '#1c242e',
};

export function ChartPanel() {
  const marketId = useMarketStore((s) => s.selectedId);
  const [interval, setIntervalValue] = useState<CandleInterval>('15m');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const fittedKeyRef = useRef('');

  const { data } = useQuery({
    queryKey: ['candles', marketId, interval],
    queryFn: () => api.candles(marketId, interval, 200),
    refetchInterval: 5000,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: COLORS.text,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      rightPriceScale: { borderColor: COLORS.border },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    // lightweight-charts v5 API: addSeries(CandlestickSeries, opts)
    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.upBright,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.upBright,
      wickDownColor: COLORS.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      chart.applyOptions({
        width: Math.max(0, Math.floor(entry.contentRect.width)),
        height: Math.max(0, Math.floor(entry.contentRect.height)),
      });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (series === null || chart === null || data === undefined) return;
    const sorted = [...data].sort((a, b) => a.t - b.t).filter((c, i, arr) => i === 0 || c.t !== arr[i - 1]!.t);
    // chart rendering is display-only: Number() conversion is allowed here
    series.setData(
      sorted.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
      })),
    );
    const key = `${marketId}:${interval}`;
    if (fittedKeyRef.current !== key) {
      fittedKeyRef.current = key;
      chart.timeScale().fitContent();
    }
  }, [data, marketId, interval]);

  return (
    <div className="chart-panel">
      <div className="tabs chart-tabs">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            type="button"
            className={`tab ${interval === iv ? 'active' : ''}`}
            onClick={() => setIntervalValue(iv)}
          >
            {iv}
          </button>
        ))}
      </div>
      <div className="chart-container" ref={containerRef} />
    </div>
  );
}
