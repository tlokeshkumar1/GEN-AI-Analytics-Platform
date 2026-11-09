import React, { useState } from 'react';
import { formatTableCell, formatNumber, humanizeColumnName } from './chartUtils';

interface CartesianChartProps {
  kind: string;
  title: string;
  rows: Record<string, unknown>[];
  values: (number | null)[];
  columns: string[];
  measures: string[];
  labelKey: string;
  valueKey: string;
  high: number;
  low: number;
  isCurrencyMetric: boolean;
}

export const CartesianChart: React.FC<CartesianChartProps> = ({
  kind,
  title,
  rows,
  values,
  columns,
  measures,
  labelKey,
  valueKey,
  high,
  low,
  isCurrencyMetric,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const chartLeft = 55, chartRight = 580, chartTop = 20, chartBottom = 160;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;
  const svgHeight = 240;
  const range = high - low || 1;

  const y = (value: number) => chartBottom - ((value - low) / range) * chartHeight;
  const x = (index: number) => chartLeft + ((index + 0.5) / rows.length) * chartWidth;
  const barWidth = Math.min(32, (chartWidth / rows.length) * 0.7);

  const maxLabels = 8;
  const labelStep = rows.length > maxLabels ? Math.ceil(rows.length / maxLabels) : 1;

  const gridCount = 4;
  const gridValues = Array.from({ length: gridCount + 1 }, (_, i) => low + (range * i) / gridCount);

  const numericColumns = columns.filter(c => c !== valueKey && rows.some(r => r[c] != null && !isNaN(Number(r[c])) && Number.isFinite(Number(r[c]))));
  const secondKey = measures.find(key => key !== valueKey && key in rows[0]) || numericColumns[0];
  const scatterX = secondKey ? rows.map(row => row[secondKey] == null ? null : Number(row[secondKey])) : [];
  const xs = scatterX.filter((v): v is number => v !== null && Number.isFinite(v));
  const xLow = xs.length ? Math.min(...xs) : 0, xHigh = xs.length ? Math.max(...xs) : 1;
  const hasSecondMeasure = Boolean(secondKey && xs.length > 0);

  const lineSegments: string[][] = [[]];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) lineSegments.push([]);
    else lineSegments[lineSegments.length - 1].push(`${x(index)},${y(value)}`);
  });

  const tooltip = hoveredIndex !== null && rows[hoveredIndex] && (
    <g>
      <rect
        x={Math.min(Math.max(x(hoveredIndex) - 70, 5), 460)}
        y={Math.max(y(values[hoveredIndex] ?? 0) - 52, 2)}
        width="140"
        height="44"
        rx="8"
        fill="#FFFFFF"
        stroke="#CBD5E1"
        strokeWidth="1"
        filter="drop-shadow(0 4px 6px rgba(0,0,0,0.08))"
      />
      <text
        x={Math.min(Math.max(x(hoveredIndex), 75), 530)}
        y={Math.max(y(values[hoveredIndex] ?? 0) - 34, 16)}
        textAnchor="middle"
        fontSize="10"
        fill="#64748B"
        fontWeight="500"
      >
        {String(rows[hoveredIndex][labelKey] ?? '')}
      </text>
      <text
        x={Math.min(Math.max(x(hoveredIndex), 75), 530)}
        y={Math.max(y(values[hoveredIndex] ?? 0) - 18, 32)}
        textAnchor="middle"
        fontSize="13"
        fill="#0F172A"
        fontWeight="700"
      >
        {formatTableCell(rows[hoveredIndex][valueKey], valueKey).display}
      </text>
    </g>
  );

  return (
    <svg viewBox={`0 0 600 ${svgHeight}`} className="w-full max-h-72" role="img" aria-label={title}>
      <title>{title}</title>

      <defs>
        <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
        <linearGradient id="barGradientHover" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B82F6" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* Horizontal Guide Gridlines */}
      {gridValues.map((v, i) => (
        <g key={i}>
          <line
            x1={chartLeft}
            y1={y(v)}
            x2={chartRight}
            y2={y(v)}
            stroke="#E2E8F0"
            strokeWidth="1"
            strokeDasharray={i === 0 ? undefined : '3,3'}
          />
          <text x={chartLeft - 8} y={y(v) + 3.5} textAnchor="end" fontSize="9" fill="#94A3B8" fontWeight="500">
            {formatNumber(v, isCurrencyMetric)}
          </text>
        </g>
      ))}

      {(kind === 'line' || kind === 'area') ? (
        <>
          {lineSegments.map((segment, sIdx) => {
            if (segment.length < 2) return null;
            const firstPoint = segment[0].split(',');
            const lastPoint = segment[segment.length - 1].split(',');
            const areaD = `M${segment.join(' L')} L${lastPoint[0]},${chartBottom} L${firstPoint[0]},${chartBottom} Z`;
            return (
              <g key={sIdx}>
                <path d={areaD} fill="url(#areaGradient)" opacity={kind === 'area' ? 0.9 : 0.35} />
                <path d={`M${segment.join(' L')}`} fill="none" stroke="#2563EB" strokeWidth={kind === 'area' ? '3' : '2.5'} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}
          {rows.map((row, index) => {
            const value = values[index];
            if (value === null || !Number.isFinite(value)) return null;
            const isHovered = hoveredIndex === index;
            return (
              <circle
                key={index}
                cx={x(index)}
                cy={y(value)}
                r={isHovered ? 6 : 3.5}
                fill={isHovered ? '#1D4ED8' : '#2563EB'}
                stroke="#FFFFFF"
                strokeWidth="2"
                style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <title>{String(row[labelKey])}: {formatTableCell(row[valueKey], valueKey).display}</title>
              </circle>
            );
          })}
        </>
      ) : kind === 'scatter' ? (
        rows.map((row, index) => {
          const value = values[index];
          if (value === null || !Number.isFinite(value)) return null;
          const xVal = hasSecondMeasure ? scatterX[index] : null;
          if (hasSecondMeasure && (xVal === null || !Number.isFinite(xVal))) return null;
          const cx = hasSecondMeasure
            ? chartLeft + (((xVal ?? 0) - xLow) / (xHigh - xLow || 1)) * chartWidth
            : x(index);
          const cy = y(value);
          const isHovered = hoveredIndex === index;
          return (
            <g key={index}>
              {isHovered && (
                <line
                  x1={cx}
                  y1={cy}
                  x2={cx}
                  y2={chartBottom}
                  stroke="#93C5FD"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
              )}
              {isHovered && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={11}
                  fill="#3B82F6"
                  opacity="0.2"
                />
              )}
              <circle
                key={index}
                cx={cx}
                cy={cy}
                r={isHovered ? 7 : 5}
                fill={isHovered ? '#1D4ED8' : '#2563EB'}
                stroke="#FFFFFF"
                strokeWidth="2"
                style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <title>
                  {hasSecondMeasure
                    ? `${secondKey}: ${formatTableCell(row[secondKey], secondKey).display}; ${valueKey}: ${formatTableCell(row[valueKey], valueKey).display}`
                    : `${String(row[labelKey])}: ${formatTableCell(row[valueKey], valueKey).display}`}
                </title>
              </circle>
            </g>
          );
        })
      ) : (
        rows.map((row, index) => {
          const value = values[index];
          if (value === null || !Number.isFinite(value)) return null;
          const barH = Math.max(2, Math.abs(y(value) - y(0)));
          const barY = Math.min(y(value), y(0));
          const isHovered = hoveredIndex === index;
          return (
            <rect
              key={index}
              x={x(index) - barWidth / 2}
              y={barY}
              width={barWidth}
              height={barH}
              rx="4"
              ry="4"
              fill={isHovered ? 'url(#barGradientHover)' : 'url(#barGradient)'}
              style={{ cursor: 'pointer', transition: 'fill 0.15s ease' }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
            >
              <title>{String(row[labelKey])}: {formatTableCell(row[valueKey], valueKey).display}</title>
            </rect>
          );
        })
      )}

      {/* X-axis labels */}
      {(!hasSecondMeasure || kind !== 'scatter') &&
        rows.map((row, index) => {
          if (index % labelStep !== 0) return null;
          const label = String(row[labelKey] ?? 'Missing');
          const displayLabel = label.length > 18 ? label.slice(0, 17) + '…' : label;
          if (rows.length > 6) {
            return (
              <text
                key={index}
                x={x(index)}
                y={chartBottom + 14}
                textAnchor="end"
                fontSize="10"
                fill="#64748B"
                fontWeight="500"
                transform={`rotate(-32, ${x(index)}, ${chartBottom + 14})`}
              >
                {displayLabel}
              </text>
            );
          }
          return (
            <text
              key={index}
              x={x(index)}
              y={chartBottom + 16}
              textAnchor="middle"
              fontSize="9"
              fill="#64748B"
              fontWeight="500"
            >
              {displayLabel}
            </text>
          );
        })}

      {kind === 'scatter' && hasSecondMeasure && (
        <g>
          <text x={chartLeft} y={chartBottom + 16} textAnchor="start" fontSize="9" fill="#64748B" fontWeight="500">
            {formatNumber(xLow)}
          </text>
          <text x={chartRight} y={chartBottom + 16} textAnchor="end" fontSize="9" fill="#64748B" fontWeight="500">
            {formatNumber(xHigh)} ({humanizeColumnName(secondKey)})
          </text>
        </g>
      )}

      {tooltip}
    </svg>
  );
};

