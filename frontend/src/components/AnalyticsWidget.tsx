import React, { useMemo } from 'react';
import { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';
import {
  parseTemporalSortKey,
  isTemporalColumn,
  humanizeColumnName,
  formatTableCell,
  formatNumber,
} from './charts/chartUtils';
import { DataTableWidget } from './charts/DataTableWidget';
import { PieDonutChart } from './charts/PieDonutChart';
import { GaugeChart } from './charts/GaugeChart';
import { FunnelChart } from './charts/FunnelChart';
import { RadarChart } from './charts/RadarChart';
import { HorizontalBarChart } from './charts/HorizontalBarChart';
import { CartesianChart } from './charts/CartesianChart';

// Re-export utilities so existing callers and test suites maintain 100% backwards compatibility
export {
  parseTemporalSortKey,
  isTemporalColumn,
  humanizeColumnName,
  formatTableCell,
  formatNumber,
};

export interface AnalyticsWidgetProps {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  showTable?: boolean;
  isDashboard?: boolean;
}

export function AnalyticsWidget({
  definition,
  result,
  showTable = true,
  isDashboard = false,
}: AnalyticsWidgetProps) {
  if (!result.success) {
    return <p role="alert" className="text-red-700">{result.error || 'Execution failed.'}</p>;
  }

  if (!result.data || !result.data.length) {
    return <p className="text-slate-500">No matching records.</p>;
  }

  const rawRows = result.data;
  const columns = Object.keys(rawRows[0]);
  const measures = (definition.query_plan?.measures as { field: string; alias?: string }[] | undefined)?.map(m => m.alias || m.field)
    || [String(definition.query_plan?.metric || 'value')];
  const valueKey = 'value' in rawRows[0] ? 'value' : measures.find(key => key in rawRows[0]) || columns[columns.length - 1];
  const labelKey = columns.find(key => key !== valueKey && !measures.includes(key)) || columns[0];

  const rows = useMemo(() => {
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
  const low = Math.min(0, ...finite);
  const high = Math.max(0, ...finite);

  const isCurrencyMetric = /usd|revenue|margin|price|cost|sales|amount/i.test(valueKey) ||
    /usd|revenue|margin|price|cost|sales|amount/i.test(definition.title);

  return (
    <div className="space-y-4">
      {definition.kind === 'kpi' ? (
        <div className="flex items-baseline gap-3 py-2">
          <p className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900 tabular-nums">
            {String(result.summary?.formatted_value || formatTableCell(rows[0][valueKey] ?? 'N/A', valueKey).display)}
          </p>
        </div>
      ) : (definition.kind === 'pie' || definition.kind === 'donut') ? (
        <PieDonutChart
          kind={definition.kind}
          title={definition.title}
          rows={rows}
          values={values}
          labelKey={labelKey}
          valueKey={valueKey}
          isCurrencyMetric={isCurrencyMetric}
        />
      ) : definition.kind === 'gauge' ? (
        <GaugeChart
          title={definition.title}
          rows={rows}
          values={values}
          labelKey={labelKey}
          valueKey={valueKey}
          isCurrencyMetric={isCurrencyMetric}
        />
      ) : definition.kind === 'funnel' ? (
        <FunnelChart
          title={definition.title}
          rows={rows}
          labelKey={labelKey}
          valueKey={valueKey}
        />
      ) : definition.kind === 'radar' ? (
        <RadarChart
          title={definition.title}
          rows={rows}
          labelKey={labelKey}
          valueKey={valueKey}
        />
      ) : definition.kind === 'horizontal_bar' ? (
        <HorizontalBarChart
          title={definition.title}
          rows={rows}
          values={values}
          labelKey={labelKey}
          valueKey={valueKey}
          high={high}
          low={low}
          isCurrencyMetric={isCurrencyMetric}
        />
      ) : (
        definition.kind !== 'table' && finite.length > 0 && (
          <CartesianChart
            kind={definition.kind}
            title={definition.title}
            rows={rows}
            values={values}
            columns={columns}
            measures={measures}
            labelKey={labelKey}
            valueKey={valueKey}
            high={high}
            low={low}
            isCurrencyMetric={isCurrencyMetric}
          />
        )
      )}

      {/* Show table only when requested or if kind is table */}
      {(definition.kind === 'table' || (definition.kind !== 'kpi' && showTable)) && (
        <DataTableWidget columns={columns} rows={rows} />
      )}

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
