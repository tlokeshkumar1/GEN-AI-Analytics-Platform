import React, { useState } from 'react';
import { formatTableCell, formatNumber } from './chartUtils';

interface HorizontalBarChartProps {
  title: string;
  rows: Record<string, unknown>[];
  values: (number | null)[];
  labelKey: string;
  valueKey: string;
  high: number;
  low: number;
  isCurrencyMetric: boolean;
}

export const HorizontalBarChart: React.FC<HorizontalBarChartProps> = ({
  title,
  rows,
  values,
  labelKey,
  valueKey,
  high,
  low,
  isCurrencyMetric,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const displayRows = rows;
  const rowH = 20;
  const rowGap = 10;
  const hChartHeight = Math.max(200, displayRows.length * (rowH + rowGap) + 50);
  const hLeft = 110, hRight = 530, hTop = 15, hBottom = hChartHeight - 25;
  const hWidth = hRight - hLeft;
  const hRange = high - low || 1;
  const xPos = (val: number) => hLeft + Math.max(0, ((val - low) / hRange) * hWidth);

  return (
    <div className="w-full py-1">
      <div className={`w-full ${displayRows.length > 10 ? 'overflow-y-auto max-h-[460px] pr-2' : ''}`}>
        <svg
          viewBox={`0 0 600 ${hChartHeight}`}
          className="w-full overflow-visible"
          role="img"
          aria-label={title}
        >
          {/* Vertical Guide Gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
            const gx = hLeft + frac * hWidth;
            const gVal = low + frac * hRange;
            return (
              <g key={idx}>
                <line x1={gx} y1={hTop} x2={gx} y2={hBottom} stroke="#E2E8F0" strokeWidth="1" strokeDasharray={idx === 0 ? undefined : '3,3'} />
                <text x={gx} y={hBottom + 14} textAnchor="middle" fontSize="9" fill="#94A3B8" fontWeight="500">
                  {formatNumber(gVal, isCurrencyMetric)}
                </text>
              </g>
            );
          })}
          {/* Horizontal Bars for ALL rows */}
          {displayRows.map((row, idx) => {
            const val = values[idx];
            if (val == null || !Number.isFinite(val)) return null;
            const barY = hTop + (idx + 0.5) * (rowH + rowGap);
            const barH = 18;
            const barW = Math.max(3, xPos(val) - hLeft);
            const isHovered = hoveredIndex === idx;
            const label = String(row[labelKey] || '');
            const displayLabel = label.length > 15 ? label.slice(0, 14) + '…' : label;

            return (
              <g key={idx}>
                {/* Category Y-axis label */}
                <text
                  x={hLeft - 8}
                  y={barY + 3.5}
                  textAnchor="end"
                  fontSize="10"
                  fill={isHovered ? '#0F172A' : '#475569'}
                  fontWeight={isHovered ? '700' : '500'}
                >
                  {displayLabel}
                </text>
                {/* Horizontal Bar */}
                <rect
                  x={hLeft}
                  y={barY - barH / 2}
                  width={barW}
                  height={barH}
                  rx="4"
                  ry="4"
                  fill={isHovered ? '#2563EB' : '#3B82F6'}
                  style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <title>{`${label}: ${formatTableCell(val, valueKey).display}`}</title>
                </rect>
                {/* Value label on tip of bar */}
                <text
                  x={hLeft + barW + 6}
                  y={barY + 3.5}
                  textAnchor="start"
                  fontSize="10"
                  fill="#1E293B"
                  fontWeight="600"
                >
                  {formatTableCell(val, valueKey).display}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

