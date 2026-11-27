import React from 'react';
import { formatNumber, humanizeColumnName } from './chartUtils';

interface GaugeChartProps {
  title: string;
  rows: Record<string, unknown>[];
  values: (number | null)[];
  labelKey: string;
  valueKey: string;
  isCurrencyMetric: boolean;
}

export const GaugeChart: React.FC<GaugeChartProps> = ({
  title,
  rows,
  values,
  labelKey,
  valueKey,
  isCurrencyMetric,
}) => {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const currentVal = values[0];
  if (currentVal == null || !Number.isFinite(currentVal)) return <p role="alert" className="text-xs py-4">No valid numeric value is available for this gauge.</p>;
  const maxVal = finite.length > 1 ? Math.max(...finite) : (currentVal > 0 ? currentVal * 1.25 : 100);
  const pct = Math.min(1, Math.max(0, currentVal / (maxVal || 1)));
  const angle = Math.PI - pct * Math.PI;
  const endX = 180 + 100 * Math.cos(angle);
  const endY = 145 - 100 * Math.sin(angle);
  // Semicircle gauge spans 0 to 180 degrees (Math.PI); any arc is <= 180 degrees, so large-arc-flag is always 0.
  const progressD = pct > 0
    ? (pct >= 0.999
        ? "M 80 145 A 100 100 0 0 1 280 145"
        : `M 80 145 A 100 100 0 0 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`)
    : "";

  return (
    <div className="flex flex-col items-center justify-center w-full py-2">
      <svg viewBox="0 0 360 210" className="w-full max-w-[380px] overflow-visible" role="img" aria-label={title}>
        <defs>
          <linearGradient id="gaugeGradient" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#3B82F6" />
            <stop offset="50%" stopColor="#2563EB" />
            <stop offset="100%" stopColor="#1D4ED8" />
          </linearGradient>
        </defs>
        {/* Background Semicircle Arc (cx=180, cy=145, r=100) */}
        <path
          d="M 80 145 A 100 100 0 0 1 280 145"
          fill="none"
          stroke="#E2E8F0"
          strokeWidth="16"
          strokeLinecap="round"
        />
        {progressD && (
          <path
            d={progressD}
            fill="none"
            stroke="url(#gaugeGradient)"
            strokeWidth="16"
            strokeLinecap="round"
          />
        )}
        {/* Glowing tip indicator */}
        {pct > 0 && pct < 1 && (
          <circle cx={endX} cy={endY} r="9" fill="#1D4ED8" stroke="#FFFFFF" strokeWidth="2.5" />
        )}
        {/* Value and dimension label */}
        <text x="180" y="128" textAnchor="middle" fontSize="28" fontWeight="800" fill="#0F172A">
          {formatNumber(currentVal, isCurrencyMetric)}
        </text>
        <text x="180" y="148" textAnchor="middle" fontSize="11" fontWeight="600" fill="#64748B">
          {rows[0] ? String(rows[0][labelKey] || humanizeColumnName(valueKey)) : humanizeColumnName(valueKey)}
        </text>
        {/* Min and Max markers */}
        <text x="80" y="168" textAnchor="middle" fontSize="9" fontWeight="600" fill="#94A3B8">
          {formatNumber(0, isCurrencyMetric)}
        </text>
        <text x="280" y="168" textAnchor="middle" fontSize="9" fontWeight="600" fill="#94A3B8">
          {formatNumber(maxVal, isCurrencyMetric)}
        </text>
        {/* Target pill */}
        <g transform="translate(135, 178)">
          <rect width="90" height="22" rx="11" fill="#EFF6FF" stroke="#BFDBFE" strokeWidth="1" />
          <text x="45" y="15" textAnchor="middle" fontSize="10" fontWeight="700" fill="#1D4ED8">
            {Math.round(pct * 100)}% of Max
          </text>
        </g>
      </svg>
    </div>
  );
};

