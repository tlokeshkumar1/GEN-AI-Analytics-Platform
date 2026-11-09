import React, { useState } from 'react';
import { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';

export function parseTemporalSortKey(value: unknown): number | null {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;

  // 1. Year-Month (e.g., "2023-01", "2025-11", "2024/05", "2023-1")
  const ym = str.match(/^(\d{4})[-/](0?[1-9]|1[0-2])$/);
  if (ym) {
    return parseInt(ym[1], 10) * 100 + parseInt(ym[2], 10);
  }

  // 2. Year only (e.g. 2023, "2024")
  const yOnly = str.match(/^(\d{4})$/);
  if (yOnly) {
    const y = parseInt(yOnly[1], 10);
    if (y >= 1900 && y <= 2100) {
      return y * 100;
    }
  }

  // 3. Quarter (e.g. "2024-Q1", "2024 Q2", "Q3 2024")
  const q1 = str.match(/^(\d{4})[- ]?Q([1-4])$/i);
  if (q1) {
    return parseInt(q1[1], 10) * 100 + parseInt(q1[2], 10) * 3;
  }
  const q2 = str.match(/^Q([1-4])[- ]?(\d{4})$/i);
  if (q2) {
    return parseInt(q2[2], 10) * 100 + parseInt(q2[1], 10) * 3;
  }

  // 4. ISO Date (e.g. "2024-03-15")
  const isoDate = str.match(/^(\d{4})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])$/);
  if (isoDate) {
    return parseInt(isoDate[1], 10) * 10000 + parseInt(isoDate[2], 10) * 100 + parseInt(isoDate[3], 10);
  }

  // 5. Month names (e.g. "Jan 2024", "January 2024", "2024 Jan")
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m1 = str.match(/^([a-z]+)[- ]+(\d{4})$/i);
  if (m1) {
    const mIdx = monthNames.findIndex(mn => m1[1].toLowerCase().startsWith(mn));
    if (mIdx >= 0) {
      return parseInt(m1[2], 10) * 100 + (mIdx + 1);
    }
  }
  const m2 = str.match(/^(\d{4})[- ]+([a-z]+)$/i);
  if (m2) {
    const mIdx = monthNames.findIndex(mn => m2[2].toLowerCase().startsWith(mn));
    if (mIdx >= 0) {
      return parseInt(m2[1], 10) * 100 + (mIdx + 1);
    }
  }

  // 6. Generic timestamp parseable by Date.parse
  if (isNaN(Number(str))) {
    const parsed = Date.parse(str);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function isTemporalColumn(columnName: string, sampleValues: unknown[]): boolean {
  if (!columnName) return false;
  const lower = columnName.toLowerCase().replace(/[\s_-]+/g, '');
  const temporalNames = ['year', 'orderdate', 'date', 'quarter', 'month', 'monthname', 'monthlabel', 'monthnum', 'period', 'day', 'time'];
  if (temporalNames.includes(lower) || /year|month|date|quarter|period/.test(lower)) {
    return true;
  }
  const valid = sampleValues.filter(v => v != null && String(v).trim() !== '');
  if (valid.length === 0) return false;
  const temporalCount = valid.filter(v => parseTemporalSortKey(v) !== null).length;
  return temporalCount / valid.length >= 0.7;
}

export function humanizeColumnName(col: string): string {
  if (!col) return '';
  const lower = col.toLowerCase();
  if (lower === 'grossmarginusd') return 'Gross Margin (USD)';
  if (lower === 'netrevenueusd') return 'Net Revenue (USD)';
  if (lower === 'monthlabel') return 'Month';
  if (lower === 'country') return 'Country';
  if (lower === 'productname' || lower === 'product') return 'Product';
  if (lower === 'customername' || lower === 'customer') return 'Customer';
  if (lower === 'salesregion' || lower === 'region') return 'Region';
  if (lower === 'orderdate') return 'Order Date';
  if (lower === 'quantitysold' || lower === 'quantity') return 'Quantity Sold';
  if (col.endsWith('USD') || col.endsWith('usd')) {
    const base = col.slice(0, -3).replace(/([A-Z])/g, ' $1').trim();
    return `${base} (USD)`;
  }
  return col
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function formatTableCell(value: unknown, column: string): { display: string; tooltip: string } {
  if (value == null) return { display: 'N/A', tooltip: 'Missing' };
  if (typeof value === 'object') return { display: JSON.stringify(value), tooltip: JSON.stringify(value) };

  const str = String(value).trim();
  const num = Number(str);
  if (isNaN(num) || !Number.isFinite(num)) {
    return { display: str, tooltip: str };
  }

  const isCurrency = /usd|revenue|margin|price|cost|sales|amount|val/i.test(column);
  const exactFormatted = isCurrency
    ? `$${num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
    : num.toLocaleString();

  if (Math.abs(num) >= 1_000_000) {
    const compact = isCurrency
      ? `$${(num / 1_000_000).toFixed(2)}M`
      : `${(num / 1_000_000).toFixed(2)}M`;
    return { display: compact, tooltip: `${compact} (${exactFormatted})` };
  }

  if (Math.abs(num) >= 1_000) {
    const compact = isCurrency
      ? `$${num.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
      : num.toLocaleString();
    return { display: compact, tooltip: exactFormatted };
  }

  const standard = isCurrency
    ? `$${Number.isInteger(num) ? num.toLocaleString() : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : num.toLocaleString();

  return { display: standard, tooltip: exactFormatted };
}

function formatNumber(value: unknown, isCurrency = false): string {
  if (value == null) return 'N/A';
  if (typeof value === 'object') return JSON.stringify(value);
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const prefix = isCurrency ? '$' : '';
  if (Math.abs(num) >= 1_000_000) return `${prefix}${(num / 1_000_000).toFixed(2)}M`;
  if (Math.abs(num) >= 1_000) return `${prefix}${num.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
  if (Number.isInteger(num)) return `${prefix}${num.toLocaleString()}`;
  return `${prefix}${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface AnalyticsWidgetProps {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  showTable?: boolean;
  isDashboard?: boolean;
}

export function AnalyticsWidget({ definition, result, showTable = true, isDashboard = false }: AnalyticsWidgetProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [funnelSort, setFunnelSort] = useState<'desc' | 'original'>('desc');

  if (!result.success) return <p role="alert" className="text-red-700">{result.error || 'Execution failed.'}</p>;
  if (!result.data.length) return <p className="text-slate-500">No matching records.</p>;
  const rawRows = result.data;
  const columns = Object.keys(rawRows[0]);
  const measures = (definition.query_plan?.measures as { field: string; alias?: string }[] | undefined)?.map(m => m.alias || m.field)
    || [String(definition.query_plan?.metric || 'value')];
  const valueKey = 'value' in rawRows[0] ? 'value' : measures.find(key => key in rawRows[0]) || columns[columns.length - 1];
  const labelKey = columns.find(key => key !== valueKey && !measures.includes(key)) || columns[0];

  const rows = React.useMemo(() => {
    if (!rawRows || !rawRows.length) return [];
    const copy = [...rawRows];
    const sortConfig = definition.query_plan?.sort as { column?: string; direction?: string } | undefined;
    // If explicit sort on a different column (e.g. ranking measures) is configured by user, do not override
    if (sortConfig && sortConfig.column && sortConfig.column !== labelKey) {
      return copy;
    }

    const sample = copy.slice(0, 50).map(r => r[labelKey]);
    if (isTemporalColumn(labelKey, sample)) {
      const isDesc = sortConfig?.direction?.toUpperCase() === 'DESC';
      return copy.sort((a, b) => {
        const keyA = parseTemporalSortKey(a[labelKey]);
        const keyB = parseTemporalSortKey(b[labelKey]);
        if (keyA !== null && keyB !== null) {
          return isDesc ? keyB - keyA : keyA - keyB;
        }
        if (keyA !== null) return isDesc ? 1 : -1;
        if (keyB !== null) return isDesc ? -1 : 1;
        return isDesc
          ? String(b[labelKey] ?? '').localeCompare(String(a[labelKey] ?? ''))
          : String(a[labelKey] ?? '').localeCompare(String(b[labelKey] ?? ''));
      });
    }
    return copy;
  }, [rawRows, definition.query_plan, labelKey]);
  const values = rows.map(row => row[valueKey] == null ? null : Number(row[valueKey]));
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const low = Math.min(0, ...finite), high = Math.max(0, ...finite), range = high - low || 1;

  const isCurrencyMetric = /usd|revenue|margin|price|cost|sales|amount/i.test(valueKey) ||
    /usd|revenue|margin|price|cost|sales|amount/i.test(definition.title);

  // Chart geometry
  const chartLeft = 55, chartRight = 580, chartTop = 20, chartBottom = 160;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;
  const svgHeight = 240;
  const y = (value: number) => chartBottom - ((value - low) / range) * chartHeight;
  const x = (index: number) => chartLeft + ((index + 0.5) / rows.length) * chartWidth;
  const barWidth = Math.min(32, (chartWidth / rows.length) * 0.7);

  // Smart label step
  const maxLabels = 8;
  const labelStep = rows.length > maxLabels ? Math.ceil(rows.length / maxLabels) : 1;

  // Gridlines
  const gridCount = 4;
  const gridValues = Array.from({ length: gridCount + 1 }, (_, i) => low + (range * i) / gridCount);

  const palette = ['#2563EB', '#0D9488', '#7C3AED', '#EA580C', '#0284C7', '#D97706', '#4F46E5', '#059669', '#DB2777', '#6366F1', '#0891B2', '#475569'];

  // Table with smart formatting and humanized column names
  const table = (
    <div className="overflow-auto max-h-80 rounded-xl border border-slate-200">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="bg-slate-50/80">
            {columns.map(c => (
              <th
                key={c}
                className="px-4 py-2.5 font-semibold text-slate-700 text-xs tracking-wider border-b border-slate-200 whitespace-nowrap"
              >
                {humanizeColumnName(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
            {
              rows.slice(0, 100).map((row, index) => (
                <tr
                  key={index}
                  className={`border-b border-slate-100 transition-colors hover:bg-blue-50/40 ${index % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'
                    }`}
                >
                  {columns.map(c => {
                    const formatted = formatTableCell(row[c], c);
                    return (
                      <td
                        key={c}
                        className="px-4 py-2.5 whitespace-nowrap text-slate-700 tabular-nums text-xs"
                        title={formatted.tooltip}
                      >
                        {formatted.display}
                      </td>
                    );
                  })}
                </tr>
              ))
            }
        </tbody>
      </table>
      {rows.length > 100 && (
        <div className="px-4 py-2 text-center text-xs text-slate-500 bg-slate-50/60 border-t border-slate-200">
          Showing first 100 of {rows.length.toLocaleString()} rows
        </div>
      )}
    </div>
  );

  const numericColumns = columns.filter(c => c !== valueKey && rows.some(r => r[c] != null && !isNaN(Number(r[c])) && Number.isFinite(Number(r[c]))));
  const secondKey = measures.find(key => key !== valueKey && key in rows[0]) || numericColumns[0];
  const scatterX = secondKey ? rows.map(row => row[secondKey] == null ? null : Number(row[secondKey])) : [];
  const xs = scatterX.filter((v): v is number => v !== null && Number.isFinite(v));
  const xLow = xs.length ? Math.min(...xs) : 0, xHigh = xs.length ? Math.max(...xs) : 1;
  const hasSecondMeasure = Boolean(secondKey && xs.length > 0);
  const pieValid = finite.length === values.length && finite.every(v => v >= 0) && finite.reduce((a, b) => a + b, 0) > 0;
  let angle = -Math.PI / 2;
  const total = finite.reduce((a, b) => a + b, 0);
  const lineSegments: string[][] = [[]];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) lineSegments.push([]);
    else lineSegments[lineSegments.length - 1].push(`${x(index)},${y(value)}`);
  });

  // Hover tooltip
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
    <div className="space-y-4">
      {definition.kind === 'kpi' ? (
        <div className="flex items-baseline gap-3 py-2">
          <p className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900 tabular-nums">
            {String(result.summary?.formatted_value || formatTableCell(rows[0][valueKey] ?? 'N/A', valueKey).display)}
          </p>
        </div>
      ) : (definition.kind === 'pie' || definition.kind === 'donut') ? (
        !pieValid ? (
          <p role="alert" className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm">
            {definition.kind === 'donut' ? 'Donut' : 'Pie'} charts require nonnegative, nonmissing values and a positive total.
          </p>
        ) : (
          <div className="flex flex-col md:flex-row items-center gap-6 w-full py-1">
            {/* Left: Authentic Solid Pie / Donut Chart */}
            <div className="w-full md:w-[48%] flex flex-col items-center justify-center shrink-0">
              <div className="relative w-56 h-56 flex items-center justify-center">
                <svg viewBox="0 0 240 240" className="w-full h-full overflow-visible" role="img" aria-label={definition.title}>
                  {(() => {
                    let currentAngle = -Math.PI / 2;
                    const isDonut = definition.kind === 'donut';
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
                      const color = palette[index % palette.length];
                      const title = `${String(row[labelKey])}: ${formatTableCell(row[valueKey], valueKey).display} (${((value / total) * 100).toFixed(1)}%)`;

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
                              <title>{title}</title>
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
                          <title>{title}</title>
                        </path>
                      );
                    });
                  })()}

                  {/* Donut Chart Center Metric */}
                  {definition.kind === 'donut' && (
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
                    {definition.kind === 'donut' ? 'donut_large' : 'pie_chart'}
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
                  const color = palette[index % palette.length];

                  return (
                    <div
                      key={index}
                      onMouseEnter={() => setHoveredIndex(index)}
                      onMouseLeave={() => setHoveredIndex(null)}
                      className={`pt-1.5 first:pt-0 flex items-center justify-between gap-3 text-xs py-1 px-2 rounded-lg transition-colors cursor-pointer ${isHovered ? 'bg-blue-100/70 font-semibold' : 'hover:bg-white'
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
        )
      ) : definition.kind === 'gauge' ? (
        <div className="flex flex-col items-center justify-center w-full py-2">
          <svg viewBox="0 0 360 210" className="w-full max-w-[380px] overflow-visible" role="img" aria-label={definition.title}>
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
            {(() => {
              const currentVal = values[0] ?? 0;
              const maxVal = finite.length > 1 ? Math.max(...finite) : (currentVal > 0 ? currentVal * 1.25 : 100);
              const pct = Math.min(1, Math.max(0, currentVal / (maxVal || 1)));
              const angle = Math.PI - pct * Math.PI;
              const endX = 180 + 100 * Math.cos(angle);
              const endY = 145 - 100 * Math.sin(angle);
              const largeArc = pct > 0.5 ? 1 : 0;
              const progressD = pct > 0
                ? (pct >= 0.999
                    ? "M 80 145 A 100 100 0 0 1 280 145"
                    : `M 80 145 A 100 100 0 ${largeArc} 1 ${endX} ${endY}`)
                : "";

              return (
                <>
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
                    {formatTableCell(currentVal, valueKey).display}
                  </text>
                  <text x="180" y="148" textAnchor="middle" fontSize="11" fontWeight="600" fill="#64748B">
                    {rows[0] ? String(rows[0][labelKey] || humanizeColumnName(valueKey)) : humanizeColumnName(valueKey)}
                  </text>
                  {/* Min and Max markers */}
                  <text x="80" y="168" textAnchor="middle" fontSize="9" fontWeight="600" fill="#94A3B8">
                    0
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
                </>
              );
            })()}
          </svg>
        </div>
      ) : definition.kind === 'funnel' ? (
        <div className="w-full py-2">
          {(() => {
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

            // Palette of gradients for funnel slices
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
                    aria-label={definition.title}
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

                      // Trapezoid points forming a true funnel segment
                      const points = `${xTL},${yTop} ${xTR},${yTop} ${xBR},${yBot} ${xBL},${yBot}`;

                      return (
                        <g
                          key={i}
                          className="cursor-pointer transition-opacity duration-150"
                          onMouseEnter={() => setHoveredIndex(i)}
                          onMouseLeave={() => setHoveredIndex(null)}
                        >
                          {/* Trapezoid Stage Slice */}
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

                          {/* Stage Label on the Left */}
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

                          {/* Center Percentage inside Trapezoid */}
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

                          {/* Stage Formatted Value on the Right */}
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

                          {/* Conversion Rate from Previous Stage */}
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
            );
          })()}
        </div>
      ) : definition.kind === 'radar' ? (
        <div className="flex flex-col items-center justify-center w-full py-1">
          {(() => {
            // Include all rows so all data is represented (up to 36 categories)
            const maxRadarCategories = 36;
            const radarRows = rows.length <= maxRadarCategories ? rows : rows.slice(0, maxRadarCategories);
            const N = radarRows.length;
            if (N < 3) {
              return (
                <p className="text-xs text-slate-400 py-6">
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
                  aria-label={definition.title}
                >
                  <title>{definition.title}</title>
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
                        {/* Scale value labels along the vertical top spoke */}
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
                        {/* Spoke highlight on hover */}
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
                        {/* Value tooltip callout on hover */}
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
            );
          })()}
        </div>
      ) : definition.kind === 'horizontal_bar' ? (
        <div className="w-full py-1">
          {(() => {
            // Render ALL rows so no categories or months are cut off
            const displayRows = rows;
            const rowH = 20;
            const rowGap = 10;
            const hChartHeight = Math.max(200, displayRows.length * (rowH + rowGap) + 50);
            const hLeft = 110, hRight = 530, hTop = 15, hBottom = hChartHeight - 25;
            const hWidth = hRight - hLeft;
            const hRange = high - low || 1;
            const xPos = (val: number) => hLeft + Math.max(0, ((val - low) / hRange) * hWidth);

            return (
              <div className={`w-full ${displayRows.length > 10 ? 'overflow-y-auto max-h-[460px] pr-2' : ''}`}>
                <svg
                  viewBox={`0 0 600 ${hChartHeight}`}
                  className="w-full overflow-visible"
                  role="img"
                  aria-label={definition.title}
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
            );
          })()}
        </div>
      
      ) : (
        definition.kind !== 'table' &&
        finite.length > 0 && (
          <svg viewBox={`0 0 600 ${svgHeight}`} className="w-full max-h-72" role="img" aria-label={definition.title}>
            <title>{definition.title}</title>

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

            {(definition.kind === 'line' || definition.kind === 'area') ? (
              <>
                {lineSegments.map((segment, sIdx) => {
                  if (segment.length < 2) return null;
                  const firstPoint = segment[0].split(',');
                  const lastPoint = segment[segment.length - 1].split(',');
                  const areaD = `M${segment.join(' L')} L${lastPoint[0]},${chartBottom} L${firstPoint[0]},${chartBottom} Z`;
                  return (
                    <g key={sIdx}>
                      <path d={areaD} fill="url(#areaGradient)" opacity={definition.kind === 'area' ? 0.9 : 0.35} />
                      <path d={`M${segment.join(' L')}`} fill="none" stroke="#2563EB" strokeWidth={definition.kind === 'area' ? '3' : '2.5'} strokeLinecap="round" strokeLinejoin="round" />
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
            ) : definition.kind === 'scatter' ? (
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

            {/* X-axis labels without aggressive truncation */}
            {(!['pie', 'donut'].includes(definition.kind) && (!hasSecondMeasure || definition.kind !== 'scatter')) &&
              rows.map((row, index) => {
                if (index % labelStep !== 0) return null;
                const label = String(row[labelKey] ?? 'Missing');
                // Allow up to 18 characters so "United States" is never truncated
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

            {definition.kind === 'scatter' && hasSecondMeasure && (
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
        )
      )}

      {/* Show table only when requested or if kind is table */}
      {(definition.kind === 'table' || (definition.kind !== 'kpi' && showTable)) && table}

      {/* Footer timings (hidden on Executive Dashboard to remove clutter) */}
      {!isDashboard && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium">
            {result.records_matched.toLocaleString()} records
          </span>
          <span className="text-slate-300">·</span>
          <span>{result.execution_backend}</span>
          <span className="text-slate-300">·</span>
          <span className="tabular-nums">{result.execution_time_ms.toFixed(1)} ms</span>
        </div>
      )}
    </div>
  );
}
