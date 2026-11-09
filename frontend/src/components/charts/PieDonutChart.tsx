import React, { useState } from 'react';
import { CHART_PALETTE, formatTableCell, formatNumber } from './chartUtils';

interface PieDonutChartProps {
  kind: 'pie' | 'donut';
  title: string;
  rows: Record<string, unknown>[];
  values: (number | null)[];
  labelKey: string;
  valueKey: string;
  isCurrencyMetric: boolean;
}

export const PieDonutChart: React.FC<PieDonutChartProps> = ({
  kind,
  title,
  rows,
  values,
  labelKey,
  valueKey,
  isCurrencyMetric,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const pieValid = finite.length === values.length && finite.every(v => v >= 0) && finite.reduce((a, b) => a + b, 0) > 0;
  const total = finite.reduce((a, b) => a + b, 0);

  if (!pieValid) {
    return (
      <p role="alert" className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
        {kind === 'donut' ? 'Donut' : 'Pie'} charts require nonnegative, nonmissing values and a positive total.
      </p>
    );
  }

  const isDonut = kind === 'donut';

  return (
    <div className="flex flex-col md:flex-row items-center gap-6 w-full py-1">
      {/* Left: Solid Pie / Donut Chart */}
      <div className="w-full md:w-[48%] flex flex-col items-center justify-center shrink-0">
        <div className="relative w-56 h-56 flex items-center justify-center">
          <svg viewBox="0 0 240 240" className="w-full h-full overflow-visible" role="img" aria-label={title}>
            {(() => {
              let currentAngle = -Math.PI / 2;
              return rows.map((row, index) => {
                const value = values[index]!;
                if (value <= 0) return null;
                const sliceAngle = (value / total) * Math.PI * 2;
                const start = currentAngle;
                const end = currentAngle + sliceAngle;
                currentAngle = end;

                const isHovered = hoveredIndex === index;
                const r = isHovered ? 104 : 98;
                const ir = isDonut ? (isHovered ? 66 : 60) : 0;
                const color = CHART_PALETTE[index % CHART_PALETTE.length];
                const sliceTitle = `${String(row[labelKey])}: ${formatTableCell(row[valueKey], valueKey).display} (${((value / total) * 100).toFixed(1)}%)`;

                if (value === total) {
                  return (
                    <g key={index}>
                      <circle
                        cx={120}
                        cy={120}
                        r={r}
                        fill={color}
                        style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
                        onMouseEnter={() => setHoveredIndex(index)}
                        onMouseLeave={() => setHoveredIndex(null)}
                      >
                        <title>{sliceTitle}</title>
                      </circle>
                      {isDonut && (
                        <circle cx={120} cy={120} r={ir} fill="#FFFFFF" pointerEvents="none" />
                      )}
                    </g>
                  );
                }

                const largeArc = sliceAngle > Math.PI ? 1 : 0;
                const x1 = 120 + r * Math.cos(start);
                const y1 = 120 + r * Math.sin(start);
                const x2 = 120 + r * Math.cos(end);
                const y2 = 120 + r * Math.sin(end);

                let d = '';
                if (isDonut) {
                  const x3 = 120 + ir * Math.cos(end);
                  const y3 = 120 + ir * Math.sin(end);
                  const x4 = 120 + ir * Math.cos(start);
                  const y4 = 120 + ir * Math.sin(start);
                  d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${ir} ${ir} 0 ${largeArc} 0 ${x4} ${y4} Z`;
                } else {
                  d = `M 120 120 L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
                }

                return (
                  <path
                    key={index}
                    d={d}
                    fill={color}
                    stroke="#FFFFFF"
                    strokeWidth="1.5"
                    style={{ cursor: 'pointer', transition: 'all 0.15s ease' }}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    <title>{sliceTitle}</title>
                  </path>
                );
              });
            })()}

            {/* Donut Chart Center Metric */}
            {isDonut && (
              <g textAnchor="middle" pointerEvents="none">
                <text x="120" y="112" fontSize="9" fill="#64748B" fontWeight="700" letterSpacing="0.08em">
                  TOTAL
                </text>
                <text x="120" y="131" fontSize="14" fill="#0F172A" fontWeight="800">
                  {formatNumber(total, isCurrencyMetric)}
                </text>
              </g>
            )}
          </svg>
        </div>

        {/* Active Slice Pill */}
        {hoveredIndex !== null && rows[hoveredIndex] ? (
          <div className="mt-2 text-center text-xs font-semibold text-slate-800 bg-slate-50 border border-slate-200/80 px-3 py-1 rounded-full animate-in fade-in">
            <span>{String(rows[hoveredIndex][labelKey])}: </span>
            <span className="text-blue-600 font-bold">{formatTableCell(rows[hoveredIndex][valueKey], valueKey).display}</span>
            <span className="text-slate-400 font-medium"> ({((Number(values[hoveredIndex] ?? 0) / total) * 100).toFixed(1)}%)</span>
          </div>
        ) : (
          <div className="mt-2 text-center text-xs text-slate-400 font-medium py-1">
            Hover over any slice or list row
          </div>
        )}
      </div>

      {/* Right: Scrollable Data Breakdown */}
      <div className="w-full md:w-[52%] flex flex-col min-w-0 bg-slate-50/70 rounded-xl border border-slate-200/80 p-3">
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200/70 text-xs">
          <span className="font-semibold text-slate-700 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[16px] text-blue-600">
              {isDonut ? 'donut_large' : 'pie_chart'}
            </span>
            <span>Data Breakdown ({rows.length})</span>
          </span>
          <span className="font-bold text-slate-900 tabular-nums">
            Total: {formatNumber(total, isCurrencyMetric)}
          </span>
        </div>

        <div className="overflow-y-auto max-h-[195px] pr-2 space-y-1 divide-y divide-slate-100/80 scroll-touch">
          {rows.map((row, index) => {
            const v = values[index] ?? 0;
            const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0';
            const isHovered = hoveredIndex === index;
            const label = String(row[labelKey] ?? `Segment ${index + 1}`);
            const color = CHART_PALETTE[index % CHART_PALETTE.length];

            return (
              <div
                key={index}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`pt-1.5 first:pt-0 flex items-center justify-between gap-3 text-xs py-1 px-2 rounded-lg transition-colors cursor-pointer ${
                  isHovered ? 'bg-blue-100/70 font-semibold' : 'hover:bg-white'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0 truncate">
                  <span
                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className={`truncate ${isHovered ? 'text-blue-900 font-semibold' : 'text-slate-700 font-medium'}`} title={label}>
                    {label}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 tabular-nums text-right">
                  <span className="font-semibold text-slate-900">
                    {formatTableCell(row[valueKey], valueKey).display}
                  </span>
                  <span className="text-[11px] text-slate-400 font-medium w-12 text-right">
                    ({pct}%)
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

