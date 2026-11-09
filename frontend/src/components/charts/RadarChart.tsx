import React, { useState } from 'react';
import { formatTableCell } from './chartUtils';

interface RadarChartProps {
  title: string;
  rows: Record<string, unknown>[];
  labelKey: string;
  valueKey: string;
}

export const RadarChart: React.FC<RadarChartProps> = ({
  title,
  rows,
  labelKey,
  valueKey,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const maxRadarCategories = 36;
  const radarRows = rows.length <= maxRadarCategories ? rows : rows.slice(0, maxRadarCategories);
  const N = radarRows.length;

  if (N < 3) {
    return (
      <p className="text-xs text-slate-400 py-6 text-center">
        Radar charts require at least 3 categories to construct a polygon.
      </p>
    );
  }

  const cx = 250, cy = 175, maxR = 115;
  const angleStep = (Math.PI * 2) / N;
  const levels = [0.25, 0.5, 0.75, 1.0];
  const maxVal = Math.max(...radarRows.map(r => Number(r[valueKey]) || 0)) || 1;

  const dataPoints = radarRows.map((r, i) => {
    const val = Number(r[valueKey]) || 0;
    const norm = Math.max(0.06, Math.min(1, val / maxVal));
    const a = -Math.PI / 2 + i * angleStep;
    return `${cx + maxR * norm * Math.cos(a)},${cy + maxR * norm * Math.sin(a)}`;
  }).join(' ');

  return (
    <div className="flex flex-col items-center justify-center w-full py-1">
      <div className="w-full flex flex-col items-center">
        {rows.length > maxRadarCategories && (
          <div className="text-[11px] text-slate-500 pb-1">
            Showing first {maxRadarCategories} of {rows.length} categories
          </div>
        )}
        <svg
          viewBox="0 0 500 360"
          className="w-full max-w-[500px] overflow-visible"
          role="img"
          aria-label={title}
        >
          <title>{title}</title>
          {/* Concentric grid rings */}
          {levels.map((lvl, lIdx) => {
            const pts = Array.from({ length: N }, (_, i) => {
              const a = -Math.PI / 2 + i * angleStep;
              return `${cx + maxR * lvl * Math.cos(a)},${cy + maxR * lvl * Math.sin(a)}`;
            }).join(' ');
            return (
              <g key={lIdx}>
                <polygon
                  points={pts}
                  fill={lIdx === levels.length - 1 ? 'rgba(248, 250, 252, 0.45)' : 'none'}
                  stroke="#E2E8F0"
                  strokeWidth="1"
                  strokeDasharray={lvl === 1.0 ? undefined : '3,3'}
                />
                <text
                  x={cx + 6}
                  y={cy - maxR * lvl + 3.5}
                  fontSize="9"
                  fill="#94A3B8"
                  fontWeight="600"
                >
                  {formatTableCell(maxVal * lvl, valueKey).display}
                </text>
              </g>
            );
          })}
          {/* Spoke lines */}
          {radarRows.map((_, i) => {
            const a = -Math.PI / 2 + i * angleStep;
            return (
              <line
                key={i}
                x1={cx}
                y1={cy}
                x2={cx + maxR * Math.cos(a)}
                y2={cy + maxR * Math.sin(a)}
                stroke="#E2E8F0"
                strokeWidth="1"
              />
            );
          })}
          {/* Shaded polygon with gradient accent */}
          <polygon
            points={dataPoints}
            fill="#3B82F6"
            fillOpacity="0.22"
            stroke="#2563EB"
            strokeWidth="2.5"
            style={{ filter: 'drop-shadow(0 2px 6px rgba(37,99,235,0.2))' }}
          />
          {/* Data vertices & labels */}
          {radarRows.map((row, i) => {
            const val = Number(row[valueKey]) || 0;
            const norm = Math.max(0.06, Math.min(1, val / maxVal));
            const a = -Math.PI / 2 + i * angleStep;
            const vx = cx + maxR * norm * Math.cos(a);
            const vy = cy + maxR * norm * Math.sin(a);
            const labelR = maxR + 25;
            const lx = cx + labelR * Math.cos(a);
            const ly = cy + labelR * Math.sin(a);
            const label = String(row[labelKey] || '');
            const displayLabel = label.length > 13 ? label.slice(0, 12) + '…' : label;
            const isHovered = hoveredIndex === i;

            const cosA = Math.cos(a);
            const sinA = Math.sin(a);
            const textAnchor = Math.abs(cosA) < 0.15 ? 'middle' : cosA > 0 ? 'start' : 'end';
            const yOffset = sinA < -0.8 ? -4 : sinA > 0.8 ? 10 : 3.5;

            return (
              <g key={i}>
                {isHovered && (
                  <line
                    x1={cx}
                    y1={cy}
                    x2={cx + maxR * Math.cos(a)}
                    y2={cy + maxR * Math.sin(a)}
                    stroke="#2563EB"
                    strokeWidth="1.5"
                  />
                )}
                <circle
                  cx={vx}
                  cy={vy}
                  r={isHovered ? 6.5 : 4}
                  fill={isHovered ? '#1D4ED8' : '#2563EB'}
                  stroke="#FFFFFF"
                  strokeWidth="2"
                  style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <title>{`${label}: ${formatTableCell(val, valueKey).display}`}</title>
                </circle>
                <text
                  x={lx}
                  y={ly + yOffset}
                  textAnchor={textAnchor}
                  fontSize="9.5"
                  fill={isHovered ? '#0F172A' : '#475569'}
                  fontWeight={isHovered ? '700' : '500'}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  {displayLabel}
                </text>
                {isHovered && (
                  <g pointerEvents="none">
                    <rect
                      x={vx - 45}
                      y={vy - 34}
                      width="90"
                      height="24"
                      rx="6"
                      fill="#0F172A"
                      filter="drop-shadow(0 2px 5px rgba(0,0,0,0.25))"
                    />
                    <text
                      x={vx}
                      y={vy - 18}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#FFFFFF"
                      fontWeight="600"
                    >
                      {formatTableCell(val, valueKey).display}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

