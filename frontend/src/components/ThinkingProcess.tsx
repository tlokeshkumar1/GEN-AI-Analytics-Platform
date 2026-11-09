import React, { useState, useEffect } from 'react';
import {
  Brain,
  Sparkles,
  ChevronDown,
  CheckCircle2,
  Clock,
  Database,
  Search,
  Code2,
  Terminal,
  Sliders,
  Cpu,
  Copy,
  Check,
  Layers,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  Zap,
  Activity
} from 'lucide-react';
import { ProcessingStep } from '../services/chatbotService';

interface ThinkingProcessProps {
  steps?: ProcessingStep[];
  isStreaming?: boolean;
  intent?: string;
  latency?: string;
  model?: string;
  similarity?: string;
  defaultExpanded?: boolean;
  className?: string;
}

export interface IntentDetails {
  key: string;
  label: string;
  description: string;
  dotColor: string;
  pillClass: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const resolveIntentDetails = (rawIntent?: string, steps?: ProcessingStep[], text?: string): IntentDetails => {
  const combined = `${rawIntent || ''} ${(steps || []).map(s => s.message + ' ' + s.stage).join(' ')} ${text || ''}`.toLowerCase();

  if (
    combined.includes('order') ||
    combined.includes('so-') ||
    combined.includes('so106760') ||
    combined.includes('106760') ||
    combined.includes('fulfillment') ||
    combined.includes('carrier') ||
    combined.includes('s/4hana')
  ) {
    return {
      key: 'order_lookup',
      label: 'Order Lookup',
      description: 'SAP S/4HANA Sales & Distribution ERP document verification',
      dotColor: 'bg-blue-500',
      pillClass: 'bg-blue-50/80 text-blue-700 border-blue-200/80',
      icon: Layers,
    };
  }

  if (
    combined.includes('vector') ||
    combined.includes('embedding') ||
    combined.includes('semantic') ||
    combined.includes('cosine') ||
    combined.includes('retriev') ||
    combined.includes('3,248')
  ) {
    return {
      key: 'vector_search',
      label: 'Vector Retrieval',
      description: 'SAP HANA Cloud Vector Engine semantic nearest-neighbor search',
      dotColor: 'bg-emerald-500',
      pillClass: 'bg-emerald-50/80 text-emerald-700 border-emerald-200/80',
      icon: Database,
    };
  }

  if (
    combined.includes('graph') ||
    combined.includes('chart') ||
    combined.includes('sql') ||
    combined.includes('margin') ||
    combined.includes('revenue') ||
    combined.includes('group by') ||
    combined.includes('aggregation') ||
    combined.includes('sales_fact')
  ) {
    return {
      key: 'analytics_graph',
      label: 'Analytics & SQL Aggregation',
      description: 'HANA Column Store in-memory SQL execution and measure synthesis',
      dotColor: 'bg-indigo-500',
      pillClass: 'bg-indigo-50/80 text-indigo-700 border-indigo-200/80',
      icon: Terminal,
    };
  }

  return {
    key: 'conversational_reasoning',
    label: 'Analytical Reasoning',
    description: 'Autonomous multi-hop query deconstruction and enterprise synthesis',
    dotColor: 'bg-violet-500',
    pillClass: 'bg-violet-50/80 text-violet-700 border-violet-200/80',
    icon: Brain,
  };
};

export const getStageMeta = (stage: string) => {
  const s = stage.toLowerCase();
  if (s.includes('intent')) {
    return {
      name: 'Intent Classification & Query Planning',
      icon: Brain,
      badge: 'Intent Resolution',
      color: 'text-violet-600',
      bgColor: 'bg-violet-50',
      borderColor: 'border-violet-200',
    };
  }
  if (s.includes('retriev') || s.includes('vector') || s.includes('embed') || s.includes('search')) {
    return {
      name: 'SAP HANA Vector Retrieval',
      icon: Database,
      badge: 'Vector Engine',
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-50',
      borderColor: 'border-emerald-200',
    };
  }
  if (s.includes('erp') || s.includes('order') || s.includes('s4') || s.includes('lookup')) {
    return {
      name: 'SAP S/4HANA Order Lookup',
      icon: Layers,
      badge: 'Order Record',
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-200',
    };
  }
  if (s.includes('calc') || s.includes('sql') || s.includes('exec') || s.includes('query')) {
    return {
      name: 'Deterministic Analytics Engine',
      icon: Terminal,
      badge: 'Column Store',
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-50',
      borderColor: 'border-indigo-200',
    };
  }
  if (s.includes('rerank') || s.includes('filter') || s.includes('cross')) {
    return {
      name: 'Cross-Encoder Re-Ranking & Grounding',
      icon: Sliders,
      badge: 'Re-Ranking',
      color: 'text-amber-600',
      bgColor: 'bg-amber-50',
      borderColor: 'border-amber-200',
    };
  }
  if (s.includes('error') || s.includes('fail') || s.includes('notice')) {
    return {
      name: 'Execution Notice',
      icon: AlertCircle,
      badge: 'Notice',
      color: 'text-rose-600',
      bgColor: 'bg-rose-50',
      borderColor: 'border-rose-200',
    };
  }
  return {
    name: 'NVIDIA NIM Synthesis & Model Inference',
    icon: Sparkles,
    badge: 'LLM Synthesis',
    color: 'text-purple-600',
    bgColor: 'bg-purple-50',
    borderColor: 'border-purple-200',
  };
};

export const ThinkingProcess: React.FC<ThinkingProcessProps> = ({
  steps = [],
  isStreaming = false,
  intent,
  latency,
  model,
  similarity,
  defaultExpanded,
  className = '',
}) => {
  // Controlled expansion state: collapsed by default until user explicitly opens it
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded ?? false);
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  // Live timer for reasoning elapsed time
  useEffect(() => {
    if (!isStreaming) return;
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 100) / 10);
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const intentDetails = resolveIntentDetails(intent, steps);
  const IntentIcon = intentDetails.icon;

  // Deduplicate steps by stage to eliminate redundant progress boxes
  const stepMap = new Map<string, ProcessingStep>();
  for (const s of (steps || [])) {
    stepMap.set(s.stage, s);
  }
  const uniqueSteps = Array.from(stepMap.values());
  const completedSteps = uniqueSteps.filter(s => s.status === 'completed');
  const runningStep = uniqueSteps.find(s => s.status === 'running');
  const activeStep = runningStep || completedSteps[completedSteps.length - 1] || uniqueSteps[0];
  const activeStepMeta = activeStep ? getStageMeta(activeStep.stage) : null;

  const totalStepsCount = Math.max(uniqueSteps.length, 1);
  const completedCount = completedSteps.length;

  const handleCopyTrace = (e: React.MouseEvent) => {
    e.stopPropagation();
    const traceText = [
      `=== NEOVATIC RAG CHAT REASONING TRACE ===`,
      `Intent: ${intentDetails.label} (${intentDetails.description})`,
      `Total Latency: ${latency || (elapsedSeconds ? `${elapsedSeconds.toFixed(1)}s` : 'Real-time')}`,
      `Model Engine: ${model || 'Not reported'}`,
      `Retrieval match score: ${similarity || 'Not reported'}`,
      `\n--- EXECUTION STEPS ---`,
      ...uniqueSteps.map((s, idx) => {
        const meta = getStageMeta(s.stage);
        return `[Step ${idx + 1}/${uniqueSteps.length}] ${meta.name} [${s.status.toUpperCase()}]\nMessage: ${s.message || 'Executing'}\n`;
      }),
    ].join('\n');

    navigator.clipboard.writeText(traceText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!steps || steps.length === 0) {
    if (isStreaming) {
      return (
        <div className={`rounded-lg border border-slate-200/80 bg-slate-50/80 px-3 py-1.5 text-xs text-slate-600 flex items-center gap-2 animate-pulse ${className}`}>
          <Brain className="w-3.5 h-3.5 text-violet-600 animate-spin" />
          <span className="font-medium text-slate-700">Thinking...</span>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      className={`rounded-xl border transition-all duration-200 overflow-hidden font-sans ${
        isStreaming
          ? 'bg-slate-50/60 border-violet-200/70 shadow-2xs'
          : isExpanded
          ? 'bg-[#F8FAFC] border-slate-300/80 shadow-2xs'
          : 'bg-[#F8FAFC]/50 border-slate-200/80 hover:border-slate-300'
      } ${className}`}
    >
      {/* ── Compact Sleek Header Bar ── */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-left px-3 py-1.5 flex items-center justify-between gap-2.5 cursor-pointer select-none transition-colors group"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              isStreaming ? 'text-violet-600' : 'text-slate-400 group-hover:text-slate-600'
            }`}
          >
            {isStreaming ? (
              <Brain className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
          </div>
          <span className="font-medium text-xs text-slate-700">
            {isStreaming
              ? `Thinking (${elapsedSeconds.toFixed(1)}s)...`
              : `Thought for ${latency || '0.2s'}`}
          </span>
          <span className="text-slate-300" aria-hidden="true">·</span>
          <span className="text-xs text-slate-500 font-medium truncate">{intentDetails.label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-slate-400 group-hover:text-slate-600">
          <span className="text-[10px] font-mono hidden sm:inline">{completedCount}/{totalStepsCount} steps</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* ── Expanded Reasoning Body ── */}
      {isExpanded && (
        <div className="px-3.5 sm:px-4 pb-3.5 pt-2 border-t border-slate-200/80 bg-white/90 animate-in fade-in slide-in-from-top-1 space-y-2.5">
          {/* Quick Trace Header with Copy Action */}
          <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-100">
            <span className="font-mono text-[10px] text-slate-400">Execution Pipeline Trace</span>
            <button
              type="button"
              onClick={handleCopyTrace}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-medium transition-all cursor-pointer"
              title="Copy reasoning trace to clipboard"
            >
              {copied ? (
                <>
                  <Check className="w-2.5 h-2.5 text-emerald-600" />
                  <span className="text-emerald-700 font-semibold">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-2.5 h-2.5 text-slate-400" />
                  <span>Copy trace</span>
                </>
              )}
            </button>
          </div>

          {/* ── Step-by-Step Clean Timeline ── */}
          <div className="space-y-1.5 text-xs">
            {uniqueSteps.map((step, idx) => {
              const meta = getStageMeta(step.stage);
              const StageIcon = meta.icon;
              const isRunning = step.status === 'running';
              const isDone = step.status === 'completed';
              const isErr = step.status === 'failed' || step.status === 'error';

              return (
                <div key={idx} className="flex items-center justify-between py-1 px-2 rounded-lg bg-slate-50/70 border border-slate-100 text-[11px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`p-0.5 rounded ${meta.bgColor} ${meta.color}`}>
                      <StageIcon className="w-3 h-3" />
                    </div>
                    <span className="font-medium text-slate-800">{meta.name}:</span>
                    <span className="text-slate-600 truncate max-w-[280px] sm:max-w-md">{step.message || 'Executing stage'}</span>
                  </div>
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-semibold shrink-0 ml-2 ${
                      isRunning ? 'bg-violet-100 text-violet-700 animate-pulse' :
                      isDone ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60' :
                      isErr ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {isRunning ? 'Running' : isDone ? 'Done' : step.status}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ── Footer Metadata Banner (ChatGPT / Claude Technical Audit) ── */}
          <div className="pt-2 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-slate-500">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="flex items-center gap-1 text-slate-600">
                <Cpu className="w-3 h-3 text-violet-600" />
                <span>{model || 'Not reported'}</span>
              </span>
              <span>·</span>
              <span className="flex items-center gap-1 text-slate-600">
                <Database className="w-3 h-3 text-emerald-600" />
                <span>SAP HANA Cloud Vector Engine</span>
              </span>
              {similarity && similarity !== 'Not available' && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1 text-emerald-700 font-semibold">
                    <ShieldCheck className="w-3 h-3 text-emerald-600" />
                    <span>Cosine Similarity: {similarity}</span>
                  </span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="text-slate-500 hover:text-slate-800 flex items-center gap-0.5 hover:underline cursor-pointer"
            >
              <span>Collapse thought</span>
              <ChevronDown className="w-3 h-3 rotate-180" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
