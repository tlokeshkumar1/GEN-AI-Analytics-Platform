import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Brain,
  Cpu,
  CheckCircle2,
  Database,
  Layers,
  Zap,
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  BarChart3,
  TrendingUp,
  PieChart,
  ShieldCheck,
  Sliders,
  ExternalLink,
  Code2
} from 'lucide-react';
import api from '../services/api';
import { selectContext, selectedContext } from '../services/executionContext';

export type IngestionStageStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface PreprocessingAudit {
  rows_before?: number;
  rows_after?: number;
  duplicates_removed?: number;
  null_values_cleaned?: number;
  message?: string;
  null_fixes_by_column?: Record<string, number>;
}

export interface RecommendedChartItem {
  id: string;
  title: string;
  kind: string;
  query_plan: Record<string, any>;
  explanation: string;
  selected_by_default: boolean;
  preview_value?: string;
  preview_rows?: Array<Record<string, any>>;
}

export interface IngestionResult {
  filename: string;
  rows_processed?: number;
  domain?: string;
  version?: number;
  dataset?: {
    id?: string;
    currentVersion?: number;
    [key: string]: any;
  };
  preprocessing_audit?: PreprocessingAudit;
  recommendations?: RecommendedChartItem[];
  cloud_table?: {
    table_name: string;
    rows_inserted?: number;
    success?: boolean;
  };
  semantic_model?: {
    grain?: string;
    fields?: Array<{
      name: string;
      semantic_name: string;
      role: string;
      unit?: string;
      aliases?: string[];
    }>;
  };
}

interface AIAgentIngestionStepperProps {
  isOpen: boolean;
  isProcessing: boolean;
  filename: string;
  result: IngestionResult | null;
  partialResult?: Partial<IngestionResult> | null;
  stageStatuses?: Record<number, IngestionStageStatus>;
  error?: string | null;
  onClose: () => void;
  onNavigateToDashboard: () => void;
}

export const AIAgentIngestionStepper: React.FC<AIAgentIngestionStepperProps> = ({
  isOpen,
  isProcessing,
  filename,
  result,
  partialResult,
  stageStatuses,
  error,
  onClose,
  onNavigateToDashboard,
}) => {
  const [expandedSteps, setExpandedSteps] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    3: true,
    4: true,
  });

  // Track user-selected charts with checkboxes
  const [selectedChartIds, setSelectedChartIds] = useState<Record<string, boolean>>({});
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Initialize selected charts and ensure active dataset context is set immediately on first upload
  useEffect(() => {
    if (result?.dataset?.id) {
      const version = result.version || result.dataset.currentVersion || 1;
      const existing = selectedContext();
      if (!existing || existing.datasetId !== result.dataset.id || existing.version !== version) {
        selectContext({
          datasetId: result.dataset.id,
          version,
          semanticRevision: 1,
        });
      }
    }
    if (result?.recommendations) {
      const initial: Record<string, boolean> = {};
      result.recommendations.forEach(r => {
        initial[r.id] = r.selected_by_default ?? true;
      });
      setSelectedChartIds(initial);
    }
    setPublishError(null);
  }, [result]);

  if (!isOpen) return null;

  const getStageStatus = (stageNum: number): IngestionStageStatus => {
    if (result) return 'completed';
    if (stageStatuses && stageStatuses[stageNum]) {
      return stageStatuses[stageNum];
    }
    if (isProcessing) {
      return stageNum === 1 ? 'running' : 'queued';
    }
    return 'queued';
  };

  const stage1Status = getStageStatus(1);
  const stage2Status = getStageStatus(2);
  const stage3Status = getStageStatus(3);
  const stage4Status = getStageStatus(4);

  const toggleStepExpand = (stepNum: number) => {
    setExpandedSteps(prev => ({ ...prev, [stepNum]: !prev[stepNum] }));
  };

  const toggleChartSelect = (id: string) => {
    setSelectedChartIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const selectAllCharts = () => {
    const next: Record<string, boolean> = {};
    result?.recommendations?.forEach(r => {
      next[r.id] = true;
    });
    setSelectedChartIds(next);
  };

  const deselectAllCharts = () => {
    const next: Record<string, boolean> = {};
    result?.recommendations?.forEach(r => {
      next[r.id] = false;
    });
    setSelectedChartIds(next);
  };

  const selectedCount = Object.values(selectedChartIds).filter(Boolean).length;

  const handlePublish = async () => {
    if (!result?.recommendations) return;
    const approvedItems = result.recommendations.filter(r => selectedChartIds[r.id]);
    if (approvedItems.length === 0) {
      onClose();
      return;
    }

    setIsPublishing(true);
    setPublishError(null);
    try {
      const headers: Record<string, string> = {};
      if (result.dataset?.id) {
        const version = result.version || result.dataset.currentVersion || 1;
        selectContext({
          datasetId: result.dataset.id,
          version,
          semanticRevision: 1,
        });
        headers['X-Dataset-Id'] = result.dataset.id;
        headers['X-Dataset-Version'] = String(version);
        headers['X-Semantic-Revision'] = '1';
      }
      await api.post(
        '/dashboard/publish-recommended',
        {
          title: `${(result.domain || 'Enterprise').toUpperCase()} Analytics Dashboard`,
          items: approvedItems,
        },
        { headers }
      );
      onClose();
      onNavigateToDashboard();
    } catch (err: any) {
      setPublishError(err?.response?.data?.detail || err?.message || 'Failed to publish to dashboard');
      setIsPublishing(false);
    }
  };

  const effective = result ?? partialResult ?? null;
  const audit = effective?.preprocessing_audit;
  const domain = effective?.domain;
  const grain = effective?.semantic_model?.grain;
  const fields = effective?.semantic_model?.fields || [];
  const cloudTable = effective?.cloud_table?.table_name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-md p-3 sm:p-6 overflow-y-auto animate-fade-in">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-100">
        
        {/* Sleek AI Cockpit Header */}
        <div className="px-6 py-4 border-b border-slate-800 bg-linear-to-r from-slate-900 via-indigo-950/40 to-slate-900 flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-linear-to-tr from-blue-600 via-indigo-600 to-violet-600 shadow-md shadow-indigo-500/20">
              <Sparkles className="w-5 h-5 text-white animate-pulse" />
              {isProcessing && (
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900 animate-ping" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-bold text-white tracking-tight">
                  Autonomous 3-Agent Ingestion Cockpit
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                  {isProcessing ? 'LIVE TELEMETRY' : 'READY FOR REVIEW'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                <span>Dataset: <span className="text-slate-200 font-mono font-medium">{filename}</span></span>
                {domain && (
                  <>
                    <span>•</span>
                    <span className="text-emerald-400 font-medium">Domain: {domain}</span>
                  </>
                )}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800/80 flex items-center justify-center transition-colors cursor-pointer"
          >
            <span className="text-xl leading-none">&times;</span>
          </button>
        </div>

        {/* Scrollable Pipeline Telemetry Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 text-xs font-sans">
          {error && (
            <div className="p-4 rounded-xl bg-red-950/60 border border-red-500/50 text-red-200 flex items-start gap-3">
              <span className="material-symbols-outlined text-red-400 text-xl shrink-0 mt-0.5">error</span>
              <div>
                <h4 className="font-bold text-sm text-red-100">Ingestion Pipeline Failed</h4>
                <p className="text-xs text-red-300 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* ⚡ STAGE 1: Agent 1 (Preprocessing & Cleaning) */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 overflow-hidden transition-all">
            <div
              onClick={() => toggleStepExpand(1)}
              className="flex items-center justify-between p-3.5 bg-slate-800/60 hover:bg-slate-800/80 cursor-pointer select-none transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  stage1Status === 'completed'
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : stage1Status === 'running'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse'
                      : 'bg-slate-800 text-slate-500'
                }`}>
                  {stage1Status === 'completed' ? <Check className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-200">Stage 1: Zero-Hardcode Preprocessing Agent</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-mono">
                      agent_preprocessing.py
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Deduplication, smart null imputation, currency stripping & type coercion
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {stage1Status === 'completed' ? (
                  <span className="text-[11px] font-semibold text-emerald-400 flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Cleaned ({audit?.rows_after ?? effective?.rows_processed ?? '—'} rows)
                  </span>
                ) : stage1Status === 'running' ? (
                  <span className="text-[11px] font-semibold text-blue-400 animate-pulse flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 animate-spin" />
                    Sanitizing…
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">Queued</span>
                )}
                {expandedSteps[1] ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </div>

            {expandedSteps[1] && (
              <div className="p-3.5 border-t border-slate-800/80 space-y-2 bg-slate-900/40 font-mono text-[11px]">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-300">
                  <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                    <div className="text-[10px] text-slate-400">Initial Rows</div>
                    <div className="text-sm font-bold text-slate-200">{audit?.rows_before ?? 'Scanning…'}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                    <div className="text-[10px] text-slate-400">Duplicates Purged</div>
                    <div className="text-sm font-bold text-emerald-400">{audit?.duplicates_removed ?? 0} rows</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                    <div className="text-[10px] text-slate-400">Nulls Remediated</div>
                    <div className="text-sm font-bold text-blue-400">{audit?.null_values_cleaned ?? 0} cells</div>
                  </div>
                  <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/50">
                    <div className="text-[10px] text-slate-400">Pristine Output</div>
                    <div className="text-sm font-bold text-slate-100">{audit?.rows_after ?? 'Computing…'}</div>
                  </div>
                </div>
                <div className="text-slate-400 text-[10.5px] pt-1">
                  • Hash-signature duplicate check: {stage1Status === 'completed' ? 'Complete.' : 'Pending…'}<br />
                  • Type coercion: Stripped currency symbols ($ € £ ¥), percentage signs, and decimal commas.<br />
                  • Null remediation: Low-missingness measures filled with median; categories tagged with 'Unknown'.
                </div>
              </div>
            )}
          </div>

          {/* 🧠 STAGE 2: Agent 2 (Open-Domain 5-Row Zero-Shot Discovery) */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 overflow-hidden transition-all">
            <div
              onClick={() => toggleStepExpand(2)}
              className="flex items-center justify-between p-3.5 bg-slate-800/60 hover:bg-slate-800/80 cursor-pointer select-none transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  stage2Status === 'completed'
                    ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                    : stage2Status === 'running'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse'
                      : 'bg-slate-800 text-slate-500'
                }`}>
                  <Brain className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-200">Stage 2: Open-Domain 5-Row Semantic Agent</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono">
                      Zero-Shot LLM Reasoning
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Samples the first 5 rows to discover domain, entity grain, and natural language synonyms
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {stage2Status === 'completed' && domain ? (
                  <span className="text-[11px] font-bold text-purple-300 bg-purple-950/60 px-2 py-0.5 rounded border border-purple-500/40">
                    {domain}
                  </span>
                ) : stage2Status === 'running' ? (
                  <span className="text-[11px] font-semibold text-blue-400 animate-pulse flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 animate-spin" />
                    Reasoning over 5 rows…
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">Queued</span>
                )}
                {expandedSteps[2] ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </div>

            {expandedSteps[2] && (
              <div className="p-3.5 border-t border-slate-800/80 space-y-2 bg-slate-900/40 text-[11px]">
                {domain ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-slate-400">Discovered Domain:</span>
                      <span className="font-bold text-white text-xs px-2.5 py-1 rounded bg-purple-900/40 border border-purple-500/40">
                        {domain}
                      </span>
                      {grain && (
                        <span className="text-slate-300 font-mono text-[10px] bg-slate-800 px-2 py-1 rounded border border-slate-700">
                          Grain: {grain}
                        </span>
                      )}
                    </div>

                    <div className="text-slate-400 text-[10.5px]">
                      • Inspected representative first 5 rows with zero hardcoded taxonomy lists.<br />
                      • Formulated domain ontology across {fields.length} columns (identified measures, dimensions, temporal axes).<br />
                      • Synthesized natural language search synonyms for Text-to-SQL & RAG querying.
                    </div>
                  </div>
                ) : (
                  <div className="text-slate-400 text-xs italic">
                    {stage2Status === 'running'
                      ? 'Extracting the first 5 rows and running unconstrained zero-shot reasoning…'
                      : 'Waiting for Stage 1 preprocessing to finish…'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ☁️ STAGE 3: Dynamic SAP HANA Cloud Table & Vector Engine */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 overflow-hidden transition-all">
            <div
              onClick={() => toggleStepExpand(3)}
              className="flex items-center justify-between p-3.5 bg-slate-800/60 hover:bg-slate-800/80 cursor-pointer select-none transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  stage3Status === 'completed'
                    ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                    : stage3Status === 'running'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse'
                      : 'bg-slate-800 text-slate-500'
                }`}>
                  <Database className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-200">Stage 3: SAP HANA Cloud Storage & Vector Engine</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 font-mono">
                      Dynamic DDL
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Provisions isolated column table and generates 1536-dim vectors in VECTOR_TABLE
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {stage3Status === 'completed' ? (
                  <span className="text-[11px] font-mono text-sky-300">
                    {cloudTable || 'Synced'}
                  </span>
                ) : stage3Status === 'running' ? (
                  <span className="text-[11px] font-semibold text-blue-400 animate-pulse flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 animate-spin" />
                    Provisioning HANA…
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">Queued</span>
                )}
                {expandedSteps[3] ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </div>

            {expandedSteps[3] && (
              <div className="p-3.5 border-t border-slate-800/80 space-y-1.5 bg-slate-900/40 text-[10.5px] text-slate-400 font-mono">
                <div>• Relational Column Store: <span className="text-sky-300 font-bold">{cloudTable || (stage3Status === 'running' ? 'Creating table…' : 'Pending…')}</span></div>
                <div>• Vector Dimensions: <span className="text-slate-200">1,536 (REAL_VECTOR)</span> with Cosine Similarity indexing.</div>
                <div>• Metadata Registry: Pinned to <span className="text-slate-200">DATASETS_METADATA</span> catalog with semantic revision 1.</div>
              </div>
            )}
          </div>

          {/* 📊 STAGE 4: Agent 3 (Visualization & Chart Recommender) */}
          <div className="rounded-xl border border-slate-800 bg-slate-800/40 overflow-hidden transition-all">
            <div
              onClick={() => toggleStepExpand(4)}
              className="flex items-center justify-between p-3.5 bg-slate-800/60 hover:bg-slate-800/80 cursor-pointer select-none transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                  stage4Status === 'completed'
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    : stage4Status === 'running'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse'
                      : 'bg-slate-800 text-slate-500'
                }`}>
                  <BarChart3 className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-200">Stage 4: Visualization & Chart Recommendation Agent</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono">
                      agent_chart_recommender.py
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Synthesizes domain-tailored charts, KPI scorecards, and live preview values
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {stage4Status === 'completed' && effective?.recommendations ? (
                  <span className="text-[11px] font-bold text-amber-300">
                    {effective.recommendations.length} Charts Curated
                  </span>
                ) : stage4Status === 'running' ? (
                  <span className="text-[11px] font-semibold text-blue-400 animate-pulse flex items-center gap-1">
                    <Activity className="w-3.5 h-3.5 animate-spin" />
                    Formulating charts…
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">Queued</span>
                )}
                {expandedSteps[4] ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              </div>
            </div>

            {expandedSteps[4] && (
              <div className="p-3.5 border-t border-slate-800/80 space-y-1.5 bg-slate-900/40 text-[10.5px] text-slate-400">
                • Statistical distribution analysis: Cardinality and variance scanned across all measures.<br />
                • Formulation: Synthesized tailored executive KPI tiles, temporal trends, and categorical breakdowns.<br />
                • Live aggregations: Precomputed sample values to enable instant verification before dashboard publishing.
              </div>
            )}
          </div>

          {/* 🎯 STAGE 5: Interactive Executive Dashboard Approval (Checkboxes) */}
          {result?.recommendations && result.recommendations.length > 0 && (
            <div className="pt-2 border-t border-slate-800 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-blue-400" />
                    <span>Include on Executive Dashboard:</span>
                    <span className="text-xs text-blue-400 font-mono">
                      ({selectedCount} of {result.recommendations.length} selected)
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Check the boxes for the charts you want published directly to the Executive Dashboard.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllCharts}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={deselectAllCharts}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              {publishError && (
                <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-500/50 text-rose-300 text-xs font-medium">
                  {publishError}
                </div>
              )}

              {/* Chart Cards with Checkboxes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                {result.recommendations.map(chart => {
                  const isChecked = !!selectedChartIds[chart.id];

                  return (
                    <div
                      key={chart.id}
                      onClick={() => toggleChartSelect(chart.id)}
                      className={`p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between ${
                        isChecked
                          ? 'border-blue-500/80 bg-blue-950/20 shadow-lg shadow-blue-500/5 ring-1 ring-blue-500/30'
                          : 'border-slate-800 bg-slate-800/30 hover:border-slate-700 opacity-60'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleChartSelect(chart.id)}
                              onClick={e => e.stopPropagation()}
                              className="w-4 h-4 rounded text-blue-500 bg-slate-800 border-slate-700 focus:ring-blue-500 cursor-pointer"
                            />
                            <span className="text-xs font-bold text-slate-100">
                              {chart.title}
                            </span>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-800 border border-slate-700 text-slate-300 shrink-0">
                            {chart.kind.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400 pl-6.5 line-clamp-2">
                          {chart.explanation}
                        </p>
                      </div>

                      <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs pl-6.5">
                        {chart.preview_value ? (
                          <div className="text-[11px] font-mono font-bold text-emerald-400">
                            {chart.preview_value}
                          </div>
                        ) : chart.preview_rows ? (
                          <div className="text-[10px] text-slate-400">
                            {chart.preview_rows.length} preview data points
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-500">Query verified</div>
                        )}
                        <span className={`text-[10px] font-semibold ${isChecked ? 'text-blue-400' : 'text-slate-500'}`}>
                          {isChecked ? '✓ Include on Dashboard' : 'Omit'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-800 bg-slate-900/90 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            Close / Dismiss
          </button>

          <div className="flex items-center gap-3">
            {result?.recommendations && (
              <button
                type="button"
                disabled={isPublishing || selectedCount === 0}
                onClick={handlePublish}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white disabled:opacity-50 transition-all shadow-md shadow-indigo-500/20 cursor-pointer"
              >
                <CheckCircle2 className={`w-4 h-4 ${isPublishing ? 'animate-spin' : ''}`} />
                <span>
                  {isPublishing
                    ? 'Publishing…'
                    : `Publish ${selectedCount} Accepted Charts to Dashboard`}
                </span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
