import React, { useState } from 'react';
import { formatTableCell } from './chartUtils';

interface FunnelChartProps {
  title: string;
  rows: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
}

export const FunnelChart: React.FC<FunnelChartProps> = ({
  title,
  rows,
  labelKey,
  valueKey,
}) => {
  const [funnelSort, setFunnelSort] = useState<'desc' | 'original'>('desc');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const sortedStages = funnelSort === 'desc'
    ? [...rows].sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0))
    : rows;
  const stages = sortedStages;
  const N = stages.length;
  if (N === 0) return null;

  const maxVal = Math.max(...stages.map(s => Number(s[valueKey]) || 0)) || 1;
  const svgWidth = 620;
  const cx = 310;
  const rowH = Math.max(34, Math.min(46, Math.floor(340 / Math.min(N, 10))));
  const gap = 5;
  const topMargin = 20;
  const totalH = topMargin + N * (rowH + gap) + 15;

  const funnelColors = [
    { start: '#2563EB', end: '#3B82F6' },
    { start: '#3B82F6', end: '#6366F1' },
    { start: '#6366F1', end: '#7C3AED' },
    { start: '#7C3AED', end: '#9333EA' },
    { start: '#9333EA', end: '#C026D3' },
    { start: '#C026D3', end: '#DB2777' },
    { start: '#DB2777', end: '#E11D48' },
    { start: '#E11D48', end: '#F43F5E' },
    { start: '#0284C7', end: '#0EA5E9' },
    { start: '#0D9488', end: '#14B8A6' },
    { start: '#059669', end: '#10B981' },
    { start: '#D97706', end: '#F59E0B' },
  ];

  const W_MAX = 380;
  const W_MIN = 80;

  const stageWidths = stages.map(s => {
    const val = Number(s[valueKey]) || 0;
    const ratio = Math.max(0.12, Math.min(1, val / maxVal));
    return Math.round(W_MIN + (W_MAX - W_MIN) * ratio);
  });

  return (
    <div className="w-full py-2">
      <div className="w-full flex flex-col items-center">
        {/* Header Controls for Funnel: count & sort toggle */}
        <div className="w-full max-w-[620px] flex items-center justify-between pb-2 px-1">
          <span className="text-[11px] font-medium text-slate-500">
            {stages.length} stages (all data shown)
          </span>
          <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg text-xs">
            <button
              type="button"
              onClick={() => setFunnelSort('desc')}
              className={`px-2.5 py-0.5 rounded-md font-medium text-[11px] transition-all cursor-pointer ${
                funnelSort === 'desc' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Funnel (Highest First)
            </button>
            <button
              type="button"
              onClick={() => setFunnelSort('original')}
              className={`px-2.5 py-0.5 rounded-md font-medium text-[11px] transition-all cursor-pointer ${
                funnelSort === 'original' ? 'bg-white text-blue-600 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Original Order
            </button>
          </div>
        </div>

        <div className={`w-full flex justify-center ${N > 8 ? 'overflow-y-auto max-h-[460px] pr-1' : ''}`}>
          <svg
            viewBox={`0 0 ${svgWidth} ${totalH}`}
            className="w-full max-w-[620px] overflow-visible"
            role="img"
            aria-label={title}
          >
            <defs>
              {stages.map((_, i) => {
                const c = funnelColors[i % funnelColors.length];
                return (
                  <linearGradient key={i} id={`funnel-grad-${i}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor={c.start} />
                    <stop offset="100%" stopColor={c.end} />
                  </linearGradient>
                );
              })}
            </defs>

            {stages.map((row, i) => {
              const val = Number(row[valueKey]) || 0;
              const pct = Math.max(1, Math.round((val / maxVal) * 100));
              const prevVal = i > 0 ? Number(stages[i - 1][valueKey]) || 0 : null;
              const convPct = prevVal && prevVal > 0 ? Math.round((val / prevVal) * 100) : null;
              const label = String(row[labelKey] || `Stage ${i + 1}`);
              const displayLabel = label.length > 15 ? label.slice(0, 14) + '…' : label;
              const isHovered = hoveredIndex === i;

              const yTop = topMargin + i * (rowH + gap);
              const yBot = yTop + rowH;

              const curW = stageWidths[i];
              const nextW = i < N - 1 ? stageWidths[i + 1] : Math.round(curW * 0.82);

              const topW = curW;
              const botW = funnelSort === 'desc'
                ? Math.min(topW, nextW)
                : nextW;

              const xTL = cx - topW / 2;
              const xTR = cx + topW / 2;
              const xBR = cx + botW / 2;
              const xBL = cx - botW / 2;

              const points = `${xTL},${yTop} ${xTR},${yTop} ${xBR},${yBot} ${xBL},${yBot}`;

              return (
                <g
                  key={i}
                  className="cursor-pointer transition-opacity duration-150"
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <polygon
                    points={points}
                    fill={`url(#funnel-grad-${i})`}
                    stroke={isHovered ? '#FFFFFF' : 'rgba(255,255,255,0.35)'}
                    strokeWidth={isHovered ? 2.5 : 1}
                    style={{
                      filter: isHovered ? 'drop-shadow(0 6px 14px rgba(37,99,235,0.35))' : 'drop-shadow(0 2px 4px rgba(0,0,0,0.06))',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <title>{`${label}: ${formatTableCell(val, valueKey).display} (${pct}% of max)`}</title>
                  </polygon>

                  <text
                    x={Math.min(xTL, xBL) - 12}
                    y={yTop + rowH / 2 + 4}
                    textAnchor="end"
                    fontSize="11"
                    fontWeight={isHovered ? '700' : '600'}
                    fill={isHovered ? '#0F172A' : '#334155'}
                  >
                    {displayLabel}
                  </text>

                  <text
                    x={cx}
                    y={yTop + rowH / 2 + 4}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill="#FFFFFF"
                    style={{ textShadow: '0 1px 2px rgba(0,0,0,0.5)' }}
                    pointerEvents="none"
                  >
                    {pct}%
                  </text>

                  <text
                    x={Math.max(xTR, xBR) + 12}
                    y={yTop + rowH / 2 + (convPct !== null ? 0 : 4)}
                    textAnchor="start"
                    fontSize="12"
                    fontWeight="700"
                    fill={isHovered ? '#1D4ED8' : '#0F172A'}
                  >
                    {formatTableCell(val, valueKey).display}
                  </text>

                  {convPct !== null && (
                    <text
                      x={Math.max(xTR, xBR) + 12}
                      y={yTop + rowH / 2 + 12}
                      textAnchor="start"
                      fontSize="9"
                      fontWeight="500"
                      fill="#64748B"
                    >
                      {convPct}% conv
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
};

