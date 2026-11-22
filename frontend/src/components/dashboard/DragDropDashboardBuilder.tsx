import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { DatasetItem } from '../../types/dataset';
import {
  AnalyticsDefinition,
  ExecutionResult,
  SemanticModel,
  SemanticField,
  executePlan,
  saveDefinition,
  getDashboardPublication,
} from '../../services/semanticService';
import { AnalyticsWidget } from '../AnalyticsWidget';
import { invalidateDashboardCache } from '../../screens/ExecutiveDashboard';
import { getApiErrorMessage } from '../../services/api';
import api from '../../services/api';

export interface ChartTypeOption {
  id: string;
  label: string;
  icon: string;
  desc: string;
  category: 'chart' | 'kpi';
}

const AVAILABLE_CHART_TYPES: ChartTypeOption[] = [
  // Core Charts
  { id: 'bar', label: 'Bar Chart', icon: 'bar_chart', desc: 'Vertical column comparisons across categories', category: 'chart' },
  { id: 'horizontal_bar', label: 'H-Bar Chart', icon: 'align_horizontal_left', desc: 'Horizontal ranked comparison across categories', category: 'chart' },
  { id: 'line', label: 'Line Trend', icon: 'show_chart', desc: 'Continuous time-series or sequential trend', category: 'chart' },
  { id: 'area', label: 'Area Chart', icon: 'area_chart', desc: 'Volume progression and cumulative totals', category: 'chart' },
  { id: 'donut', label: 'Donut Chart', icon: 'donut_large', desc: 'Proportional distribution with center total', category: 'chart' },
  { id: 'pie', label: 'Pie Dist.', icon: 'pie_chart', desc: 'Proportional share breakdown across segments', category: 'chart' },
  { id: 'scatter', label: 'Scatter Plot', icon: 'scatter_plot', desc: 'Correlation between two numerical dimensions', category: 'chart' },
  { id: 'table', label: 'Data Table', icon: 'table_chart', desc: 'Aggregated tabular records and metrics', category: 'chart' },
  { id: 'funnel', label: 'Funnel', icon: 'filter_alt', desc: 'Stage conversion and drop-off progression', category: 'chart' },
  { id: 'radar', label: 'Radar', icon: 'radar', desc: 'Multivariate radial comparison across dimensions', category: 'chart' },
  // KPIs
  { id: 'kpi', label: 'Stat KPI', icon: 'pin', desc: 'Single aggregated executive metric scorecard', category: 'kpi' },
  { id: 'gauge', label: 'Gauge KPI', icon: 'speed', desc: 'Radial progress indicator against target', category: 'kpi' },
];

const AGGREGATION_OPTIONS = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MIN', 'MAX'];

interface DropzoneConfig {
  zone1Title: string;
  zone1Desc: string;
  zone1Icon: string;
  zone2Title: string;
  zone2Desc: string;
  zone2Icon: string;
}

const getDropzoneConfig = (kind: string): DropzoneConfig => {
  switch (kind) {
    case 'bar':
    case 'horizontal_bar':
    case 'line':
    case 'area':
    case 'scatter':
      return {
        zone1Title: 'X-Axis / Category Dimension',
        zone1Desc: 'Drop a dimension, category, or date field here',
        zone1Icon: 'view_column',
        zone2Title: 'Y-Axis / Metric Measure',
        zone2Desc: 'Drop a numeric measure or metric to calculate here',
        zone2Icon: 'bar_chart',
      };
    case 'donut':
    case 'pie':
    case 'funnel':
    case 'radar':
      return {
        zone1Title: 'Slice / Segment Dimension',
        zone1Desc: 'Drop a category or segment dimension here',
        zone1Icon: 'pie_chart',
        zone2Title: 'Value / Numeric Measure',
        zone2Desc: 'Drop numeric measure or volume here',
        zone2Icon: 'tag',
      };
    case 'kpi':
    case 'gauge':
      return {
        zone1Title: 'Target Measure (Primary Metric)',
        zone1Desc: 'Drop primary numeric measure (or * for count) here',
        zone1Icon: 'pin',
        zone2Title: 'Group Dimension (Secondary Context)',
        zone2Desc: 'Drop grouping dimension or status category here',
        zone2Icon: 'category',
      };
    case 'table':
      return {
        zone1Title: 'Row Group Dimension',
        zone1Desc: 'Drop primary category or identifier field here',
        zone1Icon: 'table_rows',
        zone2Title: 'Column Value Measure',
        zone2Desc: 'Drop numeric measure to aggregate here',
        zone2Icon: 'table_chart',
      };
    default:
      return {
        zone1Title: 'X-Axis / Dimension',
        zone1Desc: 'Drop a dimension field here',
        zone1Icon: 'view_column',
        zone2Title: 'Y-Axis / Measure',
        zone2Desc: 'Drop a measure field here',
        zone2Icon: 'tag',
      };
  }
};

export interface CreatedWidgetDraft {
  id: string;
  title: string;
  kind: string;
  metric: string;
  aggregation: string;
  dimension?: string;
  datasetId?: string;
  result: ExecutionResult;
  isPublished: boolean;
}

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
  onSavedDefinition,
}: DragDropDashboardBuilderProps) {
  const [dashboardTitle, setDashboardTitle] = useState('My Custom Interactive Dashboard');
  const [selectedChartType, setSelectedChartType] = useState<ChartTypeOption | null>(null);
  const [field1, setField1] = useState<SemanticField | null>(null);
  const [field2, setField2] = useState<SemanticField | null>(null);
  const [aggregation, setAggregation] = useState<string>('SUM');
  const [customTitle, setCustomTitle] = useState<string>('');

  const [createdWidget, setCreatedWidget] = useState<CreatedWidgetDraft | null>(null);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isPublishing, setIsPublishing] = useState<boolean>(false);

  const [activeDropTarget, setActiveDropTarget] = useState<'canvas' | 'field1' | 'field2' | null>(null);
  const [fieldSearch, setFieldSearch] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [error, setError] = useState<string>('');

  // Extract fields from current active semantic model
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
    () => measures.filter(m => (m.name || '').toLowerCase().includes(fieldSearch.toLowerCase()) || (m.semantic_name || '').toLowerCase().includes(fieldSearch.toLowerCase())),
    [measures, fieldSearch]
  );
  const filteredDimensions = useMemo(
    () => dimensions.filter(d => (d.name || '').toLowerCase().includes(fieldSearch.toLowerCase()) || (d.semantic_name || '').toLowerCase().includes(fieldSearch.toLowerCase())),
    [dimensions, fieldSearch]
  );
  const filteredTemporal = useMemo(
    () => temporalFields.filter(t => (t.name || '').toLowerCase().includes(fieldSearch.toLowerCase()) || (t.semantic_name || '').toLowerCase().includes(fieldSearch.toLowerCase())),
    [temporalFields, fieldSearch]
  );

  // When active dataset changes, reset field selections if they no longer exist in new model
  useEffect(() => {
    if (field1 && !fields.some(f => f.name === field1.name)) {
      setField1(null);
    }
    if (field2 && !fields.some(f => f.name === field2.name)) {
      setField2(null);
    }
  }, [fields]);

  const dropzoneConfig = useMemo(
    () => (selectedChartType ? getDropzoneConfig(selectedChartType.id) : null),
    [selectedChartType]
  );

  const isConfigComplete = Boolean(selectedChartType && field1 && field2);

  // Step 1: Handle Selecting Chart Type or KPI
  const handleSelectChartType = (opt: ChartTypeOption) => {
    setSelectedChartType(opt);
    setCreatedWidget(null);
    setError('');
    // Auto-adjust default aggregation: if count-based or general
    if (opt.id === 'kpi' && !aggregation) {
      setAggregation('SUM');
    }
  };

  // Step 2: Handle Field Drop or Assignment
  const handleAssignField = (field: SemanticField, targetZone?: 'field1' | 'field2') => {
    if (!selectedChartType) {
      setError('Please select or drag a chart type or KPI first from the left panel.');
      return;
    }

    if (targetZone === 'field1') {
      setField1(field);
    } else if (targetZone === 'field2') {
      setField2(field);
    } else {
      // Auto-assign to first empty zone
      if (!field1) {
        setField1(field);
      } else if (!field2) {
        setField2(field);
      } else {
        // Both full: replace zone 2
        setField2(field);
      }
    }
  };

  // Drag handlers
  const handleDragStartChartType = (e: React.DragEvent, chartType: ChartTypeOption) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'chart_type', chartType }));
  };

  const handleDragStartField = (e: React.DragEvent, field: SemanticField) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ type: 'field', field }));
  };

  const handleDropCanvas = (e: React.DragEvent) => {
    e.preventDefault();
    setActiveDropTarget(null);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.type === 'chart_type' && data.chartType) {
        handleSelectChartType(data.chartType);
      }
    } catch {
      // Ignore invalid drag
    }
  };

  const handleDropFieldZone = (e: React.DragEvent, zone: 'field1' | 'field2') => {
    e.preventDefault();
    e.stopPropagation();
    setActiveDropTarget(null);
    try {
      const dataStr = e.dataTransfer.getData('application/json');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.type === 'field' && data.field) {
        handleAssignField(data.field, zone);
      }
    } catch {
      // Ignore
    }
  };

  // Step 4: Create the Widget
  const handleCreateWidget = async () => {
    if (!selectedChartType || !field1 || !field2) {
      setError('Please select a chart type and place both required data fields before creating a widget.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setMessage('');

    try {
      // Intelligently assign dimension and metric based on field roles
      let dimensionField = field1;
      let metricField = field2;

      // If user put measure in zone 1 and dimension in zone 2 for a chart, align correctly
      if (field1.role === 'measure' && field2.role !== 'measure' && selectedChartType.category === 'chart') {
        metricField = field1;
        dimensionField = field2;
      }

      const queryPlan: Record<string, unknown> = {
        metric: metricField.name || '*',
        aggregation: aggregation || 'SUM',
        left_dataset_id: selectedDatasetId,
        dimension: dimensionField.name,
        chart_type: selectedChartType.id,
      };

      const res = await executePlan(queryPlan, {
        'X-Dataset-Id': selectedDatasetId,
      });

      const title = customTitle.trim() || `${selectedChartType.label}: ${metricField.semantic_name || metricField.name} by ${dimensionField.semantic_name || dimensionField.name}`;

      setCreatedWidget({
        id: `widget_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        title,
        kind: selectedChartType.id,
        metric: metricField.name,
        aggregation: aggregation || 'SUM',
        dimension: dimensionField.name,
        datasetId: selectedDatasetId,
        result: res,
        isPublished: false,
      });
      setMessage(`Successfully created ${selectedChartType.label} widget! Review your interactive preview below.`);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to execute query for widget.'));
    } finally {
      setIsGenerating(false);
    }
  };

  // Step 5: Publish the Widget (Appends to existing published widgets)
  const handlePublishWidget = async () => {
    if (!createdWidget) return;
    setIsPublishing(true);
    setError('');
    setMessage('');

    try {
      const targetDataset = datasets.find(d => d.id === selectedDatasetId) || datasets[0];
      const modelRev = model?.revision || 1;

      const item: AnalyticsDefinition = {
        id: `dragdrop_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        title: createdWidget.title,
        kind: createdWidget.kind,
        revision: 1,
        semantic_revision: modelRev,
        dataset_id: targetDataset?.id,
        dataset_name: targetDataset?.name,
        source_file: targetDataset?.name,
        explanation: `Created via Select Drag & Drop: ${createdWidget.aggregation} of ${createdWidget.metric}${createdWidget.dimension ? ` by ${createdWidget.dimension}` : ''}`,
        status: 'approved',
        query_plan: {
          metric: createdWidget.metric,
          aggregation: createdWidget.aggregation,
          dimension: createdWidget.dimension,
          chart_type: createdWidget.kind,
        },
        dependencies: [createdWidget.metric, createdWidget.dimension].filter(Boolean) as string[],
      };

      // 1. Save new definition to platform
      await saveDefinition(item);

      // 2. Fetch existing published widgets to append, NEVER removing existing ones!
      const currentPub = await getDashboardPublication(true).catch(() => ({ title: '', items: [], status: 'unpublished' }));
      const existingItems: Array<{ id: string; revision: number }> = (currentPub as any)?.items || [];

      // Merge and deduplicate by id and revision
      const mergedList = [...existingItems, { id: item.id, revision: item.revision }];
      const uniqueItems = Array.from(new Map(mergedList.map(it => [`${it.id}:${it.revision}`, it])).values());

      // 3. Publish merged catalog to Executive Dashboard
      await api.post('/insights/dashboard', {
        title: 'Executive Analytics Dashboard',
        items: uniqueItems,
      });

      invalidateDashboardCache();
      window.dispatchEvent(new Event('dashboard_updated'));
      onSavedDefinition?.();

      setCreatedWidget(prev => (prev ? { ...prev, isPublished: true } : null));
      setMessage(`Successfully published "${item.title}" to the Executive Dashboard! Added alongside ${existingItems.length} existing published widget(s).`);
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to publish widget "${createdWidget.title}".`));
    } finally {
      setIsPublishing(false);
    }
  };

  const handleResetWorkflow = () => {
    setSelectedChartType(null);
    setField1(null);
    setField2(null);
    setCreatedWidget(null);
    setCustomTitle('');
    setError('');
  };

  return (
    <div className="space-y-4">
      {/* Top Header & Notifications */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[var(--color-primary-subtle)] border border-[var(--color-primary-border)] text-[var(--color-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">drag_indicator</span>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Select Drag and Drop Dashboard Builder
            </h2>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Guided 3-step creation: pick chart type, drop 2 data fields, and publish to Executive Dashboard
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <input
            type="text"
            className="border border-[var(--color-border)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] font-medium focus:outline-none focus:border-[var(--color-primary)] transition-all w-60"
            value={dashboardTitle}
            onChange={e => setDashboardTitle(e.target.value)}
            placeholder="Dashboard Title"
            title="Custom Dashboard Title"
          />
          {selectedChartType && (
            <button
              type="button"
              onClick={handleResetWorkflow}
              className="px-2.5 py-1 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs text-[var(--color-text-secondary)] font-medium flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <span className="material-symbols-outlined text-[14px]">restart_alt</span>
              <span>Reset Canvas</span>
            </button>
          )}
        </div>
      </div>

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

      {/* THREE-COLUMN WORKSPACE LAYOUT */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* ============================================================== */}
        {/* LEFT PANEL: Chart Types Library (col-span-3)                    */}
        {/* ============================================================== */}
        <div className="lg:col-span-3 space-y-3.5">
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-3">
            <div className="pb-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">widgets</span>
                  <span>Chart Types Library</span>
                </h3>
                <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                  Step 1: Select or drag a chart type or KPI
                </p>
              </div>
              <span className="text-[10px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-hover)] px-1.5 py-0.5 rounded">
                {AVAILABLE_CHART_TYPES.length} Types
              </span>
            </div>

            {/* List of Chart Types */}
            <div className="space-y-1.5 max-h-[620px] overflow-y-auto pr-1">
              {AVAILABLE_CHART_TYPES.map(opt => {
                const isSelected = selectedChartType?.id === opt.id;
                return (
                  <div
                    key={opt.id}
                    draggable
                    onDragStart={e => handleDragStartChartType(e, opt)}
                    onClick={() => handleSelectChartType(opt)}
                    className={`p-2.5 rounded-[var(--radius-element)] border transition-all cursor-pointer flex items-start gap-2.5 ${
                      isSelected
                        ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)] shadow-[var(--shadow-xs)] ring-1 ring-[var(--color-primary)]'
                        : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-hover)]'
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded flex items-center justify-center shrink-0 mt-0.5 ${
                        isSelected
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[16px]">{opt.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-xs font-semibold text-[var(--color-text-primary)] truncate">
                          {opt.label}
                        </span>
                        <span
                          className={`text-[9px] font-medium uppercase px-1 py-0.2 rounded ${
                            opt.category === 'kpi'
                              ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                              : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400'
                          }`}
                        >
                          {opt.category}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--color-text-muted)] line-clamp-1 mt-0.5">
                        {opt.desc}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* MIDDLE PANEL: Your Dashboard Canvas (col-span-6)               */}
        {/* ============================================================== */}
        <div className="lg:col-span-6 space-y-4">
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] min-h-[580px] flex flex-col">
            <div className="pb-3 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">dashboard</span>
                  <span>Your Dashboard Canvas</span>
                </h3>
                <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                  {createdWidget
                    ? 'Review generated preview and publish to Executive Dashboard'
                    : selectedChartType
                    ? 'Step 2: Place the 2 required data fields to configure widget'
                    : 'Select or drag a chart type or KPI from the left library'}
                </p>
              </div>

              {selectedChartType && (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--color-primary)] bg-[var(--color-primary-subtle)] border border-[var(--color-primary-border)] px-2 py-0.5 rounded-full">
                    <span className="material-symbols-outlined text-[14px]">{selectedChartType.icon}</span>
                    <span>{selectedChartType.label}</span>
                  </span>
                </div>
              )}
            </div>

            {/* Canvas Body */}
            <div className="flex-1 py-4 flex flex-col justify-center">
              {/* STATE 1: Empty Canvas State */}
              {!selectedChartType && !createdWidget && (
                <div
                  onDragOver={e => {
                    e.preventDefault();
                    setActiveDropTarget('canvas');
                  }}
                  onDragLeave={() => setActiveDropTarget(null)}
                  onDrop={handleDropCanvas}
                  className={`border-2 border-dashed rounded-[var(--radius-container)] p-10 text-center flex flex-col items-center justify-center gap-3 transition-all ${
                    activeDropTarget === 'canvas'
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)] scale-[1.01]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]'
                  }`}
                >
                  <div className="w-12 h-12 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-muted)] shadow-[var(--shadow-2xs)]">
                    <span className="material-symbols-outlined text-[24px]">dashboard_customize</span>
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                      Your Dashboard Canvas is Empty
                    </h4>
                    <p className="text-xs text-[var(--color-text-muted)] max-w-sm mt-1">
                      Select or drag a chart type or KPI from the <strong>Chart Types Library</strong> on the left to start configuring your widget.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-2 mt-2">
                    {AVAILABLE_CHART_TYPES.slice(0, 4).map(opt => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => handleSelectChartType(opt)}
                        className="px-2.5 py-1 text-xs rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-medium flex items-center gap-1 transition-all cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[14px]">{opt.icon}</span>
                        <span>{opt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* STATE 2: Step-by-Step Configuration Card */}
              {selectedChartType && !createdWidget && dropzoneConfig && (
                <div className="space-y-4">
                  {/* Configuration Card Header */}
                  <div className="p-3.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded bg-[var(--color-primary)] text-white flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-[18px]">{selectedChartType.icon}</span>
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-[var(--color-text-primary)]">
                          {selectedChartType.label} Configuration
                        </h4>
                        <p className="text-[10px] text-[var(--color-text-muted)]">
                          Place the data fields you need (2 fields required)
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedChartType(null)}
                      className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] underline cursor-pointer"
                    >
                      Change Chart Type
                    </button>
                  </div>

                  {/* DROPZONE 1 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">
                          {dropzoneConfig.zone1Icon}
                        </span>
                        <span>{dropzoneConfig.zone1Title}</span>
                        <span className="text-[10px] text-red-500 font-bold">*Required</span>
                      </label>
                      {field1 && (
                        <button
                          type="button"
                          onClick={() => setField1(null)}
                          className="text-[10px] text-[var(--color-text-muted)] hover:text-red-500 flex items-center gap-0.5 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[12px]">close</span>
                          <span>Clear</span>
                        </button>
                      )}
                    </div>

                    <div
                      onDragOver={e => {
                        e.preventDefault();
                        setActiveDropTarget('field1');
                      }}
                      onDragLeave={() => setActiveDropTarget(null)}
                      onDrop={e => handleDropFieldZone(e, 'field1')}
                      className={`min-h-[64px] rounded-[var(--radius-element)] border-2 border-dashed p-2.5 flex items-center justify-between transition-all ${
                        field1
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)]/40 border-solid'
                          : activeDropTarget === 'field1'
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)] scale-[1.01]'
                          : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      {field1 ? (
                        <div className="flex items-center justify-between w-full">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">
                              check_circle
                            </span>
                            <div>
                              <div className="text-xs font-bold text-[var(--color-text-primary)]">
                                {field1.semantic_name || field1.name}
                              </div>
                              <div className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
                                <span className="font-mono">{field1.name}</span>
                                <span>•</span>
                                <span className="uppercase text-[9px] font-semibold text-[var(--color-primary)]">
                                  {field1.role || field1.type}
                                </span>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setField1(null)}
                            className="w-6 h-6 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-[var(--color-text-muted)] hover:text-red-500 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[14px]">close</span>
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-[var(--color-text-muted)] w-full justify-center py-1">
                          <span className="material-symbols-outlined text-[18px]">add_circle_outline</span>
                          <span className="text-xs font-medium">Drop a data field here ({dropzoneConfig.zone1Title})</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* DROPZONE 2 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">
                          {dropzoneConfig.zone2Icon}
                        </span>
                        <span>{dropzoneConfig.zone2Title}</span>
                        <span className="text-[10px] text-red-500 font-bold">*Required</span>
                      </label>
                      {field2 && (
                        <button
                          type="button"
                          onClick={() => setField2(null)}
                          className="text-[10px] text-[var(--color-text-muted)] hover:text-red-500 flex items-center gap-0.5 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[12px]">close</span>
                          <span>Clear</span>
                        </button>
                      )}
                    </div>

                    <div
                      onDragOver={e => {
                        e.preventDefault();
                        setActiveDropTarget('field2');
                      }}
                      onDragLeave={() => setActiveDropTarget(null)}
                      onDrop={e => handleDropFieldZone(e, 'field2')}
                      className={`min-h-[64px] rounded-[var(--radius-element)] border-2 border-dashed p-2.5 flex items-center justify-between transition-all ${
                        field2
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)]/40 border-solid'
                          : activeDropTarget === 'field2'
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary-subtle)] scale-[1.01]'
                          : 'border-[var(--color-border)] bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      {field2 ? (
                        <div className="flex items-center justify-between w-full">
                          <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">
                              check_circle
                            </span>
                            <div>
                              <div className="text-xs font-bold text-[var(--color-text-primary)]">
                                {field2.semantic_name || field2.name}
                              </div>
                              <div className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
                                <span className="font-mono">{field2.name}</span>
                                <span>•</span>
                                <span className="uppercase text-[9px] font-semibold text-[var(--color-primary)]">
                                  {field2.role || field2.type}
                                </span>
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setField2(null)}
                            className="w-6 h-6 rounded-full hover:bg-black/5 dark:hover:bg-white/10 flex items-center justify-center text-[var(--color-text-muted)] hover:text-red-500 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-[14px]">close</span>
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 text-[var(--color-text-muted)] w-full justify-center py-1">
                          <span className="material-symbols-outlined text-[18px]">add_circle_outline</span>
                          <span className="text-xs font-medium">Drop a data field here ({dropzoneConfig.zone2Title})</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Aggregation & Title Customization */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="text-[11px] font-medium text-[var(--color-text-secondary)] block mb-1">
                        Aggregation Method
                      </label>
                      <select
                        value={aggregation}
                        onChange={e => setAggregation(e.target.value)}
                        className="w-full border border-[var(--color-border)] bg-[var(--color-surface)] rounded-[var(--radius-element)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] font-medium focus:outline-none focus:border-[var(--color-primary)]"
                      >
                        {AGGREGATION_OPTIONS.map(agg => (
                          <option key={agg} value={agg}>
                            {agg}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-[var(--color-text-secondary)] block mb-1">
                        Custom Widget Title (Optional)
                      </label>
                      <input
                        type="text"
                        placeholder="Auto-generated if left blank"
                        value={customTitle}
                        onChange={e => setCustomTitle(e.target.value)}
                        className="w-full border border-[var(--color-border)] bg-[var(--color-surface)] rounded-[var(--radius-element)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)]"
                      />
                    </div>
                  </div>

                  {/* Validation Guidance & Create Button */}
                  <div className="pt-2 border-t border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px]">
                      {isConfigComplete ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px]">check_circle</span>
                          <span>Configuration complete. Ready to generate widget.</span>
                        </span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                          <span className="material-symbols-outlined text-[14px]">info</span>
                          <span>
                            {!field1 && !field2
                              ? 'Place 2 data fields from the palette into the dropzones above.'
                              : !field1
                              ? 'Drop 1st field into Dropzone 1.'
                              : 'Drop 2nd field into Dropzone 2.'}
                          </span>
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleResetWorkflow}
                        className="px-3 py-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs text-[var(--color-text-secondary)] font-medium transition-all cursor-pointer"
                      >
                        Cancel
                      </button>

                      <button
                        type="button"
                        onClick={() => void handleCreateWidget()}
                        disabled={!isConfigComplete || isGenerating}
                        className={`px-4 py-1.5 rounded-[var(--radius-element)] text-xs font-semibold flex items-center gap-1.5 transition-all shadow-[var(--shadow-2xs)] cursor-pointer ${
                          isConfigComplete && !isGenerating
                            ? 'bg-[var(--color-primary)] text-white hover:opacity-90 ring-1 ring-[var(--color-primary)]'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed border border-slate-300 dark:border-slate-700'
                        }`}
                      >
                        <span className={`material-symbols-outlined text-[15px] ${isGenerating ? 'animate-spin' : ''}`}>
                          {isGenerating ? 'progress_activity' : 'auto_awesome'}
                        </span>
                        <span>{isGenerating ? 'Executing Query…' : 'Create Widget'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* STATE 3: Generated Widget Preview in Canvas */}
              {createdWidget && (
                <div className="space-y-4 animate-in fade-in">
                  <div className="p-3.5 rounded-[var(--radius-element)] bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-emerald-600 dark:text-emerald-400 text-[20px]">
                        verified
                      </span>
                      <div>
                        <h4 className="text-xs font-bold text-emerald-950 dark:text-emerald-200">
                          Widget Generated Successfully
                        </h4>
                        <p className="text-[10px] text-emerald-800/80 dark:text-emerald-300/80">
                          {createdWidget.aggregation} of {createdWidget.metric} across {createdWidget.dimension || 'all'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setCreatedWidget(null)}
                        className="px-2.5 py-1 text-xs rounded border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-medium hover:bg-slate-50 cursor-pointer"
                      >
                        Edit Configuration
                      </button>
                      <button
                        type="button"
                        onClick={handleResetWorkflow}
                        className="px-2.5 py-1 text-xs rounded border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 font-medium hover:bg-slate-50 cursor-pointer"
                      >
                        Create Another Widget
                      </button>
                    </div>
                  </div>

                  {/* Render Widget Preview */}
                  <div className="border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 bg-[var(--color-surface)] shadow-[var(--shadow-xs)]">
                    <AnalyticsWidget
                      definition={{
                        id: createdWidget.id,
                        title: createdWidget.title,
                        kind: createdWidget.kind,
                        revision: 1,
                        semantic_revision: model?.revision || 1,
                        status: 'approved',
                        dependencies: [],
                        explanation: '',
                        query_plan: {
                          metric: createdWidget.metric,
                          aggregation: createdWidget.aggregation,
                          dimension: createdWidget.dimension,
                          chart_type: createdWidget.kind,
                        },
                      }}
                      result={createdWidget.result}
                    />
                  </div>

                  {/* Publish Action Bar */}
                  <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-between shadow-[var(--shadow-2xs)]">
                    <div>
                      <div className="text-xs font-semibold text-[var(--color-text-primary)]">
                        {createdWidget.isPublished ? '✓ Live on Executive Dashboard' : 'Ready to Publish?'}
                      </div>
                      <p className="text-[10px] text-[var(--color-text-muted)]">
                        {createdWidget.isPublished
                          ? 'This widget is active on the Executive Dashboard alongside all previously published widgets.'
                          : 'Publishing appends this new widget to the Executive Dashboard without replacing existing widgets.'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handlePublishWidget()}
                      disabled={isPublishing || createdWidget.isPublished}
                      className={`px-4 py-2 rounded-[var(--radius-element)] text-xs font-semibold flex items-center gap-1.5 transition-all shadow-[var(--shadow-2xs)] cursor-pointer ${
                        createdWidget.isPublished
                          ? 'bg-emerald-600 text-white cursor-default'
                          : isPublishing
                          ? 'bg-slate-300 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                          : 'bg-[var(--color-primary)] text-white hover:opacity-90 ring-1 ring-[var(--color-primary)]'
                      }`}
                    >
                      <span className={`material-symbols-outlined text-[16px] ${isPublishing ? 'animate-spin' : ''}`}>
                        {isPublishing ? 'progress_activity' : createdWidget.isPublished ? 'done_all' : 'publish'}
                      </span>
                      <span>
                        {isPublishing
                          ? 'Publishing…'
                          : createdWidget.isPublished
                          ? 'Published to Executive Dashboard'
                          : 'Publish to Executive Dashboard'}
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* RIGHT PANEL: Data Fields Palette (col-span-3)                   */}
        {/* ============================================================== */}
        <div className="lg:col-span-3 space-y-3.5">
          {/* Active Dataset Source Selector */}
          <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">database</span>
                <span>Active Dataset Source</span>
              </label>
              <span className="text-[10px] font-mono text-[var(--color-text-muted)]">
                {fields.length} fields
              </span>
            </div>
            <select
              aria-label="Active Dataset Source"
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

          {/* Draggable Data Fields Palette */}
          <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-3">
            <div className="pb-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">drag_indicator</span>
                  <span>Data Fields Palette</span>
                </h3>
                <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                  Drag 2 elements individually into the canvas dropzones
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
                  className="absolute right-2 top-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              )}
            </div>

            {/* Group 1: Numeric Measures */}
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-blue-500">tag</span>
                <span>Numeric Measures ({filteredMeasures.length})</span>
              </div>

              <div className="space-y-1 max-h-[170px] overflow-y-auto pr-1">
                {filteredMeasures.length === 0 ? (
                  <span className="text-[11px] text-[var(--color-text-muted)] italic block py-1">No matching measures</span>
                ) : (
                  filteredMeasures.map(m => (
                    <div
                      key={m.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, m)}
                      className="p-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] flex items-center justify-between gap-1 text-xs cursor-grab active:cursor-grabbing transition-all group"
                      title={`Drag or click + to add "${m.name}"`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="material-symbols-outlined text-[13px] text-blue-500 shrink-0">tag</span>
                        <span className="font-medium text-[var(--color-text-primary)] truncate">
                          {m.semantic_name || m.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[9px] font-mono text-[var(--color-text-muted)] uppercase">
                          {m.type}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAssignField(m)}
                          className="w-5 h-5 rounded hover:bg-[var(--color-primary-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="Place into canvas"
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Group 2: Categorical Dimensions */}
            <div className="space-y-1.5 pt-2 border-t border-[var(--color-border)]">
              <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                <span className="material-symbols-outlined text-[13px] text-purple-500">category</span>
                <span>Categorical Dimensions ({filteredDimensions.length})</span>
              </div>

              <div className="space-y-1 max-h-[170px] overflow-y-auto pr-1">
                {filteredDimensions.length === 0 ? (
                  <span className="text-[11px] text-[var(--color-text-muted)] italic block py-1">No matching dimensions</span>
                ) : (
                  filteredDimensions.map(d => (
                    <div
                      key={d.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, d)}
                      className="p-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] flex items-center justify-between gap-1 text-xs cursor-grab active:cursor-grabbing transition-all group"
                      title={`Drag or click + to add "${d.name}"`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="material-symbols-outlined text-[13px] text-purple-500 shrink-0">view_column</span>
                        <span className="font-medium text-[var(--color-text-primary)] truncate">
                          {d.semantic_name || d.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[9px] font-mono text-[var(--color-text-muted)] uppercase">
                          {d.type}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAssignField(d)}
                          className="w-5 h-5 rounded hover:bg-[var(--color-primary-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="Place into canvas"
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Group 3: Date & Time Fields */}
            {filteredTemporal.length > 0 && (
              <div className="space-y-1.5 pt-2 border-t border-[var(--color-border)]">
                <div className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px] text-amber-500">calendar_today</span>
                  <span>Date & Time ({filteredTemporal.length})</span>
                </div>

                <div className="space-y-1 max-h-[140px] overflow-y-auto pr-1">
                  {filteredTemporal.map(t => (
                    <div
                      key={t.name}
                      draggable
                      onDragStart={e => handleDragStartField(e, t)}
                      className="p-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] flex items-center justify-between gap-1 text-xs cursor-grab active:cursor-grabbing transition-all group"
                      title={`Drag or click + to add "${t.name}"`}
                    >
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="material-symbols-outlined text-[13px] text-amber-500 shrink-0">calendar_month</span>
                        <span className="font-medium text-[var(--color-text-primary)] truncate">
                          {t.semantic_name || t.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[9px] font-mono text-[var(--color-text-muted)] uppercase">
                          {t.type}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleAssignField(t)}
                          className="w-5 h-5 rounded hover:bg-[var(--color-primary-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-primary)] flex items-center justify-center opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="Place into canvas"
                        >
                          <span className="material-symbols-outlined text-[13px]">add</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
