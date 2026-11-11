/**
 * Chart formatting and temporal parsing utilities for analytics visualizations.
 */

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
  const temporalNames = ['year', 'date', 'quarter', 'month', 'monthname', 'monthlabel', 'monthnum', 'period', 'day', 'time'];
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
  if (col.endsWith('USD') || col.endsWith('usd')) {
    const base = col.slice(0, -3).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return `${base} (USD)`;
  }
  return col
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
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

export function formatNumber(value: unknown, isCurrency = false): string {
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

export const CHART_PALETTE = [
  '#2563EB', '#0D9488', '#7C3AED', '#EA580C', '#0284C7',
  '#D97706', '#4F46E5', '#059669', '#DB2777', '#6366F1',
  '#0891B2', '#475569'
];

