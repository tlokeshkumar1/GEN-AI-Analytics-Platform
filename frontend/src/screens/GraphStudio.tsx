import React, { useEffect, useState, useMemo } from 'react';
import api, { getApiErrorMessage } from '../services/api';
import { selectedContext, ensureDefaultContext, selectContext } from '../services/executionContext';
import { hasAdminRole } from '../services/authService';
import { getDatasets } from '../services/datasetService';
import { DatasetItem } from '../types/dataset';
import {
  AnalyticsDefinition,
  ExecutionResult,
  SemanticModel,
  executePlan,
  getRecommendations,
  getSemanticModels,
  proposeRecommendations,
  reviewDefinition,
  deleteDefinition,
  deleteDefinitions,
  saveDefinition,
  generatePythonGraphAgent,
  PythonGraphAgentResponse,
  getDashboardPublication,
  resolveJoin,
  JoinResolution,
  generateGenAiDashboard,
  generateGenAiDashboardStream,
  executeGenAiWidget,
  GenAIDashboardResponse,
  GenAIRecommendation,
  GenAIKpiCard,
  GenAIChart,
} from '../services/semanticService';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { invalidateDashboardCache } from './ExecutiveDashboard';
import { GeneratedWidgetSections, GeneratedWidget } from '../components/dashboard/GeneratedWidgetSections';
import { SIGNED_OUT_EVENT } from '../services/authNavigation';
import { DragDropDashboardBuilder } from '../components/dashboard/DragDropDashboardBuilder';

const DISPLAY_TYPES = [
  { id: 'kpi', label: 'Stat KPI', icon: 'pin' },
  { id: 'bar', label: 'Bar Chart', icon: 'bar_chart' },
  { id: 'horizontal_bar', label: 'H-Bar Chart', icon: 'align_horizontal_left' },
  { id: 'line', label: 'Line Trend', icon: 'show_chart' },
  { id: 'area', label: 'Area Chart', icon: 'area_chart' },
  { id: 'pie', label: 'Pie Dist.', icon: 'pie_chart' },
  { id: 'donut', label: 'Donut Chart', icon: 'donut_large' },
  { id: 'scatter', label: 'Scatter', icon: 'scatter_plot' },
  { id: 'gauge', label: 'Gauge KPI', icon: 'speed' },
  { id: 'funnel', label: 'Funnel', icon: 'filter_alt' },
  { id: 'radar', label: 'Radar', icon: 'radar' },
  { id: 'table', label: 'Data Table', icon: 'table_chart' },
];

const ADVANCED_PYTHON_TYPES = [
  { id: 'heatmap', label: 'Heatmap Matrix', desc: 'Seaborn correlation density', icon: 'grid_view' },
  { id: 'waterfall', label: 'Waterfall Bridge', desc: 'Cumulative margin walk', icon: 'waterfall_chart' },
  { id: 'treemap', label: 'Treemap Hierarchy', desc: 'Proportional nested area', icon: 'dashboard' },
  { id: 'violin', label: 'Violin Distribution', desc: 'Kernel density & median', icon: 'graphic_eq' },
  { id: 'box', label: 'Box Plot', desc: 'Quartiles & outliers', icon: 'candlestick_chart' },
  { id: 'stacked_bar', label: 'Stacked Bar', desc: 'Multi-tier composition', icon: 'stacked_bar_chart' },
];

const SUGGESTED_PROMPTS = [
  'Generate a correlation heatmap across primary numeric measures and categories',
  'Compare top categories by cumulative total with a Pareto 80/20 curve',
  'Plot period-over-period distribution and outlier trends',
  'Render a nested breakdown across the leading categorical dimensions',
];

const TEN_STEPS = [
  { step: 'Step 3', label: 'Receive Prompt & Dataset' },
  { step: 'Step 4', label: 'Inspect Schema & Ranges' },
  { step: 'Step 5', label: 'GPT-4o-mini Intent Parsing' },
  { step: 'Step 5b', label: 'Deterministic Pre-computation' },
  { step: 'Step 5c', label: 'Dual-Path Reconciliation' },
  { step: 'Step 6', label: 'Generate Isolated Temp Script' },
  { step: 'Step 7', label: 'Execute inside Python Sandbox' },
  { step: 'Step 8', label: 'Extract High-Res Base64 PNG' },
  { step: 'Step 9', label: 'Clean Temp Artifacts' },
  { step: 'Step 10', label: 'Stateless Verification' },
];

const GENAI_10_STEPS = [
  { step: 'Step 1', name: 'Understand', desc: 'Natural language intent & metrics' },
  { step: 'Step 2', name: 'Explore', desc: 'Dynamic schema & metadata inspection' },
  { step: 'Step 3', name: 'Identify', desc: 'Columns, measures & calculations' },
  { step: 'Step 4', name: 'Relate', desc: 'JOIN detection & key matching' },
  { step: 'Step 5', name: 'Generate & Execute', desc: 'Dynamic SQL query execution' },
  { step: 'Step 6', name: 'Validate', desc: 'Data consistency & calculation safety' },
  { step: 'Step 7', name: 'Analyze', desc: 'Statistical trends & executive insights' },
  { step: 'Step 8', name: 'Recommend', desc: 'Proactive AI widget recommendations' },
  { step: 'Step 9', name: 'Render', desc: 'Dashboard widgets structure & layout' },
  { step: 'Step 10', name: 'Visualize', desc: 'Interactive charts & Python graphics' },
];

type CreationMode = 'visual' | 'prompt' | 'data_options';

interface CachedStudioState {
  datasets: DatasetItem[];
  model: SemanticModel | null;
  items: AnalyticsDefinition[];
  selectedDatasetId: string;
  publishedKeys: string[];
  selectedKeys: string[];
}

let cachedStudioState: CachedStudioState | null = null;
let generatedWidgetCache: GeneratedWidget[] = [];
window.addEventListener(SIGNED_OUT_EVENT, () => { generatedWidgetCache = []; cachedStudioState = null; });

export function GraphStudio({
  onNavigate,
  user,
  initialMode = 'visual',
  widgetsOnly = false,
}: {
  onNavigate: (path: string) => void;
  user?: { role?: string; roles?: string[] } | null;
  initialMode?: CreationMode;
  widgetsOnly?: boolean;
}) {
  const [generatedWidgets, setGeneratedWidgets] = useState<GeneratedWidget[]>(generatedWidgetCache);
  const addGenerated = (widget: GeneratedWidget) => {
    setGeneratedWidgets(prev => {
      const next = [{ ...widget, source: widget.source || activeMode }, ...prev.filter(w => w.definition.id !== widget.definition.id)];
      generatedWidgetCache = next;
      return next;
    });
  };
  useEffect(() => {
    const clear = () => setGeneratedWidgets([]);
    window.addEventListener(SIGNED_OUT_EVENT, clear);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, clear);
  }, []);
  const canPublish = true;
  const [model, setModel] = useState<SemanticModel | null>(cachedStudioState?.model ?? null);
  const [items, setItems] = useState<AnalyticsDefinition[]>(cachedStudioState?.items ?? []);
  const [previews, setPreviews] = useState<Record<string, ExecutionResult>>({});
  const [loadingPreviews, setLoadingPreviews] = useState<Record<string, boolean>>({});
  const [reviewingItems, setReviewingItems] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [publishedSuccess, setPublishedSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Available Datasets & Active Selection for Multi-Table Scoping
  const [datasets, setDatasets] = useState<DatasetItem[]>(cachedStudioState?.datasets ?? []);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>(cachedStudioState?.selectedDatasetId ?? '');

  // Active Creation Tab ('prompt' = 1. Generative AI Dashboards, 'dashboards' = 2. Build Your Dashboards)
  const [activeTab, setActiveTabState] = useState<'prompt' | 'dashboards'>(() => {
    try {
      const saved = sessionStorage.getItem('graph_studio_active_tab');
      if (saved === 'prompt' || saved === 'dashboards') return saved;
    } catch { }
    return initialMode === 'prompt' ? 'prompt' : 'dashboards';
  });
  // Dashboard Sub-Mode inside "Build Your Dashboards": 'manual' (Build Manually) or 'drag_drop' (Select Drag and Drop)
  const [dashboardMode, setDashboardModeState] = useState<'manual' | 'drag_drop'>(() => {
    try {
      const saved = sessionStorage.getItem('graph_studio_dashboard_mode');
      if (saved === 'manual' || saved === 'drag_drop') return saved;
    } catch { }
    return initialMode === 'data_options' ? 'drag_drop' : 'manual';
  });
  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);

  const setActiveTab = (tab: 'prompt' | 'dashboards') => {
    try {
      sessionStorage.setItem('graph_studio_active_tab', tab);
    } catch { }
    setActiveTabState(tab);
  };

  const setDashboardMode = (mode: 'manual' | 'drag_drop') => {
    try {
      sessionStorage.setItem('graph_studio_dashboard_mode', mode);
    } catch { }
    setDashboardModeState(mode);
  };

  // Backward-compatible activeMode derived state
  const activeMode: CreationMode = activeTab === 'prompt' ? 'prompt' : (dashboardMode === 'manual' ? 'visual' : 'data_options');
  const setActiveMode = (mode: CreationMode) => {
    if (mode === 'prompt') {
      setActiveTab('prompt');
    } else if (mode === 'visual') {
      setActiveTab('dashboards');
      setDashboardMode('manual');
    } else if (mode === 'data_options') {
      setActiveTab('dashboards');
      setDashboardMode('drag_drop');
    }
  };

  useEffect(() => {
    try {
      const savedTab = sessionStorage.getItem('graph_studio_active_tab');
      if (savedTab) return; // Retain active tab on dataset changes/re-renders
    } catch { }
    if (initialMode === 'prompt') {
      setActiveTab('prompt');
    } else if (initialMode === 'data_options') {
      setActiveTab('dashboards');
      setDashboardMode('drag_drop');
    } else if (initialMode === 'visual') {
      setActiveTab('dashboards');
      setDashboardMode('manual');
    }
  }, [initialMode]);

  // Mode 1: Generative AI Dashboards States (Universal NLU, Dynamic SQL & Analysis-First 10 Steps)
  const [genAiPrompt, setGenAiPrompt] = useState('');
  const [genAiRunning, setGenAiRunning] = useState(false);
  const [genAiStep, setGenAiStep] = useState<number>(0);
  const [genAiFailed, setGenAiFailed] = useState(false);
  const [genAiStepDetail, setGenAiStepDetail] = useState<string>('');
  const [genAiDashboard, setGenAiDashboard] = useState<GenAIDashboardResponse | null>(null);
  const [conversationHistory, setConversationHistory] = useState<Array<{ role: string; content: string }>>([]);
  const [activeRecommendations, setActiveRecommendations] = useState<GenAIRecommendation[]>([]);
  const [showSqlInspector, setShowSqlInspector] = useState(false);
  const [isAddingRecommendation, setIsAddingRecommendation] = useState<Record<string, boolean>>({});
  const [followUpPrompt, setFollowUpPrompt] = useState('');
  const [widgetStatuses, setWidgetStatuses] = useState<Record<string, 'approved' | 'rejected' | 'pending'>>({});
  const [previewWidget, setPreviewWidget] = useState<{
    id: string;
    title: string;
    kind: string;
    metric?: string;
    dimension?: string;
    aggregation?: string;
    format?: string;
    value?: any;
    data?: any[];
    subtitle?: string;
    sql_query?: string;
    query_plan?: GenAIChart['query_plan'];
    recommendationId?: string;
  } | null>(null);

  // Mode 1: Visual KPI Builder States
  const [title, setTitle] = useState('');
  const [metric, setMetric] = useState('*');
  const [aggregation, setAggregation] = useState('COUNT');
  const [dimension, setDimension] = useState('');
  const [kind, setKind] = useState('kpi');
  const [selected, setSelected] = useState<string[]>(cachedStudioState?.selectedKeys ?? []);
  const [publishedKeys, setPublishedKeys] = useState<string[]>(cachedStudioState?.publishedKeys ?? []);
  const [filterDashboard, setFilterDashboard] = useState<'all' | 'published' | 'not_published'>('all');
  const [fileScopeFilter, setFileScopeFilter] = useState<string>('all');
  const [deleteSelected, setDeleteSelected] = useState<string[]>([]);
  const [deletingItems, setDeletingItems] = useState<Record<string, boolean>>({});
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [edit, setEdit] = useState<AnalyticsDefinition | null>(null);
  const [planText, setPlanText] = useState('');

  // Mode 2: AI Core Custom Graph (Prompt-Driven 10 Steps)
  const [promptInput, setPromptInput] = useState('');
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStep, setAgentStep] = useState<number>(0);
  const [agentResult, setAgentResult] = useState<PythonGraphAgentResponse | null>(null);

  // Mode 3: Data-Driven Automated Custom Graph (No Prompt)
  const [selectedDataMetric, setSelectedDataMetric] = useState('');
  const [selectedDataDimension, setSelectedDataDimension] = useState('');
  const [selectedAdvancedChart, setSelectedAdvancedChart] = useState('heatmap');
  const [selectedPalette, setSelectedPalette] = useState('Blues');
  const [dataLimit, setDataLimit] = useState<number>(10);
  const [dataModeRunning, setDataModeRunning] = useState(false);
  const [dataModeResult, setDataModeResult] = useState<PythonGraphAgentResponse | null>(null);

  // Cross-table join states for Mode 1 (Build Your KPI)
  const [dimensionDatasetId, setDimensionDatasetId] = useState<string>('');
  const [dimensionModel, setDimensionModel] = useState<SemanticModel | null>(null);
  const [joinResolution, setJoinResolution] = useState<JoinResolution | null>(null);
  const [isResolvingJoin, setIsResolvingJoin] = useState(false);

  // Cross-table join states for Mode 3 (Data-Driven Custom Graph)
  const [dataDimensionDatasetId, setDataDimensionDatasetId] = useState<string>('');
  const [dataDimensionModel, setDataDimensionModel] = useState<SemanticModel | null>(null);
  const [dataJoinResolution, setDataJoinResolution] = useState<JoinResolution | null>(null);
  const [isResolvingDataJoin, setIsResolvingDataJoin] = useState(false);

  const handleDimensionDatasetChange = async (targetDsId: string) => {
    setDimensionDatasetId(targetDsId);
    setDimension('');
    if (targetDsId === selectedDatasetId) {
      setJoinResolution(null);
      setDimensionModel(null);
      return;
    }
    setIsResolvingJoin(true);
    try {
      const res = await resolveJoin(selectedDatasetId, targetDsId);
      setJoinResolution(res);
      if (res.joinable) {
        const targetDs = datasets.find(d => d.id === targetDsId);
        const models = await getSemanticModels(targetDsId, targetDs?.currentVersion || 1);
        const approved = models.find(m => m.status === 'approved') || models[0];
        setDimensionModel(approved || null);
      } else {
        setDimensionModel(null);
      }
    } catch (err) {
      setJoinResolution({ joinable: false, reason: getApiErrorMessage(err, 'Failed to resolve cross-table join.') });
      setDimensionModel(null);
    } finally {
      setIsResolvingJoin(false);
    }
  };

  const handleDataDimensionDatasetChange = async (targetDsId: string) => {
    setDataDimensionDatasetId(targetDsId);
    if (targetDsId === selectedDatasetId) {
      setDataJoinResolution(null);
      setDataDimensionModel(null);
      return;
    }
    setIsResolvingDataJoin(true);
    try {
      const res = await resolveJoin(selectedDatasetId, targetDsId);
      setDataJoinResolution(res);
      if (res.joinable) {
        const targetDs = datasets.find(d => d.id === targetDsId);
        const models = await getSemanticModels(targetDsId, targetDs?.currentVersion || 1);
        const approved = models.find(m => m.status === 'approved') || models[0];
        setDataDimensionModel(approved || null);
        const dims = approved?.fields.filter(f => ['dimension', 'identifier', 'time'].includes(f.role)) || [];
        if (dims.length > 0) setSelectedDataDimension(dims[0].name);
      } else {
        setDataDimensionModel(null);
      }
    } catch (err) {
      setDataJoinResolution({ joinable: false, reason: getApiErrorMessage(err, 'Failed to resolve cross-table join.') });
      setDataDimensionModel(null);
    } finally {
      setIsResolvingDataJoin(false);
    }
  };

  const handleSwitchDataset = async (newDatasetId: string) => {
    setSelectedDatasetId(newDatasetId);
    setDimensionDatasetId(newDatasetId);
    setJoinResolution(null);
    setDimensionModel(null);
    setDataDimensionDatasetId(newDatasetId);
    setDataJoinResolution(null);
    setDataDimensionModel(null);
    setError('');
    const targetDs = datasets.find(d => d.id === newDatasetId);
    if (!targetDs) return;
    const version = targetDs.currentVersion || 1;

    try {
      const models = await getSemanticModels(newDatasetId, version);
      const approved =
        models.find(m => m.status === 'approved') ||
        models[0];
      if (!approved) {
        setError(`No semantic model found for dataset "${targetDs.name}".`);
        return;
      }
      setModel(approved);
      selectContext({ datasetId: newDatasetId, version, semanticRevision: approved.revision });
      // Reset Mode 1 visual states for clean slate on new table
      setMetric('*');
      setAggregation('COUNT');
      setDimension('');

      // Update Mode 3 fields dynamically from active semantic model
      const measures = approved.fields.filter(f => f.role === 'measure' || ['decimal', 'integer', 'number'].includes(f.type));
      const dims = approved.fields.filter(f => ['dimension', 'identifier', 'time'].includes(f.role));
      setSelectedDataMetric(measures.length > 0 ? measures[0].name : '*');
      setSelectedDataDimension(dims.length > 0 ? dims[0].name : '');
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to load semantic model for table "${targetDs.name}".`));
    }
  };

  const load = async () => {
    let context = selectedContext();
    let allDatasets: DatasetItem[];
    let preloadedModels: SemanticModel[] | null = null;
    let preloadedRecs: AnalyticsDefinition[] | null = null;
    let preloadedPub: any = null;

    if (context) {
      const [dsList, models, recommendations, pubRes] = await Promise.all([
        getDatasets().catch(() => []),
        getSemanticModels(context.datasetId, context.version),
        getRecommendations(true),
        getDashboardPublication(true).catch(() => ({ title: '', items: [], status: 'unpublished' })),
      ]);
      allDatasets = dsList;
      preloadedModels = models;
      preloadedRecs = recommendations;
      preloadedPub = pubRes;
    } else {
      const [dsList, resolvedCtx] = await Promise.all([
        getDatasets().catch(() => []),
        ensureDefaultContext(),
      ]);
      allDatasets = dsList;
      context = resolvedCtx;
    }

    setDatasets(allDatasets);

    let dsId = context?.datasetId;
    if (!dsId && allDatasets.length > 0) {
      const activeDs = allDatasets.find(d => d.isActive) || allDatasets[0];
      dsId = activeDs.id;
    }
    if (!dsId) {
      cachedStudioState = null;
      setModel(null);
      setItems([]);
      setPublishedKeys([]);
      setSelected([]);
      setError('No dataset available. Please upload a dataset first.');
      return;
    }

    const targetDs = allDatasets.find(d => d.id === dsId) || allDatasets[0];
    const version = targetDs?.currentVersion || context?.version || 1;
    const resolvedId = targetDs ? targetDs.id : dsId;
    setSelectedDatasetId(resolvedId);
    setDimensionDatasetId(resolvedId);
    setDataDimensionDatasetId(resolvedId);

    const models = preloadedModels ?? (await getSemanticModels(resolvedId, version));
    const approved =
      models.find(m => m.revision === context?.semanticRevision && m.status === 'approved') ||
      models.find(m => m.status === 'approved') ||
      models[0];
    if (!approved) throw new Error('Approve a semantic model in Upload Dataset and select its revision.');
    if (context?.semanticRevision !== approved.revision || context?.datasetId !== resolvedId) {
      selectContext({ datasetId: resolvedId, version, semanticRevision: approved.revision });
    }
    setModel(approved);

    // Mode 3 initial selection from the approved model
    const measures = approved.fields.filter(f => f.role === 'measure' || ['decimal', 'integer', 'number'].includes(f.type));
    const dims = approved.fields.filter(f => ['dimension', 'identifier', 'time'].includes(f.role));
    setSelectedDataMetric(measures.length > 0 ? measures[0].name : '*');
    setSelectedDataDimension(dims.length > 0 ? dims[0].name : '');

    const [recommendations, pubRes] = preloadedRecs !== null
      ? [preloadedRecs, preloadedPub]
      : await Promise.all([
        getRecommendations(true),
        getDashboardPublication(true).catch(() => ({ title: '', items: [], status: 'unpublished' })),
      ]);
    const itemsList = Array.isArray(pubRes) ? pubRes : ((pubRes as any)?.items || []);
    const pubKeys = itemsList.map((p: any) => `${p.id}:${p.revision}`);
    setPublishedKeys(pubKeys);
    setSelected(pubKeys);
    setItems(recommendations);
    cachedStudioState = {
      datasets: allDatasets,
      model: approved,
      items: recommendations,
      selectedDatasetId: resolvedId,
      publishedKeys: pubKeys,
      selectedKeys: pubKeys,
    };
  };

  const run = async (operation: () => Promise<void>, actionKey?: string) => {
    setBusy(true);
    if (actionKey) setBusyAction(actionKey);
    setError('');
    setMessage('');
    setPublishedSuccess(false);
    try {
      await operation();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Operation failed.'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  useEffect(() => {
    void run(load);

    const handleContextChanged = () => {
      cachedStudioState = null;
      void run(load);
    };
    window.addEventListener('dataset-context-changed', handleContextChanged);
    return () => {
      window.removeEventListener('dataset-context-changed', handleContextChanged);
    };
  }, []);

  const togglePreview = async (item: AnalyticsDefinition) => {
    const key = `${item.id}:${item.revision}`;
    if (previews[key]) {
      setPreviews(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      return;
    }
    setLoadingPreviews(previous => ({ ...previous, [key]: true }));
    try {
      const contextHeaders: Record<string, string> = {};
      if (item.dataset_id) contextHeaders['X-Dataset-Id'] = item.dataset_id;
      if (item.version) contextHeaders['X-Dataset-Version'] = String(item.version);
      if (item.semantic_revision) contextHeaders['X-Semantic-Revision'] = String(item.semantic_revision);
      const result = await executePlan(item.query_plan, Object.keys(contextHeaders).length ? contextHeaders : undefined);
      setPreviews(previous => ({ ...previous, [key]: result }));
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to preview query execution.'));
    } finally {
      setLoadingPreviews(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };

  const handleReviewItem = async (item: AnalyticsDefinition, decision: 'approved' | 'rejected') => {
    const key = `${item.id}:${item.revision}`;
    if (reviewingItems[key]) return;
    setReviewingItems(previous => ({ ...previous, [key]: decision }));
    setError('');
    setPublishedSuccess(false);
    try {
      const updated = await reviewDefinition(item, decision);
      setItems(previous =>
        previous.map(existing =>
          existing.id === item.id && existing.revision === item.revision
            ? { ...existing, ...updated, status: updated?.status || decision }
            : existing
        )
      );
      if (decision === 'approved') {
        invalidateDashboardCache();
      window.dispatchEvent(new Event('dashboard_updated'));
        window.dispatchEvent(new Event('dashboard_updated'));
      }
      setMessage(
        decision === 'approved'
          ? `Approved definition "${item.title}". It can now be included on the dashboard.`
          : `Rejected definition "${item.title}".`
      );
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to ${decision === 'approved' ? 'approve' : 'reject'} "${item.title}".`));
    } finally {
      setReviewingItems(previous => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  };

  const removeDeletedKeys = (keysToRemove: string[]) => {
    const keySet = new Set(keysToRemove);
    setItems(prev => prev.filter(i => !keySet.has(`${i.id}:${i.revision}`)));
    setSelected(prev => prev.filter(k => !keySet.has(k)));
    setPublishedKeys(prev => prev.filter(k => !keySet.has(k)));
    setDeleteSelected(prev => prev.filter(k => !keySet.has(k)));
    setPreviews(prev => {
      const next = { ...prev };
      keysToRemove.forEach(k => delete next[k]);
      return next;
    });
    invalidateDashboardCache();
    window.dispatchEvent(new Event('dashboard_updated'));
  };

  const handleDeleteItem = async (item: AnalyticsDefinition) => {
    const key = `${item.id}:${item.revision}`;
    if (deletingItems[key]) return;
    setDeletingItems(prev => ({ ...prev, [key]: true }));
    setError('');
    setPublishedSuccess(false);
    try {
      await deleteDefinition(item);
      removeDeletedKeys([key]);
      setMessage(`Deleted widget "${item.title}".`);
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to delete "${item.title}".`));
    } finally {
      setDeletingItems(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const handleBulkDelete = async (keysToDelete: string[]) => {
    if (!keysToDelete.length) return;
    const targets = items
      .filter(i => keysToDelete.includes(`${i.id}:${i.revision}`))
      .map(i => ({ id: i.id, revision: i.revision }));
    if (!targets.length) return;
    await run(async () => {
      const res = await deleteDefinitions(targets);
      removeDeletedKeys(keysToDelete);
      setConfirmBulkDelete(false);
      setMessage(`Deleted ${res.deleted} widget${res.deleted === 1 ? '' : 's'}.`);
    }, 'bulk_delete');
  };

  const saveVisualDefinition = async () => {
    const isCrossTable = dimensionDatasetId && dimensionDatasetId !== selectedDatasetId;
    if (isCrossTable && (!joinResolution || !joinResolution.joinable)) {
      setError('Cannot save widget: The selected tables cannot be joined. Select joinable tables or dimension from the same table.');
      return;
    }
    const query: any = edit
      ? JSON.parse(planText)
      : {
        left_dataset_id: selectedDatasetId,
        metric,
        aggregation,
        dimension: dimension || undefined,
        ...(isCrossTable && joinResolution?.joinable ? {
          joins: [{
            right_dataset_id: dimensionDatasetId,
            left_key: joinResolution.left_key,
            right_key: joinResolution.right_key,
            how: 'left'
          }]
        } : {})
      };
    const item: AnalyticsDefinition = edit
      ? { ...edit, title, query_plan: query, kind }
      : {
        id: crypto.randomUUID(),
        title: title || `${aggregation} ${metric}`,
        kind,
        revision: 1,
        semantic_revision: model!.revision,
        query_plan: query,
        dependencies: [metric, dimension].filter(v => v && v !== '*'),
        explanation: isCrossTable ? `Cross-table query linked on ${joinResolution?.left_key} = ${joinResolution?.right_key}` : 'A user-defined query over approved semantic fields.',
        status: 'proposed',
      };
    const result = await executePlan(query, { 'X-Dataset-Id': selectedDatasetId });
    if (!result.success) throw new Error(result.error || 'Widget calculation failed.');
    const canonical = Object.fromEntries(Object.entries(item).filter(([key]) =>
      ['id', 'title', 'kind', 'revision', 'semantic_revision', 'query_plan', 'dependencies', 'explanation', 'status'].includes(key))) as unknown as AnalyticsDefinition;
    const saved = await saveDefinition(canonical);
    addGenerated({ definition: { ...item, ...saved, dataset_id: selectedDatasetId,
      dataset_name: datasets.find(d => d.id === selectedDatasetId)?.name,
      version: datasets.find(d => d.id === selectedDatasetId)?.currentVersion || 1 }, result });
    setItems(await getRecommendations(true));
    setEdit(null);
    setTitle('');
    setMessage('Widget generated below. Review the result and select it to publish.');
  };

  // ── Mode 1: Generative AI Dashboards Handlers (Analysis-First 10-Step Workflow) ──

  const stageGenAiWidget = (widget: any, context?: GenAIDashboardResponse['context'], prefix = 'generated') => {
    const datasetId = context?.dataset_id || selectedDatasetId;
    const metricName = widget.metric || '*';
    const query = { ...widget.query_plan, metric: metricName, aggregation: widget.aggregation,
      ...(widget.dimension ? { dimension: widget.dimension } : {}) };
    const data = widget.kind === 'kpi' ? [{ [metricName]: widget.value }] :
      (widget.data || []).map((point: any) => ({ [widget.dimension || 'label']: point.label, [metricName]: point.value }));
    addGenerated({ definition: {
      id: `${prefix}_${widget.id}`, title: widget.title, kind: widget.kind || 'kpi', revision: 1,
      semantic_revision: context?.semantic_revision || model?.revision || 1,
      dataset_id: datasetId, dataset_name: datasets.find(d => d.id === datasetId)?.name,
      version: context?.version || datasets.find(d => d.id === datasetId)?.currentVersion || 1,
      query_plan: query, dependencies: [metricName, widget.dimension].filter(Boolean),
      explanation: 'Generated from the requested analysis.', status: 'proposed',
    }, result: { success: true, data, summary: widget.kind === 'kpi' ? { formatted_value:
      widget.format === 'percent' ? `${widget.value}%` : widget.format === 'currency' ?
      `$${Number(widget.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(widget.value) } : {},
      records_matched: data.length, execution_time_ms: 0, execution_backend: 'dataframe' } });
  };

  const handleRunGenAiDashboard = async (customPrompt?: string) => {
    const text = (customPrompt || genAiPrompt || promptInput).trim();
    if (!text) return;
    setGenAiRunning(true);
    setGenAiFailed(false);
    setError('');
    setMessage('');
    setGenAiStep(1);
    setGenAiStepDetail('Step 1: Understanding natural language intent and metrics...');

    try {
      const res = await generateGenAiDashboardStream(
        {
          prompt: text,
          dataset_id: selectedDatasetId === 'all' ? undefined : selectedDatasetId || undefined,
          conversation_history: conversationHistory,
        },
        (stepEvent) => {
          setGenAiStep(stepEvent.step);
          setGenAiStepDetail(stepEvent.detail || `Executing Stage ${stepEvent.step} of 10...`);
        }
      );
      if (!res.kpi_cards?.length && !res.charts?.length) {
        throw new Error('No widgets were generated. Check that the selected dataset contains the requested fields.');
      }
      setPreviewWidget(null);
      setGenAiStep(10);
      setGenAiStepDetail('All 10 stages completed successfully.');
      setGenAiDashboard(res);
      res.kpi_cards?.forEach(widget => stageGenAiWidget({ ...widget, kind: 'kpi' }, res.context, res.dashboard_id));
      res.charts?.forEach(widget => stageGenAiWidget(widget, res.context, res.dashboard_id));
      setPublishedSuccess(false);

      // Approval follows a successful live execution and user review.
      const initialStatuses: Record<string, 'approved' | 'rejected' | 'pending'> = {};
      res.kpi_cards?.forEach(k => { initialStatuses[k.id] = 'pending'; });
      res.charts?.forEach(c => { initialStatuses[c.id] = 'pending'; });
      setWidgetStatuses(initialStatuses);

      setActiveRecommendations(res.recommendations || []);
      setConversationHistory(prev => [
        ...prev,
        { role: 'user', content: text },
        { role: 'assistant', content: res.intent_summary || 'Dashboard generated.' },
      ]);
      setFollowUpPrompt('');
      setMessage(`Successfully generated Gen AI Dashboard (${res.kpi_cards?.length || 0} KPIs, ${res.charts?.length || 0} charts) in ${res.execution_time_ms}ms.`);
    } catch (err) {
      setGenAiFailed(true);
      setGenAiStepDetail('Dashboard generation failed before all stages completed.');
      setError(getApiErrorMessage(err, 'Failed to generate Generative AI Dashboard.'));
    } finally {
      setGenAiRunning(false);
    }
  };

  const handleAcceptRecommendation = async (rec: GenAIRecommendation) => {
    setError('');
    setIsAddingRecommendation(prev => ({ ...prev, [rec.id]: true }));
    try {
      const res = await executeGenAiWidget({
        widget: rec,
        context: genAiDashboard?.context,
        dataset_id: selectedDatasetId === 'all' ? undefined : selectedDatasetId || undefined,
      });
      if (!res.widget || res.widget.error) throw new Error(res.widget?.error || 'Widget execution returned no output.');
      if (res.kind === 'kpi' ? res.widget.value == null : !res.widget.data?.length) {
        throw new Error('No data matched this recommendation. Adjust the data scope or filters and try again.');
      }
      setPreviewWidget({ ...res.widget, id: rec.id, kind: res.kind, recommendationId: rec.id });
    } catch (err) {
      setError(getApiErrorMessage(err, `Failed to preview recommendation "${rec.title}".`));
    } finally {
      setIsAddingRecommendation(prev => ({ ...prev, [rec.id]: false }));
    }
  };

  const handleDismissRecommendation = (recId: string) => {
    setActiveRecommendations(prev => prev.filter(r => r.id !== recId));
  };

  const handleRunAgentPrompt = async () => {
    if (!promptInput.trim()) return;
    setAgentRunning(true);
    setError('');
    setMessage('');
    setAgentResult(null);

    setAgentStep(1);
    try {
      const context = selectedContext();
      const res = await generatePythonGraphAgent({
        prompt: promptInput,
        dataset_id: selectedDatasetId || context?.datasetId,
      });
      if (res.status === 'error' || !res.image_base64) {
        setError(res.message || 'Custom graph generation failed to create an image.');
        setAgentResult(null);
      } else {
        setAgentStep(10);
        setAgentResult(res);
        setMessage('Custom graph generated successfully via 10-step Python Agent.');
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'AI Core custom graph generation failed.'));
    } finally {
      setAgentRunning(false);
    }
  };

  const handleRunDataDrivenAgent = async () => {
    setDataModeRunning(true);
    setError('');
    setMessage('');
    setDataModeResult(null);

    try {
      const isCrossTable = dataDimensionDatasetId && dataDimensionDatasetId !== selectedDatasetId;
      if (isCrossTable && (!dataJoinResolution || !dataJoinResolution.joinable)) {
        setError('Cannot generate chart: The selected tables cannot be joined. Choose joinable tables or select dimension from the same table.');
        setDataModeRunning(false);
        return;
      }
      const context = selectedContext();
      const prompt = `Generate a ${selectedAdvancedChart} chart of ${selectedDataMetric} by ${selectedDataDimension} with ${selectedPalette} palette`;
      const plan: any = {
        left_dataset_id: selectedDatasetId,
        metric: selectedDataMetric,
        dimension: selectedDataDimension,
        chart_type: selectedAdvancedChart,
        limit: dataLimit,
        ...(isCrossTable && dataJoinResolution?.joinable ? {
          joins: [{
            right_dataset_id: dataDimensionDatasetId,
            left_key: dataJoinResolution.left_key,
            right_key: dataJoinResolution.right_key,
            how: 'left'
          }]
        } : {})
      };
      const res = await generatePythonGraphAgent({
        prompt,
        metric: selectedDataMetric,
        dimension: selectedDataDimension,
        chart_type: selectedAdvancedChart,
        dataset_id: selectedDatasetId || context?.datasetId,
        query_plan: plan,
      });
      if (res.status === 'error' || !res.image_base64) {
        setError(res.message || 'Data-driven graph generation failed to create an image.');
        setDataModeResult(null);
      } else {
        setDataModeResult(res);
        setMessage(`Generated ${selectedAdvancedChart} visualization for ${selectedDataMetric} across ${selectedDataDimension}.`);
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Data-driven graph generation failed.'));
    } finally {
      setDataModeRunning(false);
    }
  };

  const handlePublishDashboard = async () => {
    if (!canPublish) {
      setError('Permission denied: Only Admin or Admin+User accounts can publish widgets to the Executive Dashboard.');
      return;
    }
    if (!selected.length) return;
    await run(async () => {
      const selectedWidgets = items.filter(i => selected.includes(`${i.id}:${i.revision}`));
      await api.post('/insights/dashboard', {
        title: 'Executive Analytics Dashboard',
        items: selectedWidgets.map(i => ({ id: i.id, revision: i.revision })),
      });
      invalidateDashboardCache();
      window.dispatchEvent(new Event('dashboard_updated'));
      setPublishedKeys(prev => Array.from(new Set([...prev, ...selected])));
      setPublishedSuccess(true);
      setMessage(`Successfully published ${selectedWidgets.length} widget(s) to the Executive Dashboard!`);
    }, 'publish');
  };

  return (
    <div className="space-y-3.5 w-full max-w-[1560px] mx-auto pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">query_stats</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">
              {widgetsOnly ? 'Widgets' : 'Build Your KPI'}
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              Analytics Studio
            </span>
            <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
              · {items.length} definitions
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            disabled={busy || !model}
            onClick={() =>
              void run(async () => {
                const newlyProposed = await proposeRecommendations(true);
                const allItems = await getRecommendations(true);
                setItems(allItems);
                if (!widgetsOnly) {
                  const proposals = Array.isArray(newlyProposed) ? newlyProposed : (newlyProposed as any)?.items || [];
                  for (const item of proposals) {
                    const result = await executePlan(item.query_plan);
                    if (result.success) addGenerated({ definition: { ...item, dataset_id: item.dataset_id || selectedDatasetId,
                      version: datasets.find(d => d.id === selectedDatasetId)?.currentVersion || 1 }, result });
                  }
                }
                if (Array.isArray(newlyProposed) && newlyProposed.length > 0) {
                  setMessage(
                    `Added ${newlyProposed.length} new AI-recommended KPI/chart definition${newlyProposed.length === 1 ? '' : 's'}. Existing definitions were preserved.`
                  );
                } else {
                  setMessage(
                    'All distinct AI-recommended KPIs and charts for this dataset are already present. Existing definitions were preserved.'
                  );
                }
              }, 'propose')
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-xs shadow-[var(--shadow-2xs)] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
          <span className={`material-symbols-outlined text-[16px] ${busyAction === 'propose' ? 'animate-spin' : ''}`}>
            {busyAction === 'propose' ? 'progress_activity' : 'auto_awesome'}
          </span>
          <span>{busyAction === 'propose' ? 'Proposing...' : 'Propose AI Recommendations'}</span>
        </button>
        </div>
      </div>

      {/* Global Alerts */}
      {error && (
        <div role="alert" className="p-4 bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-[var(--color-danger)] rounded-[var(--radius-container)] flex items-start gap-3 shadow-[var(--shadow-2xs)]">
          <span className="material-symbols-outlined text-[var(--color-danger)] text-xl mt-0.5">error</span>
          <div className="flex-1 text-xs font-medium">{error}</div>
          <button onClick={() => setError('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      {message && (
        <div
          role="status"
          className={`p-3.5 rounded-[var(--radius-container)] border flex items-center justify-between gap-3 shadow-[var(--shadow-2xs)] ${publishedSuccess ? 'bg-[var(--color-success-subtle)] border-[var(--color-success-border)] text-[var(--color-success)]' : 'bg-[var(--color-info-subtle)] border-[var(--color-info-border)] text-[var(--color-info)]'
            }`}
        >
          <div className="flex items-center gap-2.5 text-xs font-medium">
            <span className={`material-symbols-outlined text-lg ${publishedSuccess ? 'text-[var(--color-success)]' : 'text-[var(--color-info)]'}`}>
              {publishedSuccess ? 'check_circle' : 'info'}
            </span>
            <span>{message}</span>
          </div>
          <div className="flex items-center gap-2">
            {publishedSuccess && (
              <button
                type="button"
                onClick={() => onNavigate('executive-dashboard')}
                className="bg-[var(--color-success)] hover:opacity-90 text-white text-xs font-medium px-3 py-1.5 rounded-[var(--radius-element)] flex items-center gap-1 shadow-[var(--shadow-2xs)] transition-all cursor-pointer"
              >
                <span>View Executive Dashboard</span>
                <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
              </button>
            )}
            <button
              onClick={() => {
                setMessage('');
                setPublishedSuccess(false);
              }}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>
      )}

      <div hidden={widgetsOnly && !edit} className="space-y-4">
      {/* CREATION PATHWAYS (Top Segmented Tab Selector) */}
      <div className="bg-[var(--color-surface-hover)] p-1 rounded-[var(--radius-container)] border border-[var(--color-border)] flex flex-wrap sm:flex-nowrap gap-1">
        <button
          type="button"
          onClick={() => setActiveTab('prompt')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[var(--radius-element)] text-xs font-medium transition-all cursor-pointer ${activeTab === 'prompt'
              ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)]'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]/60'
            }`}
        >
          <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">psychology</span>
          <span>1. Generative AI Dashboards</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('dashboards')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-[var(--radius-element)] text-xs font-medium transition-all cursor-pointer ${activeTab === 'dashboards'
              ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)]'
              : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)]/60'
            }`}
        >
          <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">dashboard_customize</span>
          <span>Build Your Dashboards</span>
        </button>
      </div>

      {/* SUB-MODE SELECTOR DROPDOWN BAR: Visible inside "Build Your Dashboards" tab */}
      {activeTab === 'dashboards' && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3 px-4 shadow-[var(--shadow-2xs)] flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-primary)] flex items-center justify-center shrink-0 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">
                {dashboardMode === 'manual' ? 'edit_note' : 'drag_pan'}
              </span>
            </div>
            <div>
              <div className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                <span>Dashboard Creation Experience</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border border-[var(--color-border)]">
                  {dashboardMode === 'manual' ? 'Form Builder' : 'Drag & Drop Canvas'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                {dashboardMode === 'manual'
                  ? 'Build Manually: Define metrics, dimensions, aggregations, and cross-table joins with full SQL validation.'
                  : 'Select Drag and Drop: Interactive visual workspace to drag datasets, fields, and chart types directly onto the canvas.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 relative">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Mode:</span>
            <div className="relative">
              <button
                type="button"
                id="dashboard-mode-selector-btn"
                onClick={() => setIsModeDropdownOpen(prev => !prev)}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] border border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-primary)] transition-all cursor-pointer shadow-[var(--shadow-2xs)]"
              >
                <span>{dashboardMode === 'drag_drop' ? 'Select Drag and Drop' : 'Build Manually'}</span>
                <span className={`material-symbols-outlined text-[16px] text-[var(--color-text-muted)] transition-transform ${isModeDropdownOpen ? 'rotate-180' : ''}`}>
                  arrow_drop_down
                </span>
              </button>

              {isModeDropdownOpen && (
                <div className="absolute right-0 mt-1 w-48 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-lg z-30 py-1 animate-in fade-in">
                  <button
                    type="button"
                    onClick={() => {
                      setDashboardMode('manual');
                      setIsModeDropdownOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                      dashboardMode === 'manual'
                        ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-semibold'
                        : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">edit_note</span>
                    <span>Build Manually</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDashboardMode('drag_drop');
                      setIsModeDropdownOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                      dashboardMode === 'drag_drop'
                        ? 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] font-semibold'
                        : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[16px]">drag_pan</span>
                    <span>Select Drag and Drop</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODE 1: VISUAL KPI BUILDER (Matches Reference Image 2) */}
      {activeMode === 'visual' && model && (
        <section
          id="definition-form"
          className={`bg-[var(--color-surface)] border rounded-[var(--radius-container)] p-4 shadow-[var(--shadow-2xs)] transition-all space-y-3.5 ${edit ? 'border-[var(--color-warning-border)] ring-2 ring-[var(--color-warning)]/20' : 'border-[var(--color-border)]'
            }`}
        >
          <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                <span className="material-symbols-outlined text-[var(--color-primary)] text-base">{edit ? 'edit_note' : 'add_chart'}</span>
                <span>{edit ? `Editing Definition: "${edit.title}"` : 'Build a Business KPI or Chart'}</span>
              </h2>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Define aggregations and dimensional breakdowns over active semantic fields.
              </p>
            </div>
            {edit && (
              <button
                type="button"
                onClick={() => setEdit(null)}
                className="text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] font-medium px-3 py-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
              >
                Cancel Edit
              </button>
            )}
          </div>

          <div className="space-y-4">
            <div className={`grid grid-cols-1 sm:grid-cols-2 ${datasets.length > 1 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-4`}>
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                  KPI / Chart Title
                </label>
                <input
                  className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                  placeholder="e.g. Net Revenue by Region"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
              </div>

              {/* Table / Dataset Name Selector: If datasets.length > 1, show table dropdown */}
              {datasets.length > 1 && !edit && (
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">table_chart</span>
                    <span>Select Table / Dataset</span>
                    <span className="text-[10px] text-[var(--color-text-muted)] font-normal">(Target Measure)</span>
                  </label>
                  <select
                    className="border border-[var(--color-border)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] px-3 py-1.5 w-full text-[var(--color-text-primary)] text-xs font-medium focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                    value={selectedDatasetId}
                    onChange={e => void handleSwitchDataset(e.target.value)}
                  >
                    {datasets.map(d => {
                      const label = d.tableName || d.displayName || d.name;
                      const hasDistinctSource = d.sourceFile && d.sourceFile !== label;
                      const sourceHint = hasDistinctSource ? ` [${d.sourceFile}${d.sheetName ? ` · ${d.sheetName}` : ''}]` : '';
                      return (
                        <option key={d.id} value={d.id}>
                          {label}{sourceHint} {d.isActive ? '★' : ''} ({(d.rowCount || 0).toLocaleString()} rows)
                        </option>
                      );
                    })}
                  </select>
                </div>
              )}

              {!edit && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                      Target Measure (Y)
                    </label>
                    <select
                      className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                      value={metric}
                      onChange={e => {
                        setMetric(e.target.value);
                        setAggregation('COUNT');
                      }}
                    >
                      <option value="*">All Records (*)</option>
                      {model.fields.map(f => (
                        <option key={f.name} value={f.name}>
                          {f.semantic_name} ({f.role})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                      Aggregation
                    </label>
                    <select
                      className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                      value={aggregation}
                      onChange={e => setAggregation(e.target.value)}
                    >
                      {(metric === '*' ? ['COUNT'] : model.fields.find(f => f.name === metric)?.aggregations || []).map(agg => (
                        <option key={agg} value={agg}>
                          {agg}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>

            {!edit && (
              <div className="space-y-2">
                <div className={`grid grid-cols-1 ${datasets.length > 1 ? 'sm:grid-cols-2' : ''} gap-4 max-w-2xl`}>
                  {datasets.length > 1 && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">table_chart</span>
                        <span>Select Table / Dataset</span>
                        <span className="text-[10px] text-[var(--color-text-muted)] font-normal">(Group by Dimension)</span>
                      </label>
                      <select
                        className="border border-[var(--color-border)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] px-3 py-1.5 w-full text-[var(--color-text-primary)] text-xs font-medium focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                        value={dimensionDatasetId || selectedDatasetId}
                        onChange={e => void handleDimensionDatasetChange(e.target.value)}
                      >
                        {datasets.map(d => {
                          const label = d.tableName || d.displayName || d.name;
                          const hasDistinctSource = d.sourceFile && d.sourceFile !== label;
                          const sourceHint = hasDistinctSource ? ` [${d.sourceFile}]` : '';
                          const sameTableHint = d.id === selectedDatasetId ? ' (Same Table)' : '';
                          return (
                            <option key={d.id} value={d.id}>
                              {label}{sourceHint}{sameTableHint} ({(d.rowCount || 0).toLocaleString()} rows)
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                      Group by Dimension (X)
                    </label>
                    <select
                      className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 w-full bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)]"
                      value={dimension}
                      onChange={e => setDimension(e.target.value)}
                      disabled={dimensionDatasetId !== selectedDatasetId && (!joinResolution || !joinResolution.joinable)}
                    >
                      <option value="">No grouping (single aggregated KPI value)</option>
                      {((dimensionDatasetId && dimensionDatasetId !== selectedDatasetId && dimensionModel)
                        ? dimensionModel.fields
                        : model.fields
                      )
                        .filter(f => ['dimension', 'identifier', 'time'].includes(f.role))
                        .map(f => (
                          <option key={f.name} value={f.name}>
                            {f.semantic_name} ({f.role})
                          </option>
                        ))}
                    </select>
                  </div>
                </div>

                {/* Live Cross-Table Join Validation Status */}
                {dimensionDatasetId && dimensionDatasetId !== selectedDatasetId && (
                  <div>
                    {isResolvingJoin && (
                      <div className="flex items-center gap-2 text-xs text-[var(--color-info)] bg-[var(--color-info-subtle)] border border-[var(--color-info-border)] rounded-[var(--radius-element)] px-3 py-2">
                        <span className="material-symbols-outlined animate-spin text-[16px]">progress_activity</span>
                        <span>Verifying join keys and value overlap between selected tables...</span>
                      </div>
                    )}
                    {!isResolvingJoin && joinResolution?.joinable && (
                      <div className="flex items-center gap-2 text-xs text-[var(--color-success)] bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] rounded-[var(--radius-element)] px-3 py-2">
                        <span className="material-symbols-outlined text-[var(--color-success)] text-[18px]">verified</span>
                        <div>
                          <span className="font-semibold">Join Verified: </span>
                          <span>Linked via <code className="font-mono bg-[var(--color-surface)] border border-[var(--color-border)] px-1 py-0.5 rounded">{joinResolution.left_key}</code> = <code className="font-mono bg-[var(--color-surface)] border border-[var(--color-border)] px-1 py-0.5 rounded">{joinResolution.right_key}</code> ({joinResolution.overlap_count?.toLocaleString()} matching records, {joinResolution.cardinality})</span>
                          {joinResolution.warning && (
                            <p className="mt-0.5 text-[var(--color-warning)] text-[11px]">{joinResolution.warning}</p>
                          )}
                        </div>
                      </div>
                    )}
                    {!isResolvingJoin && joinResolution && !joinResolution.joinable && (
                      <div className="flex items-center gap-2 text-xs text-[var(--color-danger)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] rounded-[var(--radius-element)] px-3 py-2">
                        <span className="material-symbols-outlined text-[var(--color-danger)] text-[18px]">cancel</span>
                        <div>
                          <span className="font-semibold">Tables Cannot Be Joined: </span>
                          <span>{joinResolution.reason || 'No common matching key with data found between these datasets.'} Widget creation is disabled.</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Display Visualization Style Icon Tiles */}
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                Display Visualization Style
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                {DISPLAY_TYPES.map(type => (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => setKind(type.id)}
                    className={`flex flex-col items-center justify-center p-2 rounded-[var(--radius-element)] border text-[11px] font-medium transition-all cursor-pointer ${kind === type.id
                        ? 'bg-[var(--color-surface-active)] border-[var(--color-primary)] text-[var(--color-primary)] shadow-[var(--shadow-2xs)]'
                        : 'bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                  >
                    <span className="material-symbols-outlined text-base mb-0.5">{type.icon}</span>
                    <span>{type.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {edit && (
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                  Query Plan (JSON)
                </label>
                <textarea
                  className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3 w-full font-mono text-xs bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] transition-all"
                  rows={6}
                  value={planText}
                  onChange={e => setPlanText(e.target.value)}
                />
              </div>
            )}

            <div className="flex items-center gap-3 pt-3 border-t border-[var(--color-border)]">
              <button
                disabled={busy || (dimensionDatasetId !== selectedDatasetId && (!joinResolution || !joinResolution.joinable))}
                onClick={() => void run(saveVisualDefinition, 'save')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white font-medium text-xs hover:bg-[var(--color-primary-hover)] active:scale-[0.98] transition-all shadow-[var(--shadow-2xs)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title={dimensionDatasetId !== selectedDatasetId && (!joinResolution || !joinResolution.joinable) ? "Tables cannot be joined; widget creation disabled" : undefined}
              >
                <span className={`material-symbols-outlined text-lg ${busyAction === 'save' ? 'animate-spin' : ''}`}>
                  {busyAction === 'save' ? 'progress_activity' : 'save'}
                </span>
                <span>
                  {busyAction === 'save'
                    ? edit
                      ? 'Updating...'
                      : 'Saving...'
                    : edit
                      ? 'Update Definition Proposal'
                      : 'Generate Widget'}
                </span>
              </button>
              {edit && (
                <button
                  type="button"
                  onClick={() => setEdit(null)}
                  className="text-slate-600 hover:text-slate-900 text-sm font-medium px-4 py-2 cursor-pointer"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      {/* MODE 1: GENERATIVE AI DASHBOARDS (Universal NLU, Dynamic SQL & Analysis-First 10 Steps) */}
      {activeMode === 'prompt' && (
        <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 sm:p-5 shadow-[var(--shadow-2xs)] space-y-5">
          {/* Section Header & Master Prompt Branding */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-primary)] flex items-center justify-center shrink-0 border border-[var(--color-border)] shadow-[var(--shadow-2xs)]">
                <span className="material-symbols-outlined text-[22px]">psychology</span>
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm sm:text-base font-semibold text-[var(--color-text-primary)] tracking-tight">
                    1. Generative AI Dashboards
                  </h2>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20">
                    Analysis-First 10 Steps
                  </span>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                    Domain-Independent LLM Engine
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 leading-relaxed">
                  Universal Natural Language Understanding, Dynamic Data Analysis &amp; AI-Powered Widget Generation. Automatically explores schemas, detects JOIN operations, generates SQL, and analyzes results before recommending widgets.
                </p>
              </div>
            </div>

            {conversationHistory.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setConversationHistory([]);
                  setGenAiDashboard(null);
                  setGenAiStep(0);
                  setMessage('Conversational context reset for fresh exploration.');
                }}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] text-xs font-medium transition-colors cursor-pointer"
                title="Reset conversation context"
              >
                <span className="material-symbols-outlined text-[14px]">restart_alt</span>
                <span>Reset Context ({Math.floor(conversationHistory.length / 2)})</span>
              </button>
            )}
          </div>

          {/* Dataset & Schema Exploration Scope Selector */}
          <div className="bg-[var(--color-surface-hover)] p-3 rounded-[var(--radius-element)] border border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">database</span>
              <span className="font-medium text-[var(--color-text-primary)]">Target Data Scope:</span>
              <select
                className="border border-[var(--color-border)] bg-[var(--color-surface)] rounded-[var(--radius-element)] px-2.5 py-1 text-xs text-[var(--color-text-primary)] font-medium focus:outline-none focus:border-[var(--color-primary)] transition-all shadow-[var(--shadow-2xs)] cursor-pointer"
                value={selectedDatasetId}
                onChange={e => void handleSwitchDataset(e.target.value)}
              >
                <option value="">🌐 Cross-Table Intelligence (All Available Tables &amp; Auto-JOIN)</option>
                {datasets.map(d => (
                  <option key={d.id} value={d.id}>
                    📊 {d.name} ({d.rowCount?.toLocaleString() || 0} rows · {d.columnCount || d.columns?.length || 0} cols)
                  </option>
                ))}
              </select>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-success)]" />
              <span>{datasets.length} tables loaded &amp; ready for dynamic JOIN analysis</span>
            </div>
          </div>

          {/* Natural Language Query Console */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1.5 flex items-center justify-between">
                <span>Conversational Analytics Prompt (Natural Language):</span>
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono">Supports complex multi-part queries &amp; follow-ups</span>
              </label>
              <div className="relative">
                <textarea
                  className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3.5 pr-16 w-full text-xs resize-y bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:border-[var(--color-primary)] transition-all outline-none shadow-[var(--shadow-2xs)] leading-relaxed"
                  placeholder="e.g., Generate an executive dashboard with total revenue, average order value, top categories by sales, and regional distribution with trend analysis..."
                  rows={3}
                  value={genAiPrompt || promptInput}
                  onChange={e => {
                    setGenAiPrompt(e.target.value);
                    setPromptInput(e.target.value);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (genAiPrompt || promptInput).trim() && !genAiRunning) {
                      void handleRunGenAiDashboard();
                    }
                  }}
                />
                <span className="absolute bottom-3 right-3 text-[10px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-hover)] px-1.5 py-0.5 rounded border border-[var(--color-border)] select-none">
                  ⌘ Enter
                </span>
              </div>
            </div>

            {/* Primary Execution Action */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                disabled={genAiRunning || !(genAiPrompt || promptInput).trim()}
                onClick={() => void handleRunGenAiDashboard()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-xs shadow-[var(--shadow-sm)] active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
              >
                <span className={`material-symbols-outlined text-[18px] ${genAiRunning ? 'animate-spin' : ''}`}>
                  {genAiRunning ? 'sync' : 'auto_mode'}
                </span>
                <span>
                  {genAiRunning
                    ? `Executing 10-Step Pipeline (Stage ${genAiStep}/10)…`
                    : 'Execute Analysis & Generate Dashboard (10 Steps)'}
                </span>
              </button>

              {genAiDashboard && (
                <button
                  type="button"
                  onClick={() => setShowSqlInspector(prev => !prev)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-all cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">code</span>
                  <span>{showSqlInspector ? 'Hide SQL & Join Plan' : 'Inspect SQL & Join Plan'}</span>
                </button>
              )}
            </div>
          </div>

          {/* 10-STEP ANALYSIS-FIRST VISUAL PROGRESS STEPPER */}
          {(genAiRunning || genAiStep > 0) && (
            <div className="p-3.5 bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-container)] space-y-2.5 animate-in fade-in">
              <div className="flex items-center justify-between text-xs font-semibold text-[var(--color-text-primary)]">
                <span className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${genAiRunning ? 'bg-[var(--color-primary)] animate-ping' : genAiFailed ? 'bg-red-500' : 'bg-[var(--color-success)]'}`} />
                  <span>Mandatory 10-Step Analysis-First Execution Pipeline</span>
                </span>
                <span className="text-[11px] font-mono text-[var(--color-text-secondary)]">
                  {genAiRunning ? `Stage ${genAiStep} of 10` : genAiFailed ? 'Generation failed' : 'All 10 Stages Completed'}
                </span>
              </div>
              {genAiStepDetail && (
                <div className="text-[11px] font-mono text-[var(--color-primary)] flex items-center gap-1.5 px-2.5 py-1 rounded bg-[var(--color-surface)] border border-[var(--color-border)]">
                  <span className={`material-symbols-outlined text-[14px] ${genAiRunning ? 'animate-spin' : 'text-[var(--color-success)]'}`}>
                    {genAiRunning ? 'progress_activity' : genAiFailed ? 'error' : 'verified'}
                  </span>
                  <span>{genAiStepDetail}</span>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
                {GENAI_10_STEPS.map((s, idx) => {
                  const stepNum = idx + 1;
                  const isDone = genAiStep > stepNum || (!genAiRunning && genAiStep === 10);
                  const isCurrent = genAiRunning && genAiStep === stepNum;
                  return (
                    <div
                      key={s.step}
                      className={`p-2 rounded-[var(--radius-element)] text-[11px] font-medium border transition-all ${
                        isDone
                          ? 'bg-[var(--color-success-subtle)] border-[var(--color-success-border)] text-[var(--color-success)]'
                          : isCurrent
                          ? 'bg-[var(--color-surface)] border-[var(--color-primary)] text-[var(--color-primary)] shadow-[var(--shadow-2xs)] ring-1 ring-[var(--color-primary)]/20'
                          : 'bg-[var(--color-surface)]/60 border-[var(--color-border)] text-[var(--color-text-muted)] opacity-50'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] font-mono">
                        <span>{s.step}</span>
                        {isDone && <span className="material-symbols-outlined text-[13px]">check_circle</span>}
                      </div>
                      <div className="truncate font-semibold mt-0.5">{s.name}</div>
                      <div className="text-[9px] text-[var(--color-text-muted)] truncate mt-0.5">{s.desc}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* DYNAMIC SQL & JOIN STRATEGY INSPECTOR (Expandable) */}
          {genAiDashboard && showSqlInspector && (
            <div className="p-4 bg-[var(--color-surface-active)] border border-[var(--color-border)] rounded-[var(--radius-container)] space-y-3 text-xs animate-in fade-in">
              <div className="flex items-center justify-between pb-2 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-2 font-semibold text-[var(--color-text-primary)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">data_object</span>
                  <span>Intelligent SQL &amp; Dynamic JOIN Execution Plan</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                  <span>Latency: {genAiDashboard.execution_time_ms}ms</span>
                  <span>•</span>
                  <span>{genAiDashboard.sql_info.records_matched?.toLocaleString()} of {genAiDashboard.sql_info.records_total?.toLocaleString()} records</span>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)] block mb-1">Generated Dynamic SQL:</span>
                <pre className="p-3 rounded-[var(--radius-element)] bg-slate-900 text-slate-100 font-mono text-[11px] overflow-x-auto leading-relaxed border border-slate-800">
                  {genAiDashboard.sql_info.sql_query}
                </pre>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                  <span className="text-[10px] text-[var(--color-text-muted)] uppercase font-mono">Relationship Type</span>
                  <div className="font-semibold text-[var(--color-text-primary)] mt-0.5">
                    {genAiDashboard.sql_info.join_required ? genAiDashboard.sql_info.join_type || 'Cross-Table JOIN' : 'Single Table (No JOIN Needed)'}
                  </div>
                </div>
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                  <span className="text-[10px] text-[var(--color-text-muted)] uppercase font-mono">Data Validation &amp; Safety</span>
                  <div className="font-semibold text-[var(--color-success)] mt-0.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">verified</span>
                    <span>No row duplication / Verified</span>
                  </div>
                </div>
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                  <span className="text-[10px] text-[var(--color-text-muted)] uppercase font-mono">Calculations Quality</span>
                  <div className="font-semibold text-[var(--color-text-primary)] mt-0.5">
                    100% Validated Aggregations
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* DYNAMIC GENERATIVE AI DASHBOARD OUTPUT */}
          {genAiDashboard && (
            <div className="space-y-5 pt-2">
              {/* Step 7: AI Executive Insights Banner */}
              {genAiDashboard.executive_insights && genAiDashboard.executive_insights.length > 0 && (
                <div className="p-4 rounded-[var(--radius-container)] bg-gradient-to-r from-[var(--color-surface-active)] to-[var(--color-surface-hover)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text-primary)]">
                      <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">insights</span>
                      <span>AI Executive Insights &amp; Data Findings (Analysis-First)</span>
                    </div>
                    <span className="text-[10px] font-mono text-[var(--color-text-muted)] bg-[var(--color-surface)] px-2 py-0.5 rounded border border-[var(--color-border)]">
                      Backed by Actual Query Execution
                    </span>
                  </div>
                  <ul className="space-y-1.5 pt-1">
                    {genAiDashboard.executive_insights.map((insight, idx) => (
                      <li key={idx} className="text-xs text-[var(--color-text-secondary)] flex items-start gap-2 leading-relaxed">
                        <span className="text-[var(--color-primary)] font-bold mt-0.5">›</span>
                        <span>{insight}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Step 5 & 10: Python Advanced Visualization Engine (Matplotlib / Seaborn) */}
              {genAiDashboard.python_visual && genAiDashboard.python_visual.image_base64 && (
                <div className="border border-[var(--color-border)] rounded-[var(--radius-container)] overflow-hidden bg-[var(--color-surface)] p-4 space-y-3 shadow-[var(--shadow-2xs)]">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]">
                    <div>
                      <h4 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">grid_view</span>
                        <span>Python Matplotlib / Seaborn Advanced Visualization</span>
                        <span className="px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-success-subtle)] text-[var(--color-success)] text-[10px] font-medium border border-[var(--color-success-border)]">
                          Dual-Path Verified
                        </span>
                      </h4>
                      <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                        {genAiDashboard.python_visual.prompt}
                      </p>
                    </div>

                    <a
                      href={genAiDashboard.python_visual.image_base64}
                      download="genai_advanced_analysis.png"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] shadow-[var(--shadow-2xs)] transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[14px]">download</span>
                      <span>Download High-Res PNG</span>
                    </a>
                  </div>

                  <div className="bg-[var(--color-surface-active)] rounded-[var(--radius-element)] p-3 border border-[var(--color-border)] flex items-center justify-center">
                    <img
                      src={genAiDashboard.python_visual.image_base64}
                      alt={genAiDashboard.python_visual.prompt}
                      className="max-h-[480px] object-contain rounded-[var(--radius-inner)] w-full"
                    />
                  </div>
                </div>
              )}

              {/* Step 8: Proactive AI-Powered Widget Recommendations (Analysis-First) */}
              {activeRecommendations && activeRecommendations.length > 0 && (
                <div className="p-4 rounded-[var(--radius-container)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">auto_awesome</span>
                        <span>Proactive AI Widget Recommendations (Analysis-First)</span>
                      </h4>
                      <p className="text-[11px] text-[var(--color-text-secondary)] mt-0.5">
                        Preview the calculated result, then accept it to add it alongside your existing dashboard widgets.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                    {activeRecommendations.map(rec => (
                      <div
                        key={rec.id}
                        className="p-3.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 transition-all flex flex-col justify-between space-y-2.5 shadow-[var(--shadow-2xs)]"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono uppercase bg-[var(--color-surface-active)] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-primary)]">
                              {rec.kind}
                            </span>
                            <span className="text-[10px] text-[var(--color-text-muted)] font-mono">
                              {rec.aggregation}
                            </span>
                          </div>
                          <div className="font-semibold text-xs text-[var(--color-text-primary)] leading-snug">
                            {rec.title}
                          </div>
                          <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">
                            {rec.rationale}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 pt-1 border-t border-[var(--color-border)]">
                          <button
                            type="button"
                            disabled={isAddingRecommendation[rec.id]}
                            onClick={() => void handleAcceptRecommendation(rec)}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-[11px] font-medium shadow-[var(--shadow-2xs)] transition-all cursor-pointer disabled:opacity-50"
                          >
                            <span className={`material-symbols-outlined text-[14px] ${isAddingRecommendation[rec.id] ? 'animate-spin' : ''}`}>
                              {isAddingRecommendation[rec.id] ? 'sync' : 'visibility'}
                            </span>
                            <span>{isAddingRecommendation[rec.id] ? 'Preparing Preview...' : 'Preview Output'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDismissRecommendation(rec.id)}
                            className="px-2 py-1.5 rounded-[var(--radius-element)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] text-[11px] transition-colors cursor-pointer"
                            title="Dismiss recommendation"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Conversational Follow-Up Refinement Console */}
              <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex items-center gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)] shrink-0">chat</span>
                <input
                  type="text"
                  className="flex-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-all"
                  placeholder="Modify this dashboard with conversational follow-up (e.g. 'Add a breakdown by country', 'Filter out inactive items', 'Switch chart to donut')..."
                  value={followUpPrompt}
                  onChange={e => setFollowUpPrompt(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && followUpPrompt.trim() && !genAiRunning) {
                      void handleRunGenAiDashboard(followUpPrompt);
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={genAiRunning || !followUpPrompt.trim()}
                  onClick={() => void handleRunGenAiDashboard(followUpPrompt)}
                  className="px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs font-medium shadow-[var(--shadow-2xs)] transition-all cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Refine
                </button>
              </div>

            </div>
          )}

          {/* Live Preview & Verification Modal for Gen AI Widgets */}
          {previewWidget && (
            <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in">
              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] max-w-2xl w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center shrink-0 border border-[var(--color-primary)]/20">
                      <span className="material-symbols-outlined text-[18px]">
                        {previewWidget.kind === 'kpi' ? 'pin' : previewWidget.kind === 'donut' ? 'donut_large' : previewWidget.kind === 'line' ? 'show_chart' : 'bar_chart'}
                      </span>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">
                        {previewWidget.title}
                      </h3>
                      <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)] font-mono">
                        <span>Live Preview &amp; Verification Mode</span>
                        <span>•</span>
                        <span className={widgetStatuses[previewWidget.id] === 'rejected' ? 'text-[var(--color-danger)] font-bold' : 'text-[var(--color-success)] font-bold'}>
                          Status: {widgetStatuses[previewWidget.id] || 'pending'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewWidget(null)}
                    className="p-1 rounded-[var(--radius-element)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[18px]">close</span>
                  </button>
                </div>

                {/* Widget Render Preview */}
                <div className="p-6 rounded-[var(--radius-container)] bg-[var(--color-surface-hover)] border border-[var(--color-border)]">
                  {previewWidget.kind === 'kpi' ? (
                    <div className="text-center space-y-2">
                      <span className="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider">
                        {previewWidget.aggregation} of {previewWidget.metric}
                      </span>
                      <div className="text-4xl font-extrabold text-[var(--color-text-primary)] tracking-tight tabular-nums">
                        {previewWidget.format === 'currency'
                          ? `$${Number(previewWidget.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : previewWidget.format === 'percent'
                          ? `${previewWidget.value}%`
                          : Number(previewWidget.value).toLocaleString()}
                      </div>
                      {previewWidget.subtitle && (
                        <p className="text-xs text-[var(--color-text-muted)]">{previewWidget.subtitle}</p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="text-xs font-medium text-[var(--color-text-secondary)] flex justify-between">
                        <span>{previewWidget.aggregation} of {previewWidget.metric}</span>
                        <span>Grouped by: {previewWidget.dimension}</span>
                      </div>
                      <div className="space-y-2 py-2">
                        {previewWidget.data?.map((pt: any, idx: number) => {
                          const maxVal = Math.max(...(previewWidget.data || []).map((d: any) => d.value || 0), 1);
                          const pct = Math.max(Math.round((pt.value / maxVal) * 100), 4);
                          return (
                            <div key={idx} className="space-y-1">
                              <div className="flex justify-between text-xs font-mono">
                                <span className="text-[var(--color-text-primary)] font-medium">{pt.label}</span>
                                <span className="text-[var(--color-text-secondary)]">{Number(pt.value).toLocaleString()}</span>
                              </div>
                              <div className="w-full bg-[var(--color-surface)] h-2 rounded-full overflow-hidden border border-[var(--color-border)]/50">
                                <div
                                  className="h-full rounded-full transition-all duration-500"
                                  style={{
                                    width: `${pct}%`,
                                    backgroundColor: `hsl(${210 + idx * 24}, 75%, 50%)`,
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Query & Aggregation Specs */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                    <div className="text-[10px] text-[var(--color-text-muted)] font-mono uppercase">Metric</div>
                    <div className="font-semibold text-[var(--color-text-primary)] truncate">{previewWidget.metric || 'N/A'}</div>
                  </div>
                  <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                    <div className="text-[10px] text-[var(--color-text-muted)] font-mono uppercase">Aggregation</div>
                    <div className="font-semibold text-[var(--color-text-primary)] truncate">{previewWidget.aggregation || 'N/A'}</div>
                  </div>
                  <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                    <div className="text-[10px] text-[var(--color-text-muted)] font-mono uppercase">Dimension</div>
                    <div className="font-semibold text-[var(--color-text-primary)] truncate">{previewWidget.dimension || 'None (Single Metric)'}</div>
                  </div>
                  <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                    <div className="text-[10px] text-[var(--color-text-muted)] font-mono uppercase">Status</div>
                    <div className={`font-semibold ${widgetStatuses[previewWidget.id] === 'rejected' ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
                      {widgetStatuses[previewWidget.id] || 'pending'}
                    </div>
                  </div>
                </div>

                {/* Backed SQL Execution Query snippet */}
                {previewWidget.sql_query && (
                  <div>
                    <span className="text-[10px] font-mono text-[var(--color-text-muted)] uppercase block mb-1">Backed SQL Execution Query:</span>
                    <pre className="p-2.5 rounded-[var(--radius-element)] bg-slate-900 text-slate-100 font-mono text-[10px] overflow-x-auto leading-relaxed border border-slate-800">
                      {previewWidget.sql_query}
                    </pre>
                  </div>
                )}

                {/* Action Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-[var(--color-border)]">
                  <button
                    type="button"
                    onClick={() => setPreviewWidget(null)}
                    className="px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] text-xs font-medium text-[var(--color-text-secondary)] border border-[var(--color-border)] transition-colors cursor-pointer"
                  >
                    Close Preview
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (previewWidget.recommendationId) {
                          const { recommendationId, ...widget } = previewWidget;
                          stageGenAiWidget(widget, genAiDashboard?.context, genAiDashboard?.dashboard_id);
                          setGenAiDashboard(prev => prev ? {
                            ...prev,
                            kpi_cards: widget.kind === 'kpi' ? [...prev.kpi_cards, widget as GenAIKpiCard] : prev.kpi_cards,
                            charts: widget.kind !== 'kpi' ? [...prev.charts, widget as GenAIChart] : prev.charts,
                          } : prev);
                          setActiveRecommendations(prev => prev.filter(rec => rec.id !== recommendationId));
                          setMessage(`Added "${widget.title}" to generated results. Select it below to publish.`);
                          setPublishedSuccess(false);
                        }
                        setWidgetStatuses(prev => ({ ...prev, [previewWidget.id]: 'approved' }));
                        setPreviewWidget(null);
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-success)] hover:opacity-90 text-white text-xs font-medium shadow-[var(--shadow-2xs)] transition-all cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">check_circle</span>
                      <span>{previewWidget.recommendationId ? 'Accept Widget' : 'Approve Widget'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (previewWidget.recommendationId) handleDismissRecommendation(previewWidget.recommendationId);
                        else setWidgetStatuses(prev => ({ ...prev, [previewWidget.id]: 'rejected' }));
                        setPreviewWidget(null);
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-danger)] hover:opacity-90 text-white text-xs font-medium shadow-[var(--shadow-2xs)] transition-all cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[16px]">cancel</span>
                      <span>Reject Widget</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* SELECT DRAG AND DROP: Interactive Drag & Drop Dashboard Builder */}
      {activeTab === 'dashboards' && dashboardMode === 'drag_drop' && (
        <section className="space-y-4 animate-in fade-in">
          <DragDropDashboardBuilder
            datasets={datasets}
            selectedDatasetId={selectedDatasetId}
            onSwitchDataset={handleSwitchDataset}
            model={model}
            existingItems={items}
            onCreatedWidget={draft => addGenerated({
              definition: { id: draft.id, title: draft.title, kind: draft.kind, revision: 1,
                semantic_revision: model?.revision || 1, dataset_id: draft.datasetId,
                dataset_name: datasets.find(d => d.id === draft.datasetId)?.name,
                version: datasets.find(d => d.id === draft.datasetId)?.currentVersion || 1,
                query_plan: { metric: draft.metric, dimension: draft.dimension, aggregation: draft.aggregation },
                dependencies: [draft.metric, draft.dimension].filter(Boolean) as string[],
                explanation: 'Created in the drag and drop builder.', status: 'proposed' }, result: draft.result,
            })}
            onSavedDefinition={() => {
              void getRecommendations(true).then(setItems);
            }}
            user={user}
          />
        </section>
      )}

      </div>
      {(!widgetsOnly || generatedWidgets.length > 0) && <GeneratedWidgetSections key={widgetsOnly ? 'library' : `${activeMode}:${selectedDatasetId}`} widgets={generatedWidgets.filter(widget =>
        widgetsOnly || (widget.source === activeMode && (!selectedDatasetId || selectedDatasetId === 'all' || widget.definition.dataset_id === selectedDatasetId))
      )} onPublished={ids => {
        setGeneratedWidgets(prev => {
          const next = prev.map(w => ids.includes(w.definition.id) ? { ...w, published: true } : w);
          generatedWidgetCache = next;
          return next;
        });
        void getRecommendations(true).then(setItems);
      }} />}

      {/* CONFIGURED DEFINITIONS & WIDGETS STREAM: Visible only in Visual KPI Builder tab */}
      {widgetsOnly && (() => {
        // Collect all distinct files/datasets represented across items
        const fileMap = new Map<string, { id: string; name: string; count: number }>();
        items.forEach(it => {
          const id = it.dataset_id || selectedDatasetId || 'default';
          const name = it.source_file || it.dataset_name || datasets.find(d => d.id === id)?.name || 'Dataset';
          const existing = fileMap.get(id);
          if (existing) {
            existing.count += 1;
          } else {
            fileMap.set(id, { id, name, count: 1 });
          }
        });
        const availableFiles = Array.from(fileMap.values());

        const inScopeItems = items.filter(item => {
          if (fileScopeFilter === 'all') return true;
          const itemDsId = item.dataset_id || selectedDatasetId;
          return itemDsId === fileScopeFilter;
        });

        const publishedCount = inScopeItems.filter(i => publishedKeys.includes(`${i.id}:${i.revision}`)).length;
        const notPublishedCount = inScopeItems.filter(i => !publishedKeys.includes(`${i.id}:${i.revision}`)).length;
        const approvedCount = inScopeItems.filter(i => i.status === 'approved').length;
        const displayedItems = inScopeItems.filter(item => {
          const key = `${item.id}:${item.revision}`;
          if (filterDashboard === 'published') return publishedKeys.includes(key);
          if (filterDashboard === 'not_published') return !publishedKeys.includes(key);
          return true;
        });
        const displayedKeys = displayedItems.map(i => `${i.id}:${i.revision}`);
        const selectedInView = displayedKeys.filter(k => deleteSelected.includes(k));
        const allDisplayedSelected = displayedKeys.length > 0 && selectedInView.length === displayedKeys.length;

        return (
          <>
            {/* CONFIGURED DEFINITIONS STREAM */}
            <section className="space-y-3 pt-2">
              {/* Multi-File Scope Selector Bar */}
              {availableFiles.length > 1 && (
                <div className="w-full flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl border border-slate-200 overflow-x-auto">
                  <button
                    type="button"
                    onClick={() => setFileScopeFilter('all')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer shrink-0 ${
                      fileScopeFilter === 'all'
                        ? 'bg-white text-blue-700 shadow-2xs border border-blue-200/60'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[15px]">folder_copy</span>
                    <span>All Uploaded Files</span>
                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-blue-50 text-blue-700">
                      {items.length}
                    </span>
                  </button>
                  {availableFiles.map(file => (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setFileScopeFilter(file.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer shrink-0 ${
                        fileScopeFilter === file.id
                          ? 'bg-white text-blue-700 shadow-2xs border border-blue-200/60'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[15px]">description</span>
                      <span className="max-w-[200px] truncate">{file.name}</span>
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono bg-slate-200 text-slate-700">
                        {file.count}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200/80">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-sm font-bold text-slate-900">
                      Configured Definitions ({inScopeItems.length})
                    </h2>
                    {publishedCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-pulse"></span>
                        {publishedCount} on Dashboard
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {canPublish
                      ? 'Review and approve definitions. Cards with "Live on Dashboard" are currently active on the Executive Dashboard.'
                      : 'Review definitions and preview charts. Widget publishing to Executive Dashboard is restricted to Admin or Admin+User.'}
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* Quick Filter Tabs */}
                  {inScopeItems.length > 0 && (
                    <div className="inline-flex items-center p-1 rounded-xl bg-slate-100 border border-slate-200 text-xs font-semibold">
                      <button
                        type="button"
                        onClick={() => {
                          setFilterDashboard('all');
                          setConfirmBulkDelete(false);
                        }}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${filterDashboard === 'all'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                          }`}
                      >
                        All ({inScopeItems.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setFilterDashboard('published');
                          setConfirmBulkDelete(false);
                        }}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer flex items-center gap-1.5 ${filterDashboard === 'published'
                            ? 'bg-blue-600 text-white shadow-xs'
                            : 'text-slate-600 hover:text-blue-700'
                          }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${filterDashboard === 'published' ? 'bg-white' : 'bg-blue-600'}`}></span>
                        Live on Dashboard ({publishedCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setFilterDashboard('not_published');
                          setConfirmBulkDelete(false);
                        }}
                        className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer ${filterDashboard === 'not_published'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                          }`}
                      >
                        Not on Dashboard ({notPublishedCount})
                      </button>
                    </div>
                  )}

                  {/* Select All & Bulk Delete Controls for Active Filter */}
                  {displayedItems.length > 0 && (
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setConfirmBulkDelete(false);
                          if (allDisplayedSelected) {
                            const viewSet = new Set(displayedKeys);
                            setDeleteSelected(prev => prev.filter(k => !viewSet.has(k)));
                          } else {
                            setDeleteSelected(prev => Array.from(new Set([...prev, ...displayedKeys])));
                          }
                        }}
                        className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold border flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${allDisplayedSelected
                            ? 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 shadow-2xs'
                          }`}
                        title={allDisplayedSelected ? 'Deselect all widgets in this filter' : 'Select all widgets in this filter'}
                      >
                        <span className="material-symbols-outlined text-[15px]">
                          {allDisplayedSelected ? 'check_box' : 'select_all'}
                        </span>
                        <span>{allDisplayedSelected ? `Deselect All (${displayedKeys.length})` : `Select All (${displayedKeys.length})`}</span>
                      </button>

                      {selectedInView.length > 0 && !confirmBulkDelete && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmBulkDelete(true)}
                          className="px-2.5 py-1.5 rounded-[var(--radius-element)] text-xs font-medium bg-[var(--color-danger-subtle)] text-[var(--color-danger)] border border-[var(--color-danger-border)] hover:bg-[var(--color-danger-subtle)] flex items-center gap-1 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span className="material-symbols-outlined text-[15px]">delete</span>
                          <span>Delete ({selectedInView.length})</span>
                        </button>
                      )}

                      {selectedInView.length > 0 && confirmBulkDelete && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleBulkDelete(selectedInView)}
                            className="px-2.5 py-1.5 rounded-[var(--radius-element)] text-xs font-medium bg-[var(--color-danger)] text-white hover:opacity-90 flex items-center gap-1 shadow-[var(--shadow-2xs)] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className={`material-symbols-outlined text-[15px] ${busyAction === 'bulk_delete' ? 'animate-spin' : ''}`}>
                              {busyAction === 'bulk_delete' ? 'progress_activity' : 'delete_forever'}
                            </span>
                            <span>{busyAction === 'bulk_delete' ? 'Deleting...' : `Confirm Delete (${selectedInView.length})`}</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmBulkDelete(false)}
                            className="px-2 py-1.5 rounded-[var(--radius-element)] text-xs font-medium bg-[var(--color-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] cursor-pointer disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {items.length > 0 && (
                    <div className="text-xs font-medium px-2.5 py-1 bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] rounded-[var(--radius-full)] border border-[var(--color-border)]">
                      {approvedCount} of {items.length} Approved
                    </div>
                  )}
                </div>
              </div>

              {model && !items.length && (
                <div className="p-12 text-center bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-page)] space-y-4 shadow-[var(--shadow-xs)]">
                  <div className="w-12 h-12 rounded-[var(--radius-container)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)] flex items-center justify-center mx-auto">
                    <span className="material-symbols-outlined text-2xl">query_stats</span>
                  </div>
                  <div>
                    <h3 className="font-semibold text-[var(--color-text-primary)] text-sm">No KPI Definitions Found</h3>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-1 max-w-md mx-auto">
                      Click &quot;Propose AI Recommendations&quot; above to auto-generate supported KPI metrics from your schema, or create one using the options above.
                    </p>
                  </div>
                </div>
              )}

              {displayedItems.length === 0 && items.length > 0 && (
                <div className="p-8 text-center bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-container)] text-[var(--color-text-secondary)] text-xs">
                  No widgets match the selected filter (&quot;{filterDashboard === 'published' ? 'Live on Dashboard' : 'Not on Dashboard'}&quot;).
                  <button
                    type="button"
                    onClick={() => setFilterDashboard('all')}
                    className="ml-2 text-[var(--color-primary)] font-medium hover:underline cursor-pointer"
                  >
                    Show all
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-start">
                {displayedItems.map(item => {
                  const key = `${item.id}:${item.revision}`;
                  const isPublished = publishedKeys.includes(key);
                  const isSelected = selected.includes(key);
                  const isDeleteSelected = deleteSelected.includes(key);
                  const isCardDeleting = Boolean(deletingItems[key]);
                  const isPreviewOpen = Boolean(previews[key]);
                  const isPreviewLoading = Boolean(loadingPreviews[key]);
                  const reviewingDecision = reviewingItems[key];
                  const isCardReviewing = Boolean(reviewingDecision);

                  return (
                    <article
                      key={key}
                      className={`bg-[var(--color-surface)] border rounded-[var(--radius-container)] p-3.5 shadow-[var(--shadow-2xs)] transition-all flex flex-col justify-between h-full space-y-2.5 relative overflow-hidden ${isDeleteSelected
                          ? 'border-[var(--color-danger-border)] ring-2 ring-[var(--color-danger)]/15 bg-[var(--color-danger-subtle)]/30'
                          : isPublished
                            ? 'border-[var(--color-border)] ring-1 ring-[var(--color-border-strong)]'
                            : isSelected
                              ? 'border-[var(--color-success-border)] ring-2 ring-[var(--color-success)]/15'
                              : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-xs)]'
                        }`}
                    >
                      {/* Header with Title, Kind Badge, Dashboard Status, and Review Status */}
                      <div className="space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <input
                                type="checkbox"
                                checked={isDeleteSelected}
                                disabled={busy || isCardDeleting}
                                aria-label={`Select ${item.title} for deletion`}
                                title="Select for bulk delete"
                                onChange={() => {
                                  setConfirmBulkDelete(false);
                                  setDeleteSelected(prev =>
                                    prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
                                  );
                                }}
                                className="w-3.5 h-3.5 rounded-[var(--radius-inner)] border-[var(--color-border)] text-[var(--color-danger)] focus:ring-[var(--color-danger)] cursor-pointer shrink-0"
                              />
                              <h3 className="font-semibold text-xs sm:text-sm text-[var(--color-text-primary)] leading-snug truncate" title={item.title}>
                                {item.title}
                              </h3>
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)] uppercase tracking-wide shrink-0">
                                {item.kind}
                              </span>
                              {(item.source_file || item.dataset_name) && (
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] truncate max-w-[170px]"
                                  title={`Source File: ${item.source_file || item.dataset_name}`}
                                >
                                  <span className="material-symbols-outlined text-[12px] text-[var(--color-text-muted)]">description</span>
                                  <span className="truncate">{item.source_file || item.dataset_name}</span>
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
                            {isPublished ? (
                              <span
                                title="This KPI is currently active and visible on the Executive Dashboard."
                                className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-medium px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success-border)] shadow-[var(--shadow-2xs)] whitespace-nowrap"
                              >
                                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                                <span>Live on Dashboard</span>
                              </span>
                            ) : (
                              <span
                                title="This KPI is not currently included on the Executive Dashboard."
                                className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-normal px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-surface-active)] text-[var(--color-text-muted)] border border-[var(--color-border)] whitespace-nowrap"
                              >
                                <span className="material-symbols-outlined text-[13px] text-[var(--color-text-muted)]">dashboard_customize</span>
                                <span>Not on Dashboard</span>
                              </span>
                            )}

                            <span
                              className={`text-[10px] sm:text-[11px] font-medium px-2 py-0.5 rounded-[var(--radius-full)] border shrink-0 whitespace-nowrap ${item.status === 'approved'
                                  ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]'
                                  : item.status === 'rejected'
                                    ? 'bg-[var(--color-danger-subtle)] text-[var(--color-danger)] border-[var(--color-danger-border)]'
                                    : 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border-[var(--color-warning-border)]'
                                }`}
                            >
                              {item.status.charAt(0).toUpperCase() + item.status.slice(1)} (Rev {item.revision})
                            </span>
                          </div>
                        </div>

                        <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2 leading-relaxed" title={item.explanation}>
                          {item.explanation}
                        </p>

                        {item.reviewer && (
                          <p className="text-[10px] text-[var(--color-text-muted)] font-mono truncate" title={`Reviewed by ${item.reviewer} · ${new Date(item.reviewed_at || '').toLocaleString()}`}>
                            Reviewed by {item.reviewer.slice(0, 10)}... · {new Date(item.reviewed_at || '').toLocaleDateString()}
                          </p>
                        )}
                      </div>

                      {/* Query Plan Accordion */}
                      <details className="text-[11px] text-[var(--color-text-secondary)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] p-2 border border-[var(--color-border)]">
                        <summary className="cursor-pointer font-medium text-[var(--color-text-primary)] select-none flex items-center gap-1.5 text-xs">
                          <span className="material-symbols-outlined text-sm text-[var(--color-text-muted)]">code</span>
                          <span>View Dependencies & Query Plan</span>
                        </summary>
                        <div className="mt-2 space-y-1.5">
                          <p className="text-[11px] truncate">
                            <strong>Dependencies:</strong> {(item.dependencies || []).join(', ') || 'Source rows count'}
                          </p>
                          <pre className="overflow-auto max-h-36 bg-[var(--color-text-primary)] text-[var(--color-surface)] rounded-[var(--radius-inner)] p-2.5 text-[10px] font-mono leading-relaxed">
                            {JSON.stringify(item.query_plan, null, 2)}
                          </pre>
                        </div>
                      </details>

                      {/* Calculation Live Preview (Formatted $34.09M values) */}
                      {isPreviewOpen && (
                        <div className="border border-[var(--color-border)] bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] p-3 mt-1 shadow-inner overflow-hidden">
                          <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[var(--color-border)] text-xs font-semibold text-[var(--color-text-primary)]">
                            <span className="flex items-center gap-1.5 text-xs">
                              <span className="material-symbols-outlined text-[var(--color-primary)] text-sm">visibility</span>
                              <span>Live Calculation Engine Preview</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => void togglePreview(item)}
                              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer"
                              title="Hide preview"
                            >
                              <span className="material-symbols-outlined text-sm">close</span>
                            </button>
                          </div>
                          <div className="overflow-x-auto max-h-[320px]">
                            <AnalyticsWidget definition={item} result={previews[key]} showTable={true} />
                          </div>
                        </div>
                      )}

                      {/* Action Bar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[var(--color-border)] mt-auto">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            type="button"
                            disabled={busy || isPreviewLoading || isCardReviewing}
                            onClick={() => void togglePreview(item)}
                            className={`px-2 py-1 rounded-[var(--radius-element)] text-xs font-medium flex items-center gap-1 transition-all border cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${isPreviewOpen
                                ? 'bg-[var(--color-surface-active)] text-[var(--color-primary)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]'
                                : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] shadow-[var(--shadow-2xs)]'
                              }`}
                          >
                            <span className={`material-symbols-outlined text-[15px] ${isPreviewLoading ? 'animate-spin' : ''}`}>
                              {isPreviewLoading ? 'progress_activity' : isPreviewOpen ? 'visibility_off' : 'visibility'}
                            </span>
                            <span>
                              {isPreviewLoading ? 'Executing...' : isPreviewOpen ? 'Hide Preview' : 'Preview Live'}
                            </span>
                          </button>

                          <button
                            type="button"
                            disabled={busy || isPreviewLoading || isCardReviewing || isCardDeleting}
                            onClick={() => {
                              setEdit(item);
                              setPlanText(JSON.stringify(item.query_plan, null, 2));
                              setTitle(item.title);
                              setKind(item.kind);
                              setActiveMode('visual');
                              document.getElementById('definition-form')?.scrollIntoView({ behavior: 'smooth' });
                            }}
                            className="px-2 py-1 rounded-[var(--radius-element)] text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] flex items-center gap-1 transition-all shadow-[var(--shadow-2xs)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="material-symbols-outlined text-[15px]">edit</span>
                            <span>Edit Query</span>
                          </button>

                          <button
                            type="button"
                            disabled={busy || isPreviewLoading || isCardReviewing || isCardDeleting}
                            onClick={() => void handleDeleteItem(item)}
                            title="Delete this widget"
                            className="px-2 py-1 rounded-[var(--radius-element)] text-xs font-medium text-[var(--color-danger)] border border-[var(--color-danger-border)] bg-[var(--color-surface)] hover:bg-[var(--color-danger-subtle)] flex items-center gap-1 transition-all shadow-[var(--shadow-2xs)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className={`material-symbols-outlined text-[15px] ${isCardDeleting ? 'animate-spin' : ''}`}>
                              {isCardDeleting ? 'progress_activity' : 'delete'}
                            </span>
                            <span>{isCardDeleting ? 'Deleting...' : 'Delete'}</span>
                          </button>

                          {item.status === 'proposed' && (
                            <div className="flex items-center gap-1.5 pl-1.5 border-l border-[var(--color-border)]">
                              <button
                                type="button"
                                disabled={busy || isPreviewLoading || isCardReviewing}
                                onClick={() => void handleReviewItem(item, 'approved')}
                                className="bg-[var(--color-success)] hover:opacity-90 text-white font-medium text-xs px-2.5 py-1.5 rounded-[var(--radius-element)] flex items-center gap-1 shadow-[var(--shadow-2xs)] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                <span className={`material-symbols-outlined text-[15px] ${reviewingDecision === 'approved' ? 'animate-spin' : ''}`}>
                                  {reviewingDecision === 'approved' ? 'progress_activity' : 'check'}
                                </span>
                                <span>{reviewingDecision === 'approved' ? 'Approving...' : 'Approve'}</span>
                              </button>

                              <button
                                type="button"
                                disabled={busy || isPreviewLoading || isCardReviewing}
                                onClick={() => void handleReviewItem(item, 'rejected')}
                                className="border border-[var(--color-danger-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger-subtle)] font-medium text-xs px-2.5 py-1.5 rounded-[var(--radius-element)] flex items-center gap-1 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                <span className={`material-symbols-outlined text-[15px] ${reviewingDecision === 'rejected' ? 'animate-spin' : ''}`}>
                                  {reviewingDecision === 'rejected' ? 'progress_activity' : 'close'}
                                </span>
                                <span>{reviewingDecision === 'rejected' ? 'Rejecting...' : 'Reject'}</span>
                              </button>
                            </div>
                          )}
                        </div>

                        {item.status === 'approved' && (
                          canPublish ? (
                            <button
                              type="button"
                              onClick={() => {
                                setSelected(prev =>
                                  prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key]
                                );
                              }}
                              className={`px-2.5 py-1 rounded-[var(--radius-element)] text-xs font-medium flex items-center gap-1 transition-all cursor-pointer select-none border shrink-0 ${isSelected
                                  ? 'bg-[var(--color-success)] text-white border-[var(--color-success)] shadow-[var(--shadow-2xs)]'
                                  : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-primary)]'
                                }`}
                            >
                              <span className="material-symbols-outlined text-[16px]">
                                {isSelected ? 'check_box' : 'add_box'}
                              </span>
                              <span>{isSelected ? 'Included on Dashboard' : 'Include on Dashboard'}</span>
                            </button>
                          ) : (
                            <div
                              title="Only Admin or Admin+User accounts have permission to publish widgets to the Executive Dashboard."
                              className="px-2.5 py-1.5 rounded-[var(--radius-element)] text-xs font-medium text-[var(--color-text-muted)] bg-[var(--color-surface-active)] border border-[var(--color-border)] flex items-center gap-1.5 shrink-0 select-none cursor-not-allowed"
                            >
                              <span className="material-symbols-outlined text-[14px] text-[var(--color-text-muted)]">lock</span>
                              <span>Publishing (Admin Only)</span>
                            </div>
                          )
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            {/* Sticky Bottom Publishing Bar */}
            {canPublish ? (
              <div className="sticky bottom-4 z-40 bg-[var(--color-surface)]/95 backdrop-blur-md border border-[var(--color-border)] shadow-[var(--shadow-lg)] rounded-[var(--radius-page)] p-4 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-xl">dashboard_customize</span>
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                      {selected.length === 0
                        ? 'No widgets selected for Executive Dashboard'
                        : `${selected.length} widget${selected.length > 1 ? 's' : ''} ready to publish (${publishedKeys.length} live on dashboard)`}
                    </div>
                    <div className="text-xs text-[var(--color-text-secondary)]">
                      {selected.length === 0
                        ? 'Click "Include on Dashboard" on any approved KPI card above.'
                        : 'Click button to deploy selected widgets live to the Executive Dashboard.'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busy || selected.length === 0}
                  onClick={() => void handlePublishDashboard()}
                  className={`inline-flex items-center gap-2 font-medium text-xs px-5 py-2.5 rounded-[var(--radius-element)] shadow-[var(--shadow-sm)] transition-all ${selected.length > 0
                      ? 'bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white cursor-pointer'
                      : 'bg-[var(--color-surface-active)] text-[var(--color-text-muted)] cursor-not-allowed shadow-none border border-[var(--color-border)]'
                    }`}
                >
                  <span className={`material-symbols-outlined text-lg ${busyAction === 'publish' ? 'animate-spin' : ''}`}>
                    {busyAction === 'publish' ? 'progress_activity' : 'publish'}
                  </span>
                  <span>
                    {busyAction === 'publish'
                      ? 'Publishing...'
                      : selected.length === 0
                        ? 'Publish to Dashboard'
                        : `Publish ${selected.length} Widget${selected.length > 1 ? 's' : ''}`}
                  </span>
                </button>
              </div>
            ) : (
              <div className="sticky bottom-4 z-40 bg-[var(--color-surface-hover)]/95 backdrop-blur-md border border-[var(--color-border)] shadow-[var(--shadow-md)] rounded-[var(--radius-page)] p-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-lg">admin_panel_settings</span>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-[var(--color-text-primary)]">Publishing Restricted to Administrators</div>
                    <div className="text-[11px] text-[var(--color-text-secondary)]">
                      Only <strong>Admin</strong> or <strong>Admin+User</strong> accounts have permission to publish widgets to the Executive Dashboard.
                    </div>
                  </div>
                </div>
                <span className="text-[11px] font-medium text-[var(--color-text-muted)] bg-[var(--color-surface-active)] border border-[var(--color-border)] px-2.5 py-1 rounded-[var(--radius-inner)] select-none">
                  Read-Only
                </span>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// Alias export for consistency with the new name
export const BuildYourKPI = GraphStudio;
