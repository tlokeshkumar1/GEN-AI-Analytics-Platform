import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { DatasetItem } from '../../types/dataset';
import {
  AnalyticsDefinition,
  ExecutionResult,
  SemanticModel,
  SemanticField,
  executePlan,
  saveDefinition,
} from '../../services/semanticService';
import { AnalyticsWidget } from '../AnalyticsWidget';
import { invalidateDashboardCache } from '../../screens/ExecutiveDashboard';
import { getApiErrorMessage } from '../../services/api';

export interface DragDropWidget {
  id: string;
  title: string;
  kind: string;
  metric: string;
  aggregation: string;
  dimension?: string;
  datasetId?: string;
  result?: ExecutionResult | null;
  loading?: boolean;
  error?: string;
  isSaved?: boolean;
  isPublished?: boolean;
}

const AVAILABLE_CHART_TYPES = [
  { id: 'kpi', label: 'Stat KPI', icon: 'pin', desc: 'Summary aggregated metric number' },
  { id: 'bar', label: 'Bar Chart', icon: 'bar_chart', desc: 'Vertical column comparisons' },
  { id: 'horizontal_bar', label: 'H-Bar Chart', icon: 'align_horizontal_left', desc: 'Ranked horizontal breakdown' },
  { id: 'line', label: 'Line Trend', icon: 'show_chart', desc: 'Continuous time/order trend' },
  { id: 'area', label: 'Area Chart', icon: 'area_chart', desc: 'Volume progression over intervals' },
  { id: 'donut', label: 'Donut Chart', icon: 'donut_large', desc: 'Distribution with center total' },
  { id: 'pie', label: 'Pie Dist.', icon: 'pie_chart', desc: 'Proportional share slices' },
  { id: 'scatter', label: 'Scatter', icon: 'scatter_plot', desc: 'Correlation & distribution points' },
  { id: 'gauge', label: 'Gauge KPI', icon: 'speed', desc: 'Target & milestone dial' },
  { id: 'table', label: 'Data Table', icon: 'table_chart', desc: 'Tabular aggregated records' },
  { id: 'funnel', label: 'Funnel', icon: 'filter_alt', desc: 'Conversion progression' },
  { id: 'radar', label: 'Radar', icon: 'radar', desc: 'Multivariate radial comparison' },
];

const AGGREGATION_OPTIONS = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX'];

export interface DragDropDashboardBuilderProps {
  datasets: DatasetItem[];
  selectedDatasetId: string;
  onSwitchDataset: (id: string) => Promise<void>;
  model: SemanticModel | null;
  existingItems?: AnalyticsDefinition[];
  onSavedDefinition?: () => void;
  user?: { role?: string; roles?: string[] } | null;
}

export function DragDropDashboardBuilder({
  datasets,
  selectedDatasetId,
  onSwitchDataset,
  model,
  existingItems = [],
  onSavedDefinition,
}: DragDropDashboardBuilderProps) {
  const [dashboardTitle, setDashboardTitle] = useState('My Custom Interactive Dashboard');
  const [widgets, setWidgets] = useState<DragDropWidget[]>([]);
  const [fieldSearch, setFieldSearch] = useState('');
  const [activeDropTarget, setActiveDropTarget] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isPublishingAll, setIsPublishingAll] = useState(false);

  // Group fields into measures, dimensions, and temporal
  const fields = useMemo(() => model?.fields || [], [model]);
  const measures = useMemo(
    () => fields.filter(f => f.role === 'measure' || ['integer', 'decimal', 'float', 'number'].includes(f.type)),
    [fields]
  );
  const dimensions = useMemo(
    () => fields.filter(f => ['dimension', 'identifier'].includes(f.role) && !['integer', 'decimal'].includes(f.type)),
    [fields]
  );
  const temporalFields = useMemo(
    () => fields.filter(f => f.role === 'time' || ['date', 'datetime', 'timestamp'].includes(f.type)),
    [fields]
  );

  const filteredMeasures = useMemo(
    () => measures.filter(m => m.name.toLowerCase().includes(fieldSearch.toLowerCase()) || m.semantic_name.toLowerCase().includes(fieldSearch.toLowerCase())),
    [measures, fieldSearch]
  );
  const filteredDimensions = useMemo(
    () => dimensions.filter(d => d.name.toLowerCase().includes(fieldSearch.toLowerCase()) || d.semantic_name.toLowerCase().includes(fieldSearch.toLowerCase())),
    [dimensions, fieldSearch]
  );
  const filteredTemporal = useMemo(
    () => temporalFields.filter(t => t.name.toLowerCase().includes(fieldSearch.toLowerCase()) || t.semantic_name.toLowerCase().includes(fieldSearch.toLowerCase())),
    [temporalFields, fieldSearch]
  );

  // Initial starter widget when canvas is empty and model is available
  useEffect(() => {
    if (widgets.length === 0 && fields.length > 0) {
      const defaultMeasure = measures[0]?.name || fields[0]?.name || '*';
      const defaultDimension = dimensions[0]?.name || temporalFields[0]?.name || '';
      const starterId = `widget_${Date.now()}`;
      const starter: DragDropWidget = {
        id: starterId,
        title: `${defaultDimension ? `Breakdown by ${defaultDimension.replace(/_/g, ' ')}` : `Total ${defaultMeasure.replace(/_/g, ' ')}`}`,
        kind: defaultDimension ? 'bar' : 'kpi',
        metric: defaultMeasure,
        aggregation: 'SUM',
        dimension: defaultDimension || undefined,
        datasetId: selectedDatasetId,
      };
      setWidgets([starter]);
      void executeWidget(starter);
    }
  }, [selectedDatasetId, fields]);

  // Execute widget data plan
  const executeWidget = useCallback(
    async (widget: DragDropWidget) => {
      setWidgets(prev => prev.map(w => (w.id === widget.id ? { ...w, loading: true, error: undefined } : w)));
      try {
        const queryPlan: Record<string, unknown> = {
          metric: widget.metric || '*',
          aggregation: widget.aggregation || 'SUM',
          left_dataset_id: widget.datasetId || selectedDatasetId,
        };
        if (widget.dimension && widget.kind !== 'kpi') {
          queryPlan.dimension = widget.dimension;
        }

        const res = await executePlan(queryPlan, {
          'X-Dataset-Id': widget.datasetId || selectedDatasetId,
        });

        setWidgets(prev =>
          prev.map(w =>
            w.id === widget.id
              ? {
                  ...w,
                  result: res,
                  loading: false,
                  error: res.success ? undefined : res.error || 'Execution failed',
                }
              : w
          )
        );
      } catch (err) {
        setWidgets(prev =>
          prev.map(w =>
            w.id === widget.id
              ? {
                  ...w,
                  loading: false,
                  error: getApiErrorMessage(err, 'Failed to execute query for widget.'),
                }
              : w
          )
        );
      }
    },
    [selectedDatasetId]
  );

  // Add new widget
  const handleAddWidget = (kind: string = 'bar', targetMetric?: string, targetDimension?: string) => {
    const metric = targetMetric || measures[0]?.name || fields[0]?.name || '*';
    const dimension = targetDimension || (kind === 'kpi' ? undefined : (dimensions[0]?.name || temporalFields[0]?.name || undefined));
    const newWidget: DragDropWidget = {
      id: `widget_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title: `${kind === 'kpi' ? 'Key Metric' : 'Interactive'} - ${metric.replace(/_/g, ' ')}${dimension ? ` by ${dimension.replace(/_/g, ' ')}` : ''}`,
      kind,
      metric,
      aggregation: 'SUM',
      dimension,
      datasetId: selectedDatasetId,
    };

    setWidgets(prev => [...prev, newWidget]);
    void executeWidget(newWidget);
    setMessage(`Added new ${kind.toUpperCase()} widget to workspace.`);
  };

  // Add existing KPI
  const handleAddExistingKpi = (item: AnalyticsDefinition) => {
    const newWidget: DragDropWidget = {
      id: `widget_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      title: item.title,
      kind: item.kind,
      metric: String(item.query_plan?.metric || '*'),
      aggregation: String(item.query_plan?.aggregation || 'COUNT'),
      dimension: item.query_plan?.dimension ? String(item.query_plan.dimension) : undefined,
      datasetId: item.dataset_id || selectedDatasetId,
    };
    setWidgets(prev => [...prev, newWidget]);
    void executeWidget(newWidget);
    setMessage(`Added existing KPI "${item.title}" to canvas.`);
  };

  // Update widget properties
  const handleUpdateWidget = (id: string, updates: Partial<DragDropWidget>, autoExecute = true) => {
    let updatedWidget: DragDropWidget | undefined;
    setWidgets(prev => {
      const next = prev.map(w => {
        if (w.id === id) {
          updatedWidget = { ...w, ...updates };
          return updatedWidget;
        }
        return w;
      });
      return next;
    });

    if (autoExecute && updatedWidget) {
      void executeWidget(updatedWidget);
    }
  };

  // Remove widget
  const handleRemoveWidget = (id: string) => {
    setWidgets(prev => prev.filter(w => w.id !== id));
  };

  // Reorder widgets
  const handleMoveWidget = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= widgets.length) return;
    setWidgets(prev => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  };

  // Save single widget definition to platform
  const handleSaveWidgetDefinition = async (widget: DragDropWidget) => {
    try {
      const targetDataset = datasets.find(d => d.id === (widget.datasetId || selectedDatasetId)) || datasets[0];
      const item: AnalyticsDefinition = {
        id: `def_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        title: widget.title,
        kind: widget.kind,
        revision: 1,
        semantic_revision: model?.revision || 1,
        dataset_id: targetDataset?.id,
        dataset_name: targetDataset?.name,
        source_file: targetDataset?.name,
        explanation: `Created via Drag & Drop Dashboard Builder: ${widget.aggregation} of ${widget.metric}${widget.dimension ? ` by ${widget.dimension}` : ''}`,
        status: 'approved',
        query_plan: {
          metric: widget.metric,
          aggregation: widget.aggregation,
          dimension: widget.dimension,
          chart_type: widget.kind,
        },
        dependencies: [widget.metric, widget.dimension].filter(Boolean) as string[],
      };

      await saveDefinition(item);
      handleUpdateWidget(widget.id, { isSaved: true }, false);
      invalidateDashboardCache();
      onSavedDefinition?.();
      setMessage(`Saved definition "${widget.title}" to platform library.`);
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to save widget "${widget.title}".`));
    }
  };

  // Publish all widgets in canvas to Executive Dashboard
  const handlePublishAll = async () => {
    if (widgets.length === 0) return;
    setIsPublishingAll(true);
    try {
      const targetDataset = datasets.find(d => d.id === selectedDatasetId) || datasets[0];
      const modelRev = model?.revision || 1;
      const savePromises = widgets.map(w => {
        const item: AnalyticsDefinition = {
          id: `dragdrop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          title: w.title,
          kind: w.kind,
          revision: 1,
          semantic_revision: modelRev,
          dataset_id: targetDataset?.id,
          dataset_name: targetDataset?.name,
          source_file: targetDataset?.name,
          explanation: `Published from Drag & Drop Dashboard: "${dashboardTitle}"`,
          status: 'approved',
          query_plan: {
            metric: w.metric,
            aggregation: w.aggregation,
            dimension: w.dimension,
            chart_type: w.kind,
          },
          dependencies: [w.metric, w.dimension].filter(Boolean) as string[],
        };
        return saveDefinition(item);
      });

      await Promise.all(savePromises);
      invalidateDashboardCache();
      onSavedDefinition?.();
      setMessage(`Successfully published all ${widgets.length} widgets from "${dashboardTitle}" to Executive Dashboard!`);
      setWidgets(prev => prev.map(w => ({ ...w, isSaved: true, isPublished: true })));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to publish dashboard widgets.'));
    } finally {
      setIsPublishingAll(false);
    }
  };

  // Drag & drop handlers
  const handleDragStartField = (e: React.DragEvent, field: SemanticField) => {
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({
        type: 'field',
        field,
      })
    );
  };

  const handleDragStartChartType = (e: React.DragEvent, chartType: string) => {
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({
        type: 'chart_type',
        chartType,
      })
    );
  };

  const handleDragStartExistingKpi = (e: React.DragEvent, item: AnalyticsDefinition) => {
    e.dataTransfer.setData(
      'application/json',
      JSON.stringify({
        type: 'existing_kpi',
        item,
      })
    );
  };

  const handleCanvasDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setActiveDropTarget(null);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);

      if (data.type === 'field') {
        const f: SemanticField = data.field;
        if (f.role === 'measure') {
          handleAddWidget('kpi', f.name);
        } else {
          handleAddWidget('bar', undefined, f.name);
        }
      } else if (data.type === 'chart_type') {
        handleAddWidget(data.chartType);
      } else if (data.type === 'existing_kpi') {
        handleAddExistingKpi(data.item);
      }
    } catch {
      // Ignore invalid drag payload
    }
  };

  const handleWidgetMetricDrop = (e: React.DragEvent, widgetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveDropTarget(null);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.type === 'field') {
        const fieldName = data.field.name;
        handleUpdateWidget(widgetId, { metric: fieldName });
        setMessage(`Mapped metric to "${fieldName}".`);
      }
    } catch {
      // Ignore
    }
  };

  const handleWidgetDimensionDrop = (e: React.DragEvent, widgetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveDropTarget(null);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.type === 'field') {
        const fieldName = data.field.name;
        handleUpdateWidget(widgetId, { dimension: fieldName });
        setMessage(`Mapped grouping dimension to "${fieldName}".`);
      }
    } catch {
      // Ignore
    }
  };

  return (
    <div className="space-y-4">
      {/* Notifications */}
      {message && (
        <div className="p-3 rounded-[var(--radius-element)] bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] text-[var(--color-success)] text-xs flex items-center justify-between shadow-[var(--shadow-2xs)] animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            <span>{message}</span>
          </div>
          <button type="button" onClick={() => setMessage('')} className="hover:opacity-75 cursor-pointer">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 rounded-[var(--radius-element)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-[var(--color-danger)] text-xs flex items-center justify-between shadow-[var(--shadow-2xs)] animate-in fade-in">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">error</span>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError('')} className="hover:opacity-75 cursor-pointer">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      {/* Main Drag-and-Drop Workspace Grid (Source Palette Left, Workspace Canvas Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT PALETTE: Datasets, Fields, Chart Types, and Existing KPIs */}
        <div className="lg:col-span-4 space-y-4">
          {/* Active Dataset Scope */}
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">database</span>
                <span>Active Dataset Source</span>
              </label>
              <span className="text-[10px] font-mono text-[var(--color-text-muted)]">
                {fields.length} fields loaded
              </span>
            </div>
            <select
              className="w-full border border-[var(--color-border)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] font-medium focus:outline-none focus:border-[var(--color-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
              value={selectedDatasetId}
              onChange={e => void onSwitchDataset(e.target.value)}
            >
              {datasets.map(d => (
                <option key={d.id} value={d.id}>
                  📊 {d.tableName || d.displayName || d.name} ({d.rowCount?.toLocaleString() || 0} rows)
                </option>
              ))}
            </select>
          </div>

          {/* Draggable Fields Library */}
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--color-border)]">
              <div>
                <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">drag_indicator</span>
                  <span>Data Fields Palette</span>
                </h3>
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  Drag fields onto the canvas or into widget mapping zones
                </p>
              </div>
            </div>

            {/* Field Search */}
            <div className="relative">
              <input
                type="text"
                placeholder="Search measures & dimensions…"
                value={fieldSearch}
                onChange={e => setFieldSearch(e.target.value)}
                className="w-full bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-all"
              />
              {fieldSearch && (
                <button
                  type="button"
                  onClick={() => setFieldSearch('')}
                  className="absolute right-2 top-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              )}
            </div>

            {/* Measures (Metrics) Section */}
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px] text-[var(--color-primary)]">tag</span>
                <span>Numeric Measures ({filteredMeasures.length})</span>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                {filteredMeasures.length === 0 ? (
                  <span className="text-[11px] text-[var(--color-text-muted)] italic">No matching measures</span>
                ) : (
                  filteredMeasures.map(m => (
                    <div
                      key={m.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, m)}
                      onClick={() => handleAddWidget('kpi', m.name)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-element)] bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20 text-[11px] font-medium cursor-grab active:cursor-grabbing hover:bg-[var(--color-primary)]/20 transition-all select-none shadow-[var(--shadow-2xs)]"
                      title="Drag to widget or click to create KPI"
                    >
                      <span className="material-symbols-outlined text-[12px]">drag_indicator</span>
                      <span className="truncate max-w-[120px]">{m.semantic_name || m.name}</span>
                      <span className="text-[9px] font-mono opacity-70">#</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Dimensions (Categories) Section */}
            <div>
              <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px] text-amber-500">category</span>
                <span>Categorical Dimensions ({filteredDimensions.length})</span>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                {filteredDimensions.length === 0 ? (
                  <span className="text-[11px] text-[var(--color-text-muted)] italic">No matching dimensions</span>
                ) : (
                  filteredDimensions.map(d => (
                    <div
                      key={d.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, d)}
                      onClick={() => handleAddWidget('bar', undefined, d.name)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 hover:text-[var(--color-text-primary)] text-[11px] font-medium cursor-grab active:cursor-grabbing transition-all select-none shadow-[var(--shadow-2xs)]"
                      title="Drag to widget or click to create Chart"
                    >
                      <span className="material-symbols-outlined text-[12px]">drag_indicator</span>
                      <span className="truncate max-w-[120px]">{d.semantic_name || d.name}</span>
                      <span className="text-[9px] font-mono opacity-70">Aa</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Temporal / Date Fields */}
            {filteredTemporal.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <span className="material-symbols-outlined text-[12px] text-blue-500">calendar_today</span>
                  <span>Time &amp; Dates ({filteredTemporal.length})</span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-[100px] overflow-y-auto pr-1">
                  {filteredTemporal.map(t => (
                    <div
                      key={t.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, t)}
                      onClick={() => handleAddWidget('line', undefined, t.name)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-element)] bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-[11px] font-medium cursor-grab active:cursor-grabbing hover:bg-blue-500/20 transition-all select-none shadow-[var(--shadow-2xs)]"
                      title="Drag to widget or click to create Line Trend"
                    >
                      <span className="material-symbols-outlined text-[12px]">drag_indicator</span>
                      <span className="truncate max-w-[120px]">{t.semantic_name || t.name}</span>
                      <span className="text-[9px] font-mono opacity-70">📅</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Draggable Chart Types Palette */}
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--color-border)]">
              <div>
                <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">grid_view</span>
                  <span>Chart Types Library</span>
                </h3>
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  Drag any visualization style directly into the workspace canvas
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {AVAILABLE_CHART_TYPES.map(type => (
                <div
                  key={type.id}
                  draggable
                  onDragStart={e => handleDragStartChartType(e, type.id)}
                  onClick={() => handleAddWidget(type.id)}
                  className="flex items-center justify-between p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-primary)]/40 transition-all cursor-grab active:cursor-grabbing select-none group shadow-[var(--shadow-2xs)]"
                  title={`${type.desc} (Click or drag to add)`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)] group-hover:scale-110 transition-transform">
                      {type.icon}
                    </span>
                    <span className="text-xs font-medium text-[var(--color-text-primary)] truncate">
                      {type.label}
                    </span>
                  </div>
                  <span className="material-symbols-outlined text-[14px] text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors">
                    add
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Existing Saved KPIs / Metrics Palette */}
          {existingItems.length > 0 && (
            <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-2.5">
              <div className="flex items-center justify-between pb-2 border-b border-[var(--color-border)]">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-[var(--color-success)]">check_circle</span>
                    <span>Saved Platform KPIs</span>
                  </h3>
                  <p className="text-[10px] text-[var(--color-text-muted)]">
                    Drag existing KPIs into this dashboard canvas
                  </p>
                </div>
                <span className="text-[10px] font-mono text-[var(--color-text-muted)]">
                  {existingItems.length}
                </span>
              </div>

              <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                {existingItems.slice(0, 10).map(item => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={e => handleDragStartExistingKpi(e, item)}
                    onClick={() => handleAddExistingKpi(item)}
                    className="p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] hover:border-[var(--color-primary)]/40 transition-all cursor-grab active:cursor-grabbing select-none flex items-center justify-between text-xs"
                    title="Click or drag to add to canvas"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">
                        {item.kind === 'kpi' ? 'pin' : 'bar_chart'}
                      </span>
                      <span className="font-medium text-[var(--color-text-primary)] truncate max-w-[150px]">
                        {item.title}
                      </span>
                    </div>
                    <span className="text-[9px] font-mono uppercase bg-[var(--color-surface)] px-1 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">
                      {item.kind}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT CENTER: Interactive Dashboard Canvas & Drag-and-Drop Workspace */}
        <div className="lg:col-span-8 space-y-4">
          {/* Dashboard Canvas Header Bar */}
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] flex flex-wrap items-center justify-between gap-3">
            <div className="flex-1 min-w-[240px]">
              <input
                type="text"
                value={dashboardTitle}
                onChange={e => setDashboardTitle(e.target.value)}
                className="text-base font-semibold text-[var(--color-text-primary)] bg-transparent border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-primary)] transition-all outline-none w-full"
                title="Click to edit dashboard title"
              />
              <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                Drag datasets, fields, or chart styles from the left palette to build this dashboard.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-hover)] px-2 py-1 rounded border border-[var(--color-border)]">
                {widgets.length} {widgets.length === 1 ? 'widget' : 'widgets'}
              </span>

              <button
                type="button"
                onClick={() => handleAddWidget('kpi')}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] text-xs font-medium text-[var(--color-text-primary)] border border-[var(--color-border)] transition-colors cursor-pointer"
                title="Add a new blank widget"
              >
                <span className="material-symbols-outlined text-[15px]">add</span>
                <span>Add Widget</span>
              </button>

              {widgets.length > 0 && (
                <button
                  type="button"
                  onClick={() => setWidgets([])}
                  className="px-2.5 py-1.5 rounded-[var(--radius-element)] text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)]/10 transition-colors cursor-pointer"
                  title="Clear all widgets from canvas"
                >
                  Clear Canvas
                </button>
              )}

              <button
                type="button"
                disabled={widgets.length === 0 || isPublishingAll}
                onClick={() => void handlePublishAll()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-success)] hover:opacity-90 text-white font-medium text-xs shadow-[var(--shadow-2xs)] active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
              >
                <span className={`material-symbols-outlined text-[16px] ${isPublishingAll ? 'animate-spin' : ''}`}>
                  {isPublishingAll ? 'sync' : 'publish'}
                </span>
                <span>{isPublishingAll ? 'Publishing…' : 'Publish Dashboard'}</span>
              </button>
            </div>
          </div>

          {/* Interactive Workspace Canvas Container (Drop Target Zone) */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setActiveDropTarget('canvas');
            }}
            onDragLeave={() => setActiveDropTarget(null)}
            onDrop={handleCanvasDrop}
            className={`min-h-[460px] p-4 rounded-[var(--radius-container)] border-2 border-dashed transition-all space-y-4 ${
              activeDropTarget === 'canvas'
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/5 ring-4 ring-[var(--color-primary)]/10'
                : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]/40'
            }`}
          >
            {widgets.length === 0 ? (
              /* Empty Canvas State with Drop Callout */
              <div className="h-[380px] flex flex-col items-center justify-center text-center p-6 space-y-3">
                <div className="w-16 h-16 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-primary)] shadow-[var(--shadow-sm)]">
                  <span className="material-symbols-outlined text-3xl">drag_pan</span>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                    Your Dashboard Canvas is Empty
                  </h4>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1 max-w-md">
                    Drag any metric, dimension, or chart type from the left palette and drop it here to start building your live dashboard.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => handleAddWidget('kpi')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 text-xs font-medium text-[var(--color-text-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
                  >
                    <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">pin</span>
                    <span>+ Add KPI Card</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddWidget('bar')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 text-xs font-medium text-[var(--color-text-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
                  >
                    <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">bar_chart</span>
                    <span>+ Add Bar Chart</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddWidget('line')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 text-xs font-medium text-[var(--color-text-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
                  >
                    <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">show_chart</span>
                    <span>+ Add Line Trend</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAddWidget('donut')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 text-xs font-medium text-[var(--color-text-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
                  >
                    <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">donut_large</span>
                    <span>+ Add Donut Chart</span>
                  </button>
                </div>
              </div>
            ) : (
              /* Populated Canvas Grid with Interactive Widget Cards */
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {widgets.map((widget, idx) => {
                  const widgetDef: AnalyticsDefinition = {
                    id: widget.id,
                    title: widget.title,
                    kind: widget.kind,
                    revision: 1,
                    status: 'approved',
                    query_plan: {
                      metric: widget.metric,
                      aggregation: widget.aggregation,
                      dimension: widget.dimension,
                      chart_type: widget.kind,
                    },
                    dependencies: [widget.metric, widget.dimension].filter(Boolean) as string[],
                  };

                  return (
                    <div
                      key={widget.id}
                      className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-3.5 hover:border-[var(--color-primary)]/40 transition-all flex flex-col justify-between"
                    >
                      {/* Widget Header & Controls */}
                      <div className="space-y-2 pb-2 border-b border-[var(--color-border)]">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)] shrink-0">
                              {AVAILABLE_CHART_TYPES.find(t => t.id === widget.kind)?.icon || 'bar_chart'}
                            </span>
                            <input
                              type="text"
                              value={widget.title}
                              onChange={e => handleUpdateWidget(widget.id, { title: e.target.value }, false)}
                              className="text-xs font-semibold text-[var(--color-text-primary)] bg-transparent border-b border-transparent hover:border-[var(--color-border)] focus:border-[var(--color-primary)] outline-none truncate w-full"
                              title="Click to rename widget"
                            />
                          </div>

                          {/* Reordering & Remove Buttons */}
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => handleMoveWidget(idx, 'up')}
                              className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-20 cursor-pointer"
                              title="Move up"
                            >
                              <span className="material-symbols-outlined text-[14px]">arrow_upward</span>
                            </button>
                            <button
                              type="button"
                              disabled={idx === widgets.length - 1}
                              onClick={() => handleMoveWidget(idx, 'down')}
                              className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-20 cursor-pointer"
                              title="Move down"
                            >
                              <span className="material-symbols-outlined text-[14px]">arrow_downward</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveWidget(widget.id)}
                              className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)]/20 cursor-pointer"
                              title="Remove widget"
                            >
                              <span className="material-symbols-outlined text-[14px]">close</span>
                            </button>
                          </div>
                        </div>

                        {/* Chart Style Switcher Dropdown */}
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-[10px] text-[var(--color-text-muted)] font-mono">Style:</span>
                          <select
                            value={widget.kind}
                            onChange={e => handleUpdateWidget(widget.id, { kind: e.target.value })}
                            className="bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)] px-2 py-0.5 text-[11px] text-[var(--color-text-primary)] font-medium focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
                          >
                            {AVAILABLE_CHART_TYPES.map(t => (
                              <option key={t.id} value={t.id}>
                                {t.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* FIELD MAPPING DROP ZONES (Metric & Dimension) */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {/* Metric (Y-Axis / Value) Drop Target */}
                        <div
                          onDragOver={e => {
                            e.preventDefault();
                            setActiveDropTarget(`metric_${widget.id}`);
                          }}
                          onDragLeave={() => setActiveDropTarget(null)}
                          onDrop={e => handleWidgetMetricDrop(e, widget.id)}
                          className={`p-2 rounded-[var(--radius-element)] border border-dashed transition-all ${
                            activeDropTarget === `metric_${widget.id}`
                              ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                              : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]/60'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)] font-mono mb-1">
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-[12px] text-[var(--color-primary)]">tune</span>
                              <span>Target Measure</span>
                            </span>
                            <select
                              value={widget.aggregation}
                              onChange={e => handleUpdateWidget(widget.id, { aggregation: e.target.value })}
                              className="bg-transparent border-0 font-bold text-[var(--color-primary)] text-[10px] uppercase outline-none cursor-pointer"
                            >
                              {AGGREGATION_OPTIONS.map(agg => (
                                <option key={agg} value={agg}>
                                  {agg}
                                </option>
                              ))}
                            </select>
                          </div>
                          <select
                            value={widget.metric}
                            onChange={e => handleUpdateWidget(widget.id, { metric: e.target.value })}
                            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-primary)] outline-none cursor-pointer truncate"
                          >
                            <option value="*">* (All Records)</option>
                            {measures.map(m => (
                              <option key={m.name} value={m.name}>
                                {m.semantic_name || m.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Dimension (X-Axis / Grouping) Drop Target */}
                        <div
                          onDragOver={e => {
                            e.preventDefault();
                            setActiveDropTarget(`dim_${widget.id}`);
                          }}
                          onDragLeave={() => setActiveDropTarget(null)}
                          onDrop={e => handleWidgetDimensionDrop(e, widget.id)}
                          className={`p-2 rounded-[var(--radius-element)] border border-dashed transition-all ${
                            activeDropTarget === `dim_${widget.id}`
                              ? 'border-amber-500 bg-amber-500/10'
                              : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]/60'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[10px] text-[var(--color-text-muted)] font-mono mb-1">
                            <span className="flex items-center gap-1">
                              <span className="material-symbols-outlined text-[12px] text-amber-500">group_work</span>
                              <span>Group Dimension</span>
                            </span>
                          </div>
                          <select
                            value={widget.dimension || ''}
                            onChange={e => handleUpdateWidget(widget.id, { dimension: e.target.value || undefined })}
                            className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-primary)] outline-none cursor-pointer truncate"
                          >
                            <option value="">(None - Single Metric Value)</option>
                            {dimensions.concat(temporalFields).map(d => (
                              <option key={d.name} value={d.name}>
                                {d.semantic_name || d.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* LIVE VISUALIZATION PREVIEW RENDER */}
                      <div className="min-h-[180px] flex flex-col justify-center bg-[var(--color-surface)] rounded-[var(--radius-element)] border border-[var(--color-border)]/50 p-2 overflow-hidden">
                        {widget.loading ? (
                          <div className="flex flex-col items-center justify-center py-8 text-xs text-[var(--color-text-muted)] gap-2">
                            <span className="material-symbols-outlined text-2xl animate-spin text-[var(--color-primary)]">progress_activity</span>
                            <span>Calculating visualization…</span>
                          </div>
                        ) : widget.error ? (
                          <div className="p-3 text-xs text-[var(--color-danger)] bg-[var(--color-danger-subtle)]/10 rounded border border-[var(--color-danger-border)]">
                            {widget.error}
                          </div>
                        ) : widget.result && widget.result.success && widget.result.data ? (
                          <AnalyticsWidget definition={widgetDef} result={widget.result} isDashboard={true} showTable={false} />
                        ) : (
                          <div className="text-center py-6 text-xs text-[var(--color-text-muted)]">
                            No data calculated yet. Select a measure or dimension above.
                          </div>
                        )}
                      </div>

                      {/* Widget Actions (Save Proposal & Publish) */}
                      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)] text-xs">
                        <button
                          type="button"
                          onClick={() => void handleSaveWidgetDefinition(widget)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            {widget.isSaved ? 'bookmark_added' : 'bookmark_add'}
                          </span>
                          <span>{widget.isSaved ? 'Saved in Library' : 'Save Definition'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void executeWidget(widget)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-primary)] hover:underline cursor-pointer"
                          title="Recalculate visualization"
                        >
                          <span className="material-symbols-outlined text-[14px]">refresh</span>
                          <span>Refresh</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
