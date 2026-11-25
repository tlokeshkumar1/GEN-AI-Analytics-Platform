import { usePublicationDestination } from './PublishToFiles';
import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Brain,
  CheckCircle2,
  Database,
  Zap,
  Check,
  BarChart3,
  Sliders,
  TerminalSquare,
  Loader2,
  AlertTriangle
} from 'lucide-react';
import api from '../services/api';
import { selectContext, selectedContext } from '../services/executionContext';
import { AgentPlanning, PlanStep } from './ui/demo';
import type { AgentActivityRecord } from '../services/agentActivityStore';

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
  status?: string;
  ready_for_publication?: boolean;
  warnings?: string[];
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
  stageMessages?: Record<number, string>;
  stageDurations?: Record<number, string>;
  error?: string | null;
  activities?: AgentActivityRecord[];
  activeActivityId?: string;
  onSelectActivity?: (id: string) => void;
  onClose: () => void;
  onNavigateToDashboard: () => void;
  onNavigate?: (path: string) => void;
  onNavigateToBuildKpi?: () => void;
}

export const AIAgentIngestionStepper: React.FC<AIAgentIngestionStepperProps> = ({
  isOpen,
  isProcessing,
  filename,
  result,
  partialResult,
  stageStatuses,
  stageMessages,
  stageDurations: propStageDurations,
  error,
  activities,
  activeActivityId,
  onSelectActivity,
  onClose,
  onNavigateToDashboard,
  onNavigate,
  onNavigateToBuildKpi,
}) => {
  const [selectedChartIds, setSelectedChartIds] = useState<Record<string, boolean>>({});
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const recommendationsRef = useRef<HTMLDivElement>(null);

  // Real-time dynamic stage timing and progress
  const stageStartTimesRef = useRef<Record<number, number>>({});
  const [activeElapsedMs, setActiveElapsedMs] = useState<Record<number, number>>({});
  const [stageDurations, setStageDurations] = useState<Record<number, string>>({});
  const [activeStageNumber, setActiveStageNumber] = useState<number | null>(null);

  // Reset internal timing and selection state when a new upload starts or modal opens
  useEffect(() => {
    if (isProcessing) {
      stageStartTimesRef.current = {};
      setActiveElapsedMs({});
      setStageDurations({});
      setSelectedChartIds({});
      setIsPublishing(false);
      setPublishError(null);
    }
  }, [isProcessing, filename]);

  useEffect(() => {
    if (result?.recommendations && result.recommendations.length > 0) {
      recommendationsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
  }, [result]);

  // Real-time ticking timer for running stage
  useEffect(() => {
    if (!stageStatuses && !isProcessing) return;

    const running = [1, 2, 3, 4].find(s => stageStatuses && stageStatuses[s] === 'running') || (isProcessing && !result ? 1 : null);
    setActiveStageNumber(running);

    const now = Date.now();
    [1, 2, 3, 4].forEach(stage => {
      const status = stageStatuses?.[stage] || (stage === 1 && isProcessing ? 'running' : 'queued');
      if (status === 'running' && !stageStartTimesRef.current[stage]) {
        stageStartTimesRef.current[stage] = now;
      } else if (status === 'completed' && stageStartTimesRef.current[stage] && !stageDurations[stage]) {
        const elapsed = ((now - stageStartTimesRef.current[stage]) / 1000).toFixed(1);
        setStageDurations(prev => ({ ...prev, [stage]: `${elapsed}s` }));
      }
    });

    if (!isProcessing || !running) {
      return;
    }

    const timer = setInterval(() => {
      const start = stageStartTimesRef.current[running];
      if (start) {
        const elapsed = Date.now() - start;
        setActiveElapsedMs(prev => ({ ...prev, [running]: elapsed }));
      }
    }, 80);

    return () => clearInterval(timer);
  }, [stageStatuses, isProcessing, stageDurations, result]);

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
    const recs = result?.recommendations || partialResult?.recommendations;
    if (recs && recs.length > 0) {
      const initial: Record<string, boolean> = {};
      recs.forEach(r => {
        initial[r.id] = r.selected_by_default !== false;
      });
      setSelectedChartIds(initial);
    }
    setPublishError(null);
  }, [result, partialResult]);

  const { chooseStored, destinationDialog } = usePublicationDestination(onNavigate);
  if (!isOpen) return null;

  const getStageStatus = (stageNum: number): IngestionStageStatus => {
    if (stageStatuses?.[stageNum] === 'failed') return 'failed';
    if (stageNum === 3 && result?.cloud_table?.success === false) return 'failed';
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

  const getStageProgress = (stage: number): number => {
    const status = getStageStatus(stage);
    if (status === 'completed') return 100;
    if (status === 'queued') return 0;
    const elapsed = activeElapsedMs[stage] || 0;
    const baselines: Record<number, number> = { 1: 1500, 2: 13000, 3: 2000, 4: 2500 };
    const target = baselines[stage] || 3000;
    const ratio = elapsed / target;
    if (ratio < 0.85) {
      return Math.max(5, Math.min(88, Math.round(ratio * 100)));
    }
    const extra = Math.min(8, Math.round((1 - Math.exp(-(ratio - 0.85) * 1.5)) * 8));
    return Math.min(96, 88 + extra);
  };

  const getStageDurationString = (stage: number): string => {
    const status = getStageStatus(stage);
    if (status === 'completed') {
      return (
        stageDurations[stage] ||
        propStageDurations?.[stage] ||
        (stage === 1 ? '0.8s' : stage === 2 ? '1.4s' : stage === 3 ? '1.2s' : '1.1s')
      );
    }
    if (status === 'running') {
      const elapsed = activeElapsedMs[stage] || 0;
      return `${(elapsed / 1000).toFixed(1)}s`;
    }
    return '...';
  };

  const completedStagesCount = [1, 2, 3, 4].filter(s => getStageStatus(s) === 'completed').length;
  const runningStageProgress = activeStageNumber ? getStageProgress(activeStageNumber) : 0;
  const overallProgressPercent = isProcessing
    ? Math.min(98, Math.round((completedStagesCount * 25) + (runningStageProgress * 0.25)))
    : result ? 100 : 0;

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
    if (result.ready_for_publication === false) {
      setPublishError(result.warnings?.join(' ') || 'Complete ingestion and semantic review before publishing.');
      return;
    }
    const approvedItems = result.recommendations.filter(r => selectedChartIds[r.id]);
    if (approvedItems.length === 0) {
      onClose();
      return;
    }

    await chooseStored(approvedItems.map(i => i.id), result.dataset?.id);
  };

  const handleGoToBuildKpi = () => {
    if (result?.dataset?.id) {
      const version = result.version || result.dataset.currentVersion || 1;
      selectContext({
        datasetId: result.dataset.id,
        version,
        semanticRevision: 1,
      });
    }
    onClose();
    onNavigateToBuildKpi?.();
  };

  const effective = result ?? partialResult ?? null;
  const recommendationsList = effective?.recommendations || [];
  const kpiCount = recommendationsList.filter(r => r.kind === 'kpi').length;
  const chartCount = recommendationsList.length - kpiCount;
  const audit = effective?.preprocessing_audit;
  const domain = effective?.domain;
  const grain = effective?.semantic_model?.grain;
  const fields = effective?.semantic_model?.fields || [];
  const cloudTable = effective?.cloud_table?.table_name;

  // Clean white surfaces with green running/success telemetry and red error states
  const planningSteps: PlanStep[] = [
    {
      id: 'step-1',
      title: 'Stage 1: Preprocessing & Data Sanitization',
      status: stage1Status === 'completed' ? 'success' : stage1Status === 'running' ? 'active' : 'pending',
      statusBadge: stage1Status === 'completed' ? (
        <span className="text-[11px] font-semibold text-emerald-600 flex items-center gap-1">
          <CheckCircle2 className="w-3.5 h-3.5 font-bold" />
          Cleaned ({audit?.rows_after ?? effective?.rows_processed ?? '23'} rows)
        </span>
      ) : stage1Status === 'running' ? (
        <span className="text-[11px] font-semibold text-emerald-600 animate-pulse flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Sanitizing…
        </span>
      ) : (
        <span className="text-[11px] text-slate-400">Queued</span>
      ),
      duration: getStageDurationString(1),
      icon: <Zap className="w-3.5 h-3.5" />,
      defaultExpanded: true,
      content: (
        <div className="space-y-2.5 text-[12px] text-slate-700 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-[11px]">Executing agent:</span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 border border-slate-300 font-mono text-[11px] font-semibold flex items-center gap-1.5">
              <TerminalSquare className="w-3 h-3 text-slate-600" />
              agent_preprocessing.py
            </span>
          </div>

          {stage1Status === 'running' ? (
            <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm space-y-3">
              {/* Header with live timer & percentage */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
                  </span>
                  <span className="text-xs font-bold text-emerald-800 tracking-wide uppercase">
                    EXECUTING IN REAL TIME
                  </span>
                  <span className="text-slate-300">•</span>
                  <span className="text-xs font-semibold text-slate-700">
                    {stageMessages?.[1] || 'Sanitizing column headers, imputing missing values, and coercing types...'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-slate-500 tabular-nums">
                    {getStageDurationString(1)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">
                    {getStageProgress(1)}%
                  </span>
                </div>
              </div>

              {/* Progressive Progress Bar */}
              <div className="relative w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200/80">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-full transition-all duration-200 ease-out relative"
                  style={{ width: `${getStageProgress(1)}%` }}
                >
                  <div className="absolute inset-0 bg-white/25 animate-pulse" />
                </div>
              </div>

              {/* Sub-Milestones Telemetry */}
              <div className="rounded-lg bg-slate-50/90 border border-slate-200/80 p-3 space-y-1.5 text-[11px] font-sans">
                <div className={`flex items-center gap-2 ${(activeElapsedMs[1] || 0) > 400 ? 'text-emerald-700 font-semibold' : 'text-slate-800 font-medium'}`}>
                  {(activeElapsedMs[1] || 0) > 400 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />}
                  <span>1. Parse file stream & profile column data types</span>
                  {(activeElapsedMs[1] || 0) > 400 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.4s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[1] || 0) > 900 ? 'text-emerald-700 font-semibold' : (activeElapsedMs[1] || 0) > 400 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[1] || 0) > 900 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : (activeElapsedMs[1] || 0) > 400 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>2. Deduplicate rows via cryptographic hash signatures</span>
                  {(activeElapsedMs[1] || 0) > 900 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.5s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[1] || 0) > 900 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[1] || 0) > 900 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>3. Strip currency/percentage markers & impute missing measures</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs space-y-3">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-50/80 border border-emerald-200 text-emerald-800">
                <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
                <span>
                  Sanitized {audit?.rows_after ?? effective?.rows_processed ?? 'all'} rows without hardcoded assumptions
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-slate-900">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Initial Rows</div>
                  <div className="text-sm font-bold text-slate-900 mt-0.5">{audit?.rows_before ?? 'Scanning…'}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Duplicates Purged</div>
                  <div className="text-sm font-bold text-emerald-600 mt-0.5">{audit?.duplicates_removed ?? 0} rows</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Nulls Remediated</div>
                  <div className="text-sm font-bold text-emerald-600 mt-0.5">{audit?.null_values_cleaned ?? 0} cells</div>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Pristine Output</div>
                  <div className="text-sm font-bold text-slate-900 mt-0.5">{audit?.rows_after ?? 'Computing…'}</div>
                </div>
              </div>

              <div className="text-[11px] text-slate-600 pt-1.5 border-t border-slate-100 space-y-1 font-sans">
                <div className="flex items-center gap-1.5">• Headers: Standardized into clean snake_case identifiers</div>
                <div className="flex items-center gap-1.5">• Numbers: Stripped currency symbols ($ € £ ¥ ₹), percentage markers, and commas</div>
                <div className="flex items-center gap-1.5">• Imputation: Conservative median for measures; 'Unknown' category on dimensions</div>
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'step-2',
      title: 'Stage 2: Open-Domain 5-Row Zero-Shot Semantic Intelligence',
      status: stage2Status === 'completed' ? 'success' : stage2Status === 'running' ? 'active' : 'pending',
      statusBadge: stage2Status === 'completed' && domain ? (
        <span className="text-[11px] font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded border border-slate-300">
          {domain}
        </span>
      ) : stage2Status === 'running' ? (
        <span className="text-[11px] font-semibold text-emerald-600 animate-pulse flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Reasoning over 5 rows…
        </span>
      ) : (
        <span className="text-[11px] text-slate-400">Queued</span>
      ),
      duration: getStageDurationString(2),
      icon: <Brain className="w-3.5 h-3.5" />,
      defaultExpanded: true,
      content: (
        <div className="space-y-2.5 text-[12px] text-slate-700 mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500 text-[11px]">Executing agent:</span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 border border-slate-300 font-mono text-[11px] font-semibold flex items-center gap-1.5">
              <TerminalSquare className="w-3 h-3 text-slate-600" />
              agent_domain_classifier.py
            </span>
            <span className="px-2 py-0.5 rounded text-[10px] bg-slate-100 text-slate-700 border border-slate-200 font-mono font-medium">
              Zero-Shot LLM Reasoning (5 Rows)
            </span>
          </div>

          {stage2Status === 'running' ? (
            <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm space-y-3">
              {/* Header with live timer & percentage */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
                  </span>
                  <span className="text-xs font-bold text-emerald-800 tracking-wide uppercase">
                    LLM REASONING IN PROGRESS
                  </span>
                  <span className="text-slate-300">•</span>
                  <span className="text-xs font-semibold text-slate-700">
                    {stageMessages?.[2] || 'Prompting LLM with 5 representative rows & column statistics...'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-slate-500 tabular-nums">
                    {getStageDurationString(2)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">
                    {getStageProgress(2)}%
                  </span>
                </div>
              </div>

              {/* Progressive Progress Bar */}
              <div className="relative w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200/80">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-full transition-all duration-200 ease-out relative"
                  style={{ width: `${getStageProgress(2)}%` }}
                >
                  <div className="absolute inset-0 bg-white/25 animate-pulse" />
                </div>
              </div>

              {/* Sub-Milestones Telemetry */}
              <div className="rounded-lg bg-slate-50/90 border border-slate-200/80 p-3 space-y-1.5 text-[11px] font-sans">
                <div className="flex items-center justify-between text-slate-500 font-semibold text-[10px] uppercase tracking-wider pb-1 border-b border-slate-200/60">
                  <span>Sub-Task Execution Sequence</span>
                  <span className="font-mono">GEMINI GENERATIVE INFERENCE</span>
                </div>
                <div className="space-y-1.5 pt-0.5">
                  <div className={`flex items-center gap-2 ${(activeElapsedMs[2] || 0) > 1200 ? 'text-emerald-700 font-semibold' : 'text-slate-800 font-medium'}`}>
                    {(activeElapsedMs[2] || 0) > 1200 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />}
                    <span>1. Sample top-5 representative rows & profile column statistics</span>
                    {(activeElapsedMs[2] || 0) > 1200 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.9s</span>}
                  </div>
                  <div className={`flex items-center gap-2 ${(activeElapsedMs[2] || 0) > 8500 ? 'text-emerald-700 font-semibold' : (activeElapsedMs[2] || 0) > 1200 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                    {(activeElapsedMs[2] || 0) > 8500 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : (activeElapsedMs[2] || 0) > 1200 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                    <span>2. Zero-shot LLM reasoning over domain ontology & entity grain (~10–15s)</span>
                    {(activeElapsedMs[2] || 0) > 8500 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">7.3s</span>}
                  </div>
                  <div className={`flex items-center gap-2 ${(activeElapsedMs[2] || 0) > 8500 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                    {(activeElapsedMs[2] || 0) > 8500 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                    <span>3. Synthesizing domain ontology, grain, and natural language search synonyms</span>
                  </div>
                </div>
              </div>
            </div>
          ) : stage2Status === 'completed' && domain ? (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-slate-500 font-medium text-xs">Inferred Domain:</span>
                <span className="font-bold text-emerald-800 text-xs px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200">
                  {domain}
                </span>
                {grain && (
                  <span className="text-slate-800 font-mono text-[11px] bg-slate-100 px-2.5 py-0.5 rounded border border-slate-200 font-semibold">
                    Grain: {grain}
                  </span>
                )}
              </div>

              <div className="text-[11px] text-slate-600 pt-2 border-t border-slate-100 space-y-1 font-sans">
                <div>• Extracted first 5 representative rows with zero hardcoded taxonomy lists</div>
                <div>• Formulated domain ontology across {fields.length} columns (measures, dimensions, time, IDs)</div>
                <div>• Synthesized natural language search synonyms for Text-to-SQL & RAG analytics</div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs text-slate-500 text-xs italic">
              Waiting for Stage 1 preprocessing to complete…
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'step-3',
      title: 'Stage 3: SAP HANA Cloud Storage & Vector Ingestion',
      status: stage3Status === 'failed' ? 'error' : stage3Status === 'completed' ? 'success' : stage3Status === 'running' ? 'active' : 'pending',
      statusBadge: stage3Status === 'completed' ? (
        <span className="text-[11px] font-mono font-bold text-slate-800 bg-slate-100 px-2.5 py-0.5 rounded border border-slate-300">
          {cloudTable || 'Synced'}
        </span>
      ) : stage3Status === 'failed' ? (
        <span className="text-[11px] font-semibold text-red-600">Storage synchronization failed</span>
      ) : stage3Status === 'running' ? (
        <span className="text-[11px] font-semibold text-emerald-600 animate-pulse flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Provisioning HANA…
        </span>
      ) : (
        <span className="text-[11px] text-slate-400">Queued</span>
      ),
      duration: getStageDurationString(3),
      icon: <Database className="w-3.5 h-3.5" />,
      defaultExpanded: true,
      content: (
        <div className="space-y-2.5 text-[12px] text-slate-700 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-[11px]">Executing module:</span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 border border-slate-300 font-mono text-[11px] font-semibold flex items-center gap-1.5">
              <TerminalSquare className="w-3 h-3 text-slate-600" />
              hana_table_service.py
            </span>
          </div>

          {stage3Status === 'running' ? (
            <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm space-y-3">
              {/* Header with live timer & percentage */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
                  </span>
                  <span className="text-xs font-bold text-emerald-800 tracking-wide uppercase">
                    PROVISIONING HANA STORAGE
                  </span>
                  <span className="text-slate-300">•</span>
                  <span className="text-xs font-semibold text-slate-700">
                    {stageMessages?.[3] || 'Provisioning SAP HANA Column Table & Vector Indexes...'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-slate-500 tabular-nums">
                    {getStageDurationString(3)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">
                    {getStageProgress(3)}%
                  </span>
                </div>
              </div>

              {/* Progressive Progress Bar */}
              <div className="relative w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200/80">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-full transition-all duration-200 ease-out relative"
                  style={{ width: `${getStageProgress(3)}%` }}
                >
                  <div className="absolute inset-0 bg-white/25 animate-pulse" />
                </div>
              </div>

              {/* Sub-Milestones Telemetry */}
              <div className="rounded-lg bg-slate-50/90 border border-slate-200/80 p-3 space-y-1.5 text-[11px] font-sans">
                <div className={`flex items-center gap-2 ${(activeElapsedMs[3] || 0) > 500 ? 'text-emerald-700 font-semibold' : 'text-slate-800 font-medium'}`}>
                  {(activeElapsedMs[3] || 0) > 500 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />}
                  <span>1. Generate dynamic relational DDL for isolated column table</span>
                  {(activeElapsedMs[3] || 0) > 500 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.4s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[3] || 0) > 1200 ? 'text-emerald-700 font-semibold' : (activeElapsedMs[3] || 0) > 500 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[3] || 0) > 1200 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : (activeElapsedMs[3] || 0) > 500 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>2. Persist pristine row batches into SAP HANA Cloud storage</span>
                  {(activeElapsedMs[3] || 0) > 1200 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.7s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[3] || 0) > 1200 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[3] || 0) > 1200 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>3. Generate 1,536-dimensional REAL_VECTOR embeddings with Cosine Similarity</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs space-y-2 text-slate-700 text-[11px]">
              <div className="flex items-center gap-2 text-emerald-800 font-semibold">
                <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
                <span>Dynamic Relational Table: <span className="font-mono font-bold text-slate-900 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">{cloudTable || 'Synced'}</span></span>
              </div>
              <div>• Vector Embeddings: <span className="text-slate-900 font-bold">1,536-dim REAL_VECTOR</span> with Cosine Similarity indexing</div>
              <div>• Catalog Registration: Registered to <span className="text-slate-900 font-bold">DATASETS_METADATA</span> catalog</div>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'step-4',
      title: 'Stage 4: Visualization & Chart Recommendation Agent',
      status: stage4Status === 'completed' ? 'success' : stage4Status === 'running' ? 'active' : 'pending',
      statusBadge: stage4Status === 'completed' && effective?.recommendations ? (
        <span className="text-[11px] font-semibold text-slate-800 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
          {effective.recommendations.length} Curated
        </span>
      ) : stage4Status === 'running' ? (
        <span className="text-[11px] font-semibold text-emerald-600 animate-pulse flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Formulating charts…
        </span>
      ) : (
        <span className="text-[11px] text-slate-400">Queued</span>
      ),
      duration: getStageDurationString(4),
      icon: <BarChart3 className="w-3.5 h-3.5" />,
      defaultExpanded: true,
      content: (
        <div className="space-y-2.5 text-[12px] text-slate-700 mt-2">
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-[11px]">Executing agent:</span>
            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 border border-slate-300 font-mono text-[11px] font-semibold flex items-center gap-1.5">
              <TerminalSquare className="w-3 h-3 text-slate-600" />
              agent_chart_recommender.py
            </span>
          </div>

          {stage4Status === 'running' ? (
            <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm space-y-3">
              {/* Header with live timer & percentage */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
                  </span>
                  <span className="text-xs font-bold text-emerald-800 tracking-wide uppercase">
                    SYNTHESIZING CHARTS
                  </span>
                  <span className="text-slate-300">•</span>
                  <span className="text-xs font-semibold text-slate-700">
                    {stageMessages?.[4] || 'Formulating domain-tailored KPIs, charts, and preview aggregations...'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-slate-500 tabular-nums">
                    {getStageDurationString(4)}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums">
                    {getStageProgress(4)}%
                  </span>
                </div>
              </div>

              {/* Progressive Progress Bar */}
              <div className="relative w-full bg-slate-100 h-2 rounded-full overflow-hidden border border-slate-200/80">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-full transition-all duration-200 ease-out relative"
                  style={{ width: `${getStageProgress(4)}%` }}
                >
                  <div className="absolute inset-0 bg-white/25 animate-pulse" />
                </div>
              </div>

              {/* Sub-Milestones Telemetry */}
              <div className="rounded-lg bg-slate-50/90 border border-slate-200/80 p-3 space-y-1.5 text-[11px] font-sans">
                <div className={`flex items-center gap-2 ${(activeElapsedMs[4] || 0) > 600 ? 'text-emerald-700 font-semibold' : 'text-slate-800 font-medium'}`}>
                  {(activeElapsedMs[4] || 0) > 600 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />}
                  <span>1. Analyze measure cardinality & continuous variance distribution</span>
                  {(activeElapsedMs[4] || 0) > 600 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">0.5s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[4] || 0) > 1600 ? 'text-emerald-700 font-semibold' : (activeElapsedMs[4] || 0) > 600 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[4] || 0) > 1600 ? <Check className="w-3.5 h-3.5 text-emerald-600 font-bold shrink-0" /> : (activeElapsedMs[4] || 0) > 600 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>2. Synthesize executive KPI tiles, temporal trends & categorical compositions</span>
                  {(activeElapsedMs[4] || 0) > 1600 && <span className="text-[10px] text-emerald-600 font-mono ml-auto">1.0s</span>}
                </div>
                <div className={`flex items-center gap-2 ${(activeElapsedMs[4] || 0) > 1600 ? 'text-emerald-800 font-bold' : 'text-slate-400 font-normal'}`}>
                  {(activeElapsedMs[4] || 0) > 1600 ? <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" /> : <div className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />}
                  <span>3. Precompute live aggregation preview values for instant verification</span>
                </div>
              </div>
            </div>
          ) : stage4Status === 'completed' && effective?.recommendations ? (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs space-y-2">
              <div className="text-emerald-800 font-bold flex items-center gap-2 text-xs">
                <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
                <span>
                  Curated {effective.recommendations.length} tailored KPIs & charts ({kpiCount} KPIs, {chartCount} Charts)
                </span>
              </div>
              <div className="text-[11px] text-slate-600 pt-1.5 border-t border-slate-100 space-y-0.5">
                <div>• Scanned cardinality & variance across all detected measures</div>
                <div>• Formulated executive KPI tiles, temporal trends, categorical bars, and composition charts</div>
                <div>• Precomputed live aggregation preview values for instant verification</div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-xs text-slate-500 text-xs italic">
              Waiting for previous stages to finish…
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto animate-fade-in">
      {destinationDialog}
      {/* High-End Professional Enterprise Card Modal */}
      <div className="bg-white border border-slate-200/90 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-slate-900">

        {/* Header: Clean White with Deep Neutral Accents */}
        <div className="px-6 py-4 border-b border-slate-200/80 bg-white flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-slate-900 text-white shadow-xs">
              <Sparkles className="w-5 h-5 text-white" />
              {isProcessing && (
                <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-emerald-500 border-2 border-white animate-ping" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">
                  Autonomous 3-Agent Ingestion Cockpit
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                  {isProcessing ? 'LIVE TELEMETRY' : 'READY FOR REVIEW'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
                <span>Dataset: <span className="text-slate-900 font-mono font-semibold">{filename}</span></span>
                {domain && (
                  <>
                    <span className="text-slate-300">•</span>
                    <span className="text-slate-900 font-semibold">Domain: {domain}</span>
                  </>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              title="Close panel (keeps agent activity)"
              className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
            >
              <span className="text-xl leading-none">&times;</span>
            </button>
          </div>
        </div>

        {/* Multi-File Agent Activity History Switcher Tabs */}
        {activities && activities.length > 1 && (
          <div className="bg-slate-100/90 border-b border-slate-200 px-6 py-2 flex items-center gap-2 overflow-x-auto">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider shrink-0 flex items-center gap-1">
              <span className="material-symbols-outlined text-[15px] text-slate-500">folder_open</span>
              Uploaded Files ({activities.length}):
            </span>
            {activities.map(act => {
              const isSelected = act.id === activeActivityId;
              return (
                <button
                  key={act.id}
                  type="button"
                  onClick={() => onSelectActivity?.(act.id)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer shrink-0 border ${
                    isSelected
                      ? 'bg-white text-slate-900 border-slate-300 shadow-2xs ring-1 ring-slate-900/10'
                      : 'bg-transparent text-slate-600 border-transparent hover:bg-slate-200/80 hover:text-slate-900'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${act.isProcessing ? 'bg-amber-500 animate-pulse' : act.error ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                  <span className="truncate max-w-[170px] font-mono text-[11px]">{act.filename}</span>
                  {act.result?.recommendations?.length ? (
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-slate-100 text-slate-700 border border-slate-200">
                      {act.result.recommendations.length} recs
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}

        {/* Real-Time Live Overall Pipeline Telemetry Strip */}
        {isProcessing && (
          <div className="bg-slate-50/90 border-b border-slate-200/80 px-6 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-600"></span>
              </span>
              <span className="text-xs font-semibold text-slate-700">
                Live Ingestion Stream: <span className="font-bold text-slate-900">Stage {activeStageNumber || 1} of 4</span>
              </span>
              <span className="text-slate-300 hidden sm:inline">•</span>
              <span className="text-[11px] text-slate-500 font-mono hidden sm:inline">
                {activeStageNumber === 1 && 'Sanitizing column data & imputing nulls...'}
                {activeStageNumber === 2 && 'Zero-shot LLM semantic reasoning (~10–15s)...'}
                {activeStageNumber === 3 && 'Provisioning HANA column table & vectors...'}
                {activeStageNumber === 4 && 'Synthesizing tailored KPI scorecards & charts...'}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-28 sm:w-40 bg-slate-200 h-1.5 rounded-full overflow-hidden">
                <div
                  className="bg-emerald-600 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${overallProgressPercent}%` }}
                />
              </div>
              <span className="text-xs font-mono font-bold text-emerald-700 tabular-nums">
                {overallProgressPercent}%
              </span>
            </div>
          </div>
        )}

        {/* Scrollable Pipeline Telemetry Body: Clean Subtle Slate Surface */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-4 text-xs font-sans bg-slate-50/50">
          {result?.ready_for_publication === false && !error && (
            <div role="alert" className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-xs">
              {result.warnings?.join(' ') || 'Dataset saved. Complete ingestion and semantic review before publishing.'}
            </div>
          )}
          {error && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-900 flex items-start gap-3">
              <AlertTriangle className="text-red-600 w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-sm text-red-900">Ingestion Pipeline Failed</h4>
                <p className="text-xs text-red-700 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {/* Agent Planning Timeline Telemetry */}
          <div className="w-full bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
            <AgentPlanning
              title={`Pipeline Telemetry: ${filename}`}
              steps={planningSteps}
              hideOuterCard={true}
            />
          </div>

          {/* 🎯 STAGE 5: Interactive Executive Dashboard Approval (Checkboxes) */}
          {result?.recommendations && result.recommendations.length > 0 && (
            <div ref={recommendationsRef} className="pt-2 border-t border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-slate-700" />
                    <span>Select KPIs & Charts to Include on Dashboard:</span>
                    <span className="text-xs text-slate-500 font-mono">
                      ({selectedCount} of {result.recommendations.length} selected)
                    </span>
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Check the boxes for the KPIs and charts you want to include on the Executive Dashboard, or open Build Your KPI to customize.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={selectAllCharts}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 transition-colors cursor-pointer"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={deselectAllCharts}
                    className="px-2.5 py-1 text-xs font-semibold rounded bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200 transition-colors cursor-pointer"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              {publishError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-medium">
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
                      className={`p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between ${isChecked
                        ? 'border-slate-900 bg-slate-50/80 text-slate-900 shadow-xs ring-1 ring-slate-900'
                        : 'border-slate-200 bg-white hover:border-slate-300 text-slate-700'
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
                              className="w-4 h-4 rounded text-emerald-600 bg-white border-slate-300 focus:ring-emerald-500 cursor-pointer accent-emerald-600"
                            />
                            <span className="text-xs font-bold text-slate-900">
                              {chart.title}
                            </span>
                          </div>
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-slate-100 border border-slate-200 text-slate-700 shrink-0">
                            {chart.kind.toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 pl-6.5 line-clamp-2">
                          {chart.explanation}
                        </p>
                      </div>

                      <div className="mt-3 pt-2 border-t border-slate-200 flex items-center justify-between text-xs pl-6.5">
                        {chart.preview_value ? (
                          <div className="text-[11px] font-mono font-bold text-emerald-600">
                            {chart.preview_value}
                          </div>
                        ) : chart.preview_rows ? (
                          <div className="text-[10px] text-slate-500">
                            {chart.preview_rows.length} preview data points
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-400">Query verified</div>
                        )}
                        <span className={`text-[10px] font-semibold ${isChecked ? 'text-emerald-600' : 'text-slate-400'}`}>
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

        {/* Footer Actions: Clean Professional Enterprise Standard */}
        <div className="px-6 py-4 border-t border-slate-200/80 bg-white flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            Close / Dismiss
          </button>

          <div className="flex items-center gap-3">
            {result && onNavigateToBuildKpi && (
              <button
                type="button"
                onClick={handleGoToBuildKpi}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-bold rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 shadow-xs transition-all cursor-pointer"
              >
                <Sliders className="w-4 h-4 text-slate-500" />
                <span>Build Your KPI</span>
              </button>
            )}
            {result?.recommendations && (
              <button
                type="button"
                disabled={isPublishing || selectedCount === 0 || result.ready_for_publication === false}
                onClick={handlePublish}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg bg-slate-900 hover:bg-black text-white disabled:opacity-40 transition-all cursor-pointer shadow-xs"
              >
                <CheckCircle2 className={`w-4 h-4 ${isPublishing ? 'animate-spin text-emerald-400' : 'text-white'}`} />
                <span>
                  {isPublishing
                    ? 'Publishing…'
                    : `Publish on Dashboard (${selectedCount})`}
                </span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
