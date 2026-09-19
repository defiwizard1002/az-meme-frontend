import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from './types';

interface Props {
  candles: Candle[];
  symbol: string;
  refreshing?: boolean;
  onLoadBefore?: (before: number) => Promise<number>;
}

function pricePrecision(candles: Candle[]): { precision: number; minMove: number } {
  const last = Number(candles.at(-1)?.c ?? 0);
  if (last >= 100) return { precision: 2, minMove: 0.01 };
  if (last >= 1) return { precision: 4, minMove: 0.0001 };
  if (last >= 0.01) return { precision: 6, minMove: 0.000001 };
  return { precision: 8, minMove: 0.00000001 };
}

export function linkCandleOpens(candles: Candle[]): Candle[] {
  let previousClose: string | undefined;
  return candles.map((candle) => {
    if (previousClose === undefined) {
      previousClose = candle.c;
      return candle;
    }
    const open = previousClose;
    const linked = {
      ...candle,
      o: open,
      h: Number(candle.h) >= Number(open) ? candle.h : open,
      l: Number(candle.l) <= Number(open) ? candle.l : open,
    };
    previousClose = candle.c;
    return linked;
  });
}

export function CandleChart({ candles, symbol, refreshing = false, onLoadBefore }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const firstTimeRef = useRef<number | null>(null);
  const previousLengthRef = useRef(0);
  const candlesRef = useRef(candles);
  const loadBeforeRef = useRef(onLoadBefore);
  const loadingBeforeRef = useRef(false);
  const interactedRef = useRef(false);
  const requestedBeforeRef = useRef<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => { candlesRef.current = candles; }, [candles]);
  useEffect(() => { loadBeforeRef.current = onLoadBefore; }, [onLoadBefore]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight || 360,
      layout: {
        background: { type: ColorType.Solid, color: '#09080d' },
        textColor: '#777481',
        fontFamily: 'Geist Mono, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: '#18161f' },
        horzLines: { color: '#18161f' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: '#282531',
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: '#282531',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
        barSpacing: 8,
        minBarSpacing: 2,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#39d98a',
      downColor: '#ff4d79',
      borderVisible: false,
      wickUpColor: '#39d98a',
      wickDownColor: '#ff4d79',
      priceFormat: { type: 'price', ...pricePrecision(candles) },
    });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    const markInteraction = () => { interactedRef.current = true; };
    const handleVisibleRange = (range: { from: number; to: number } | null) => {
      if (!range || range.from >= 8 || !interactedRef.current || loadingBeforeRef.current || !loadBeforeRef.current) return;
      const before = (candlesRef.current[0]?.t ?? 0) - 1;
      if (before <= 0 || requestedBeforeRef.current === before) return;
      requestedBeforeRef.current = before;
      loadingBeforeRef.current = true;
      setHistoryLoading(true);
      void loadBeforeRef.current(before)
        .then((loaded) => {
          if (loaded === 0) requestedBeforeRef.current = null;
        })
        .catch(() => {
          requestedBeforeRef.current = null;
        })
        .finally(() => {
          loadingBeforeRef.current = false;
          setHistoryLoading(false);
        });
    };
    container.addEventListener('pointerdown', markInteraction);
    container.addEventListener('wheel', markInteraction, { passive: true });
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);

    const resizeObserver = new ResizeObserver((entries) => {
      const size = entries[0]?.contentRect;
      if (!size) return;
      chart.applyOptions({ width: size.width, height: size.height });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('pointerdown', markInteraction);
      container.removeEventListener('wheel', markInteraction);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      lastTimeRef.current = null;
      firstTimeRef.current = null;
      previousLengthRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;
    const linkedCandles = linkCandleOpens(candles);
    if (linkedCandles.length === 0) {
      candleSeries.setData([]);
      volumeSeries.setData([]);
      firstTimeRef.current = null;
      lastTimeRef.current = null;
      previousLengthRef.current = 0;
      return;
    }

    const toCandle = (item: Candle) => ({
      time: item.t as UTCTimestamp,
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
    });
    const toVolume = (item: Candle) => ({
      time: item.t as UTCTimestamp,
      value: Number(item.quoteVolume),
      color: Number(item.c) >= Number(item.o) ? '#39d98a55' : '#ff4d7955',
    });

    const volumeCandles = linkedCandles.filter((item) => item.quoteVolume !== null);
    const firstTime = linkedCandles[0]!.t;
    const prepended = firstTimeRef.current !== null && firstTime < firstTimeRef.current;
    const reset = lastTimeRef.current === null
      || linkedCandles.length < previousLengthRef.current
      || firstTime > lastTimeRef.current
      || prepended;
    if (reset) {
      const visibleRange = chart.timeScale().getVisibleLogicalRange();
      const added = Math.max(linkedCandles.length - previousLengthRef.current, 0);
      candleSeries.setData(linkedCandles.map(toCandle));
      volumeSeries.setData(volumeCandles.map(toVolume));
      if (prepended && visibleRange && added > 0) {
        chart.timeScale().setVisibleLogicalRange({ from: visibleRange.from + added, to: visibleRange.to + added });
      } else {
        chart.timeScale().fitContent();
      }
    } else {
      const lastSeen = lastTimeRef.current ?? Number.NEGATIVE_INFINITY;
      for (const item of linkedCandles) {
        if (item.t < lastSeen) continue;
        candleSeries.update(toCandle(item));
        if (item.quoteVolume !== null) volumeSeries.update(toVolume(item));
      }
    }
    firstTimeRef.current = firstTime;
    lastTimeRef.current = linkedCandles.at(-1)!.t;
    previousLengthRef.current = linkedCandles.length;
  }, [candles]);

  return (
    <figure className="chart" aria-label={`${symbol} K 线图`}>
      <div ref={containerRef} className="chart-canvas" data-testid="tradingview-chart" data-history-loading={historyLoading ? 'true' : 'false'} />
      {candles.length === 0 && <div className="chart-empty">暂无成交 K 线</div>}
      {(historyLoading || refreshing) && <div className="history-loading">{historyLoading ? '正在加载更早行情' : '正在更新行情'}</div>}
      <figcaption>
        <span>拖动查看历史</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
      </figcaption>
    </figure>
  );
}
