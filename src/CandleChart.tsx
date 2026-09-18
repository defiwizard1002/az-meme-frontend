import { useMemo } from 'react';
import type { Candle } from './types';

interface Props { candles: Candle[]; symbol: string }

export function CandleChart({ candles, symbol }: Props) {
  const geometry = useMemo(() => {
    const visible = candles.slice(-72);
    const highs = visible.map((item) => Number(item.h));
    const lows = visible.map((item) => Number(item.l));
    const max = Math.max(...highs);
    const min = Math.min(...lows);
    const range = max - min || 1;
    return visible.map((item, index) => {
      const x = 14 + index * (872 / Math.max(visible.length, 1));
      const y = (value: string) => 18 + ((max - Number(value)) / range) * 242;
      return { item, x, open: y(item.o), high: y(item.h), low: y(item.l), close: y(item.c) };
    });
  }, [candles]);

  if (candles.length === 0) return <div className="chart-state">暂无成交 K 线</div>;

  return (
    <figure className="chart" aria-label={`${symbol} K 线图`}>
      <svg viewBox="0 0 900 280" role="img">
        <title>{symbol} K 线</title>
        {[50, 100, 150, 200, 250].map((y) => <line key={y} className="grid-line" x1="0" x2="900" y1={y} y2={y} />)}
        {geometry.map(({ item, x, open, high, low, close }) => {
          const up = close <= open;
          return (
            <g key={`${item.t}-${item.revision}`} className={up ? 'candle-up' : 'candle-down'}>
              <line x1={x} x2={x} y1={high} y2={low} />
              <rect x={x - 3.5} y={Math.min(open, close)} width="7" height={Math.max(Math.abs(close - open), 1.5)} />
            </g>
          );
        })}
      </svg>
      <figcaption>历史回补完成后接入秒级实时扫描</figcaption>
    </figure>
  );
}
