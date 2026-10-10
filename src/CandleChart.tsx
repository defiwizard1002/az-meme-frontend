import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from './types';

interface Props {
  candles: Candle[];
  symbol: string;
  refreshing?: boolean;
  onLoadBefore?: (before: number) => Promise<HistoryLoadResult>;
}

export interface HistoryLoadResult {
  added: number;
  exhausted: boolean;
}

// lightweight-charts 5.2.1 applies this absolute bound to every series value.
const CHART_VALUE_BOUND = Number.MAX_SAFE_INTEGER / 100;

interface ChartData {
  candles: CandlestickData<UTCTimestamp>[];
  volumes: HistogramData<UTCTimestamp>[];
  excludedCount: number;
}

function isRenderableValue(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= CHART_VALUE_BOUND;
}

function buildChartData(candles: Candle[]): ChartData {
  const data: ChartData = { candles: [], volumes: [], excludedCount: 0 };
  for (const item of [...candles].sort((a, b) => a.t - b.t)) {
    const bar = {
      time: item.t as UTCTimestamp,
      open: Number(item.o),
      high: Number(item.h),
      low: Number(item.l),
      close: Number(item.c),
    };
    if (![bar.open, bar.high, bar.low, bar.close].every((value) => value > 0 && isRenderableValue(value))) {
      data.excludedCount += 1;
      continue;
    }
    // Presentation only: connect genuine bars, including across seconds with no trades.
    // Raw OHLC, revisions and volumes remain owned by the snapshot/cache.
    bar.open = data.candles.at(-1)?.close ?? bar.open;
    bar.high = Math.max(bar.high, bar.open);
    bar.low = Math.min(bar.low, bar.open);
    data.candles.push(bar);
    if (item.quoteVolume !== null) {
      const volume = Number(item.quoteVolume);
      if (volume >= 0 && isRenderableValue(volume)) {
        data.volumes.push({ time: bar.time, value: volume, color: bar.close >= bar.open ? '#39d98a55' : '#ff4d7955' });
      }
    }
  }
  return data;
}

function remapLogicalRange(
  range: { from: number; to: number }, previous: ChartData['candles'], next: ChartData['candles'],
): { from: number; to: number } {
  const indexes = new Map(next.map((bar, index) => [bar.time, index]));
  const anchors = previous.flatMap((bar, index) => {
    const nextIndex = indexes.get(bar.time);
    return nextIndex === undefined ? [] : [{ before: index, after: nextIndex }];
  });
  const remap = (logical: number) => {
    const right = anchors.find((anchor) => anchor.before >= logical);
    const left = [...anchors].reverse().find((anchor) => anchor.before <= logical);
    if (left && right && left !== right) {
      return left.after + (logical - left.before) * (right.after - left.after) / (right.before - left.before);
    }
    const anchor = left ?? right;
    return anchor ? logical + anchor.after - anchor.before : logical;
  };
  return { from: remap(range.from), to: remap(range.to) };
}

function pricePrecision(candles: ChartData['candles']): { precision: number; minMove: number } {
  const last = candles.at(-1)?.close ?? 0;
  if (last >= 100) return { precision: 2, minMove: 0.01 };
  if (last >= 1) return { precision: 4, minMove: 0.0001 };
  if (last >= 0.01) return { precision: 6, minMove: 0.000001 };
  return { precision: 8, minMove: 0.00000001 };
}

export function CandleChart({ candles, symbol, refreshing = false, onLoadBefore }: Props) {
  const data = useMemo(() => buildChartData(candles), [candles]);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const previousDataRef = useRef<ChartData | null>(null);
  const fittedRef = useRef(false);
  const savedViewportRef = useRef<{ data: ChartData; range: { from: number; to: number }; priceRange: { from: number; to: number } | null;
    crosshair: { time: Time; price: number } | null } | null>(null);
  const crosshairRef = useRef<{ time: Time; price: number } | null>(null);
  const candlesRef = useRef(candles);
  const loadBeforeRef = useRef(onLoadBefore);
  const loadingBeforeRef = useRef(false);
  const interactedRef = useRef(false);
  const requestedBeforeRef = useRef<number | null>(null);
  const retryableBeforeRef = useRef<number | null>(null);
  const retryAfterRef = useRef(0);
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
        autoScale: true,
        borderColor: '#282531',
        scaleMargins: { top: 0.1, bottom: 0.18 },
      },
      timeScale: {
        borderColor: '#282531',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 5,
        barSpacing: 3,
        minBarSpacing: 0.5,
        shiftVisibleRangeOnNewBar: false,
        allowShiftVisibleRangeOnWhitespaceReplacement: false,
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
      priceFormat: { type: 'price', ...pricePrecision(data.candles) },
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

    const handleCrosshair = (event: MouseEventParams) => {
      const price = event.point ? candleSeries.coordinateToPrice(event.point.y) : null;
      crosshairRef.current = event.time !== undefined && price !== null ? { time: event.time, price } : null;
    };
    chart.subscribeCrosshairMove?.(handleCrosshair);

    let active = true;
    const handleVisibleRange = (range: { from: number; to: number } | null) => {
      if (!range || range.from >= 8 || !interactedRef.current || loadingBeforeRef.current || !loadBeforeRef.current) return;
      const before = (candlesRef.current[0]?.t ?? 0) - 1;
      if (before <= 0 || requestedBeforeRef.current === before) return;
      requestedBeforeRef.current = before;
      loadingBeforeRef.current = true;
      setHistoryLoading(true);
      void loadBeforeRef.current(before)
        .then(({ added, exhausted }) => {
          if (!active) return;
          if (added === 0 && !exhausted) {
            retryableBeforeRef.current = before;
            retryAfterRef.current = Date.now() + 1_000;
          }
        })
        .catch(() => {
          if (!active) return;
          retryableBeforeRef.current = before;
          retryAfterRef.current = Date.now() + 1_000;
        })
        .finally(() => {
          if (!active) return;
          loadingBeforeRef.current = false;
          setHistoryLoading(false);
        });
    };
    const markInteraction = () => {
      interactedRef.current = true;
      if (retryableBeforeRef.current === null || loadingBeforeRef.current || Date.now() < retryAfterRef.current) return;
      retryableBeforeRef.current = null;
      requestedBeforeRef.current = null;
      handleVisibleRange(chart.timeScale().getVisibleLogicalRange());
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
      active = false;
      resizeObserver.disconnect();
      container.removeEventListener('pointerdown', markInteraction);
      container.removeEventListener('wheel', markInteraction);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      chart.unsubscribeCrosshairMove?.(handleCrosshair);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      previousDataRef.current = null;
      fittedRef.current = false;
      savedViewportRef.current = null;
      crosshairRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;
    const { candles: candleData, volumes: volumeData } = data;
    const previous = previousDataRef.current;
    const timeScale = chart.timeScale();
    const visibleRange = timeScale.getVisibleLogicalRange();
    const priceScale = candleSeries.priceScale();
    const manualPriceRange = priceScale.options?.().autoScale === false ? priceScale.getVisibleRange?.() : null;
    const crosshair = crosshairRef.current;
    if (candleData.length === 0) {
      if (previous?.candles.length && visibleRange) {
        savedViewportRef.current = { data: previous, range: visibleRange, priceRange: manualPriceRange ?? null, crosshair };
      }
      candleSeries.setData([]);
      volumeSeries.setData([]);
      previousDataRef.current = data;
      return;
    }

    const firstTime = candleData[0]!.time;
    const previousFirst = previous?.candles[0]?.time;
    const lastSeen = previous?.candles.at(-1)?.time ?? Number.NEGATIVE_INFINITY;
    const prepended = previousFirst !== undefined && firstTime < previousFirst;
    // Filtering/recovery can change older timestamps even when the count stays the same.
    // Rebuild in that case; update() can only replace the latest bar or append newer bars.
    const historyChanged = previous?.candles.some((bar, index) => {
      const next = candleData[index];
      return !next || next.time !== bar.time || (bar.time < lastSeen
        && (next.open !== bar.open || next.high !== bar.high || next.low !== bar.low || next.close !== bar.close));
    }) || previous?.volumes.some((bar, index) => {
      const next = volumeData[index];
      return !next || next.time !== bar.time || (bar.time < lastSeen
        && (next.value !== bar.value || next.color !== bar.color));
    }) || volumeData.some((bar, index) => bar.time < lastSeen && previous?.volumes[index]?.time !== bar.time);
    const reset = !previous?.candles.length || firstTime > lastSeen || prepended || historyChanged;
    if (reset) {
      candleSeries.setData(candleData);
      volumeSeries.setData(volumeData);
    } else {
      for (const bar of candleData) {
        if (bar.time >= lastSeen) candleSeries.update(bar);
      }
      for (const bar of volumeData) {
        if (bar.time >= lastSeen) volumeSeries.update(bar);
      }
    }
    if (!fittedRef.current) {
      timeScale.fitContent();
      fittedRef.current = true;
    } else {
      const viewport = previous?.candles.length && visibleRange ? { data: previous, range: visibleRange } : savedViewportRef.current;
      if (viewport) {
        const target = reset ? remapLogicalRange(viewport.range, viewport.data.candles, candleData) : viewport.range;
        const currentRange = timeScale.getVisibleLogicalRange();
        // Avoid interrupting an active gesture when the chart already kept its range.
        if (!currentRange || currentRange.from !== target.from || currentRange.to !== target.to) {
          timeScale.setVisibleLogicalRange(target);
        }
      }
    }
    const restorePrice = manualPriceRange ?? savedViewportRef.current?.priceRange;
    const restoreCrosshair = crosshair ?? savedViewportRef.current?.crosshair;
    savedViewportRef.current = null;
    if (restorePrice) priceScale.setVisibleRange(restorePrice);
    if (restoreCrosshair) chart.setCrosshairPosition?.(restoreCrosshair.price, restoreCrosshair.time, candleSeries);
    previousDataRef.current = data;
  }, [data]);

  return (
    <figure className="chart" aria-label={`${symbol} K 线图`}>
      <div
        ref={containerRef}
        className="chart-canvas"
        data-testid="tradingview-chart"
        data-candle-count={data.candles.length}
        data-first-candle-time={data.candles[0]?.time}
        data-history-loading={historyLoading ? 'true' : 'false'}
      />
      {data.candles.length === 0 && !refreshing && <div className="chart-empty">
        {candles.length === 0 ? '暂无成交 K 线' : '暂无可渲染 K 线'}
      </div>}
      {data.excludedCount > 0 && <figcaption className="chart-availability" role="status">
        部分 K 线点无法渲染，已排除 {data.excludedCount} 个
      </figcaption>}
      {(historyLoading || refreshing) && <div
        className="history-loading"
        role="status"
        aria-label={historyLoading ? '正在加载更早行情' : '正在加载行情'}
      ><span /><span /><span /></div>}
    </figure>
  );
}
