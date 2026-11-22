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
  if (rawIntent === 'hybrid_record') {
    return { key: 'hybrid_record', label: 'Hybrid Retrieval', description: 'Exact record values combined with relevant VECTOR_TABLE evidence',
      dotColor: 'bg-[var(--color-ai)]', pillClass: 'bg-[var(--color-ai-soft)] text-[var(--color-ai)] border-[var(--color-ai-muted)]', icon: Layers };
  }
  if (rawIntent === 'exact_record') {
    return { key: 'exact_record', label: 'Record Lookup', description: 'Exact structured record evidence',
      dotColor: 'bg-[var(--color-primary)]', pillClass: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-muted)]', icon: Database };
  }
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
      label: 'Record Lookup',
      description: 'Structured entity record lookup and attribute verification',
      dotColor: 'bg-[var(--color-primary)]',
      pillClass: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-muted)]',
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
      dotColor: 'bg-[var(--color-success)]',
      pillClass: 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-muted)]',
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
      dotColor: 'bg-[var(--color-indigo)]',
      pillClass: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)] border-[var(--color-indigo)]/20',
      icon: Terminal,
    };
  }

  return {
    key: 'conversational_reasoning',
    label: 'Analytical Reasoning',
    description: 'Autonomous multi-hop query deconstruction and enterprise synthesis',
    dotColor: 'bg-[var(--color-ai)]',
    pillClass: 'bg-[var(--color-ai-soft)] text-[var(--color-ai)] border-[var(--color-ai-muted)]',
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
      color: 'text-[var(--color-ai)]',
      bgColor: 'bg-[var(--color-ai-soft)]',
      borderColor: 'border-[var(--color-ai-muted)]',
    };
  }
  if (s.includes('retriev') || s.includes('vector') || s.includes('embed') || s.includes('search')) {
    return {
      name: 'SAP HANA Vector Retrieval',
      icon: Database,
      badge: 'Vector Engine',
      color: 'text-[var(--color-success)]',
      bgColor: 'bg-[var(--color-success-soft)]',
      borderColor: 'border-[var(--color-success-muted)]',
    };
  }
  if (s.includes('erp') || s.includes('order') || s.includes('s4') || s.includes('lookup')) {
    return {
      name: 'SAP S/4HANA Order Lookup',
      icon: Layers,
      badge: 'Order Record',
      color: 'text-[var(--color-primary)]',
      bgColor: 'bg-[var(--color-primary-soft)]',
      borderColor: 'border-[var(--color-primary-muted)]',
    };
  }
  if (s.includes('calc') || s.includes('sql') || s.includes('exec') || s.includes('query')) {
    return {
      name: 'Deterministic Analytics Engine',
      icon: Terminal,
      badge: 'Column Store',
      color: 'text-[var(--color-indigo)]',
      bgColor: 'bg-[var(--color-indigo-soft)]',
      borderColor: 'border-[var(--color-indigo)]/20',
    };
  }
  if (s.includes('rerank') || s.includes('filter') || s.includes('cross')) {
    return {
      name: 'Cross-Encoder Re-Ranking & Grounding',
      icon: Sliders,
      badge: 'Re-Ranking',
      color: 'text-[var(--color-warning)]',
      bgColor: 'bg-[var(--color-warning-soft)]',
      borderColor: 'border-[var(--color-warning-muted)]',
    };
  }
  if (s.includes('error') || s.includes('fail') || s.includes('notice')) {
    return {
      name: 'Execution Notice',
      icon: AlertCircle,
      badge: 'Notice',
      color: 'text-[var(--color-error)]',
      bgColor: 'bg-[var(--color-error-soft)]',
      borderColor: 'border-[var(--color-error-muted)]',
    };
  }
  return {
    name: 'NVIDIA NIM Synthesis & Model Inference',
    icon: Sparkles,
    badge: 'LLM Synthesis',
    color: 'text-[var(--color-ai)]',
    bgColor: 'bg-[var(--color-ai-soft)]',
    borderColor: 'border-[var(--color-ai-muted)]',
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
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded ?? false);
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  useEffect(() => {
    if (!isStreaming) return;
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 100) / 10);
    }, 100);
    return () => clearInterval(timer);
  }, [isStreaming]);

  const intentDetails = resolveIntentDetails(intent, steps);

  const stepMap = new Map<string, ProcessingStep>();
  for (const s of (steps || [])) {
    stepMap.set(s.stage, s);
  }
  const uniqueSteps = Array.from(stepMap.values());
  const completedSteps = uniqueSteps.filter(s => s.status === 'completed');

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
        <div className={`rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] flex items-center gap-2 animate-pulse ${className}`}>
          <Brain className="w-3.5 h-3.5 text-[var(--color-ai)] animate-spin" />
          <span className="font-medium text-[var(--color-text-primary)]">Thinking…</span>
        </div>
      );
    }
    return null;
  }

  return (
    <div
      className={`rounded-[var(--radius-container)] border transition-all duration-200 overflow-hidden font-sans ${
        isStreaming
          ? 'bg-[var(--color-background-subtle)] border-[var(--color-ai-muted)] shadow-[var(--shadow-xs)]'
          : isExpanded
          ? 'bg-[var(--color-background-subtle)] border-[var(--color-border-strong)] shadow-[var(--shadow-xs)]'
          : 'bg-[var(--color-background-subtle)]/70 border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
      } ${className}`}
    >
      {/* Compact Header Bar */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-left px-3 py-1.5 flex items-center justify-between gap-2.5 cursor-pointer select-none transition-colors group"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              isStreaming ? 'text-[var(--color-ai)]' : 'text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]'
            }`}
          >
            {isStreaming ? (
              <Brain className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
          </div>
          <span className="font-medium text-xs text-[var(--color-text-primary)]">
            {isStreaming
              ? `Thinking (${elapsedSeconds.toFixed(1)}s)…`
              : `Thought for ${latency || '0.2s'}`}
          </span>
          <span className="text-[var(--color-border-strong)]" aria-hidden="true">·</span>
          <span className="text-xs text-[var(--color-text-muted)] font-medium truncate">{intentDetails.label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]">
          <span className="text-[10px] font-mono hidden sm:inline">{completedCount}/{totalStepsCount} steps</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {/* Expanded Reasoning Body */}
      {isExpanded && (
        <div className="px-3.5 sm:px-4 pb-3 pt-2 border-t border-[var(--color-border)] bg-[var(--color-background-surface)] space-y-2.5">
          {/* Quick Trace Header with Copy Action */}
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)] pb-1 border-b border-[var(--color-border)]">
            <span className="font-mono text-[10px]">Execution Pipeline Trace</span>
            <button
              type="button"
              onClick={handleCopyTrace}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] text-[10px] font-medium transition-all cursor-pointer"
              title="Copy reasoning trace to clipboard"
            >
              {copied ? (
                <>
                  <Check className="w-2.5 h-2.5 text-[var(--color-success)]" />
                  <span className="text-[var(--color-success)] font-medium">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-2.5 h-2.5 text-[var(--color-text-muted)]" />
                  <span>Copy trace</span>
                </>
              )}
            </button>
          </div>

          {/* Step-by-Step Clean Timeline */}
          <div className="space-y-1.5 text-xs">
            {uniqueSteps.map((step, idx) => {
              const meta = getStageMeta(step.stage);
              const StageIcon = meta.icon;
              const isRunning = step.status === 'running';
              const isDone = step.status === 'completed';
              const isErr = step.status === 'failed' || step.status === 'error';

              return (
                <div key={idx} className="flex items-center justify-between py-1.5 px-2 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] text-[11px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`p-0.5 rounded-[var(--radius-inner)] ${meta.bgColor} ${meta.color}`}>
                      <StageIcon className="w-3 h-3" />
                    </div>
                    <span className="font-medium text-[var(--color-text-primary)]">{meta.name}:</span>
                    <span className="text-[var(--color-text-secondary)] truncate max-w-[280px] sm:max-w-md">{step.message || 'Executing stage'}</span>
                  </div>
                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded-[var(--radius-inner)] font-semibold shrink-0 ml-2 ${
                      isRunning ? 'bg-[var(--color-ai-soft)] text-[var(--color-ai)] animate-pulse' :
                      isDone ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success-muted)]' :
                      isErr ? 'bg-[var(--color-error-soft)] text-[var(--color-error)]' : 'bg-[var(--color-background-muted)] text-[var(--color-text-muted)]'
                    }`}
                  >
                    {isRunning ? 'Running' : isDone ? 'Done' : step.status}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Footer Metadata Banner */}
          <div className="pt-2 border-t border-[var(--color-border)] flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono text-[var(--color-text-muted)]">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                <Cpu className="w-3 h-3 text-[var(--color-ai)]" />
                <span>{model || 'Not reported'}</span>
              </span>
              <span>·</span>
              <span className="flex items-center gap-1 text-[var(--color-text-secondary)]">
                <Database className="w-3 h-3 text-[var(--color-success)]" />
                <span>SAP HANA Cloud Vector Engine</span>
              </span>
              {similarity && similarity !== 'Not available' && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1 text-[var(--color-success)] font-medium">
                    <ShieldCheck className="w-3 h-3 text-[var(--color-success)]" />
                    <span>Cosine Similarity: {similarity}</span>
                  </span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] flex items-center gap-0.5 hover:underline cursor-pointer"
            >
              <span>Collapse</span>
              <ChevronDown className="w-3 h-3 rotate-180" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
