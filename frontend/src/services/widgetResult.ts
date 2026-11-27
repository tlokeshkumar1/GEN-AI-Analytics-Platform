import type { AnalyticsDefinition, ExecutionResult } from './semanticService';

export function hasUsableWidgetResult(definition: AnalyticsDefinition, result: ExecutionResult): boolean {
  if (!result.success || !Array.isArray(result.data) || !result.data.length) return false;
  if (definition.kind === 'table') return true;
  const measures = (definition.query_plan?.measures as { field: string; alias?: string }[] | undefined)?.map(m => m.alias || m.field)
    || [String(definition.query_plan?.metric || 'value')];
  const columns = Object.keys(result.data[0]);
  const key = 'value' in result.data[0] ? 'value' : measures.find(name => name in result.data[0]) || columns[columns.length - 1];
  const values = result.data.map(row => row[key] == null || row[key] === '' ? NaN : Number(row[key]));
  if (!values.some(Number.isFinite)) return false;
  if (definition.kind === 'gauge' || definition.kind === 'kpi') return Number.isFinite(values[0]);
  if (definition.kind === 'pie' || definition.kind === 'donut') return values.every(v => Number.isFinite(v) && v >= 0) && values.reduce((a, b) => a + b, 0) > 0;
  if (definition.kind === 'radar') return values.length >= 3 && values.every(Number.isFinite);
  return true;
}
