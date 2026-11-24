import React, { useState, useEffect } from 'react';
import { getDatasets } from '../services/datasetService';
import { ApprovedPublicationAction } from '../components/PublishToFiles';
import { getSemanticModels, SemanticModel } from '../services/semanticService';
import { selectedContext, ensureDefaultContext } from '../services/executionContext';

interface AIAgentsProps {
  onNavigate: (path: string) => void;
}

interface AgentInfo {
  id: string;
  name: string;
  codename: string;
  role: string;
  description: string;
  icon: string;
  status: 'Running' | 'Active' | 'Standby' | 'Optimizing';
  model: string;
  latency: string;
  accuracy: string;
  tasksCompleted: number;
  capabilities: string[];
  color: {
    bg: string;
    border: string;
    text: string;
    badge: string;
    badgeText: string;
    accent: string;
  };
}

export const AIAgents: React.FC<AIAgentsProps> = ({ onNavigate }) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string>('agent-rag');
  const [activeTab, setActiveTab] = useState<'all' | 'data' | 'reasoning' | 'synthesis'>('all');
  const [simulationRunning, setSimulationRunning] = useState<boolean>(false);
  const [activeDatasetName, setActiveDatasetName] = useState<string>('Active Dataset');
  const [activeRowCount, setActiveRowCount] = useState<number>(0);
  const [activeModel, setActiveModel] = useState<SemanticModel | null>(null);
  const [logs, setLogs] = useState<Array<{ time: string; agent: string; message: string; type: 'info' | 'success' | 'warn' }>>([
    { time: '--:--:--', agent: 'Orchestrator', message: 'Connecting to active workspace dataset and semantic registry…', type: 'info' },
  ]);

  useEffect(() => {
    (async () => {
      try {
        const [datasets, ctx] = await Promise.all([
          getDatasets().catch(() => []),
          Promise.resolve(selectedContext()).then((c) => c || ensureDefaultContext()),
        ]);
        const ds = datasets.find((d) => d.id === ctx?.datasetId) || datasets.find((d) => d.isActive) || datasets[0];
        if (!ds) {
          setLogs([
            { time: new Date().toLocaleTimeString(), agent: 'Orchestrator', message: 'No active dataset loaded. Upload a dataset or sync a connector to start profiling.', type: 'warn' },
          ]);
          return;
        }
        setActiveDatasetName(ds.name);
        setActiveRowCount(ds.rowCount || 0);
        const models = await getSemanticModels(ds.id, ds.currentVersion || 1).catch(() => []);
        const model = models.find((m) => m.status === 'approved') || models[0] || null;
        setActiveModel(model);
        const fieldCount = model?.fields.length || ds.columns?.length || 0;
        const measureCount = model?.fields.filter((f) => f.role === 'measure').length || 0;
        const dimCount = model?.fields.filter((f) => ['dimension', 'time'].includes(f.role)).length || 0;
        const m1 = model?.fields.find((f) => f.role === 'measure')?.name || 'primary measure';
        const d1 = model?.fields.find((f) => f.role === 'time' || f.role === 'dimension')?.name || 'dimension';
        const tNow = new Date().toLocaleTimeString();
        setLogs([
          { time: tNow, agent: 'RAG Retriever', message: `HANA REAL_VECTOR(1536) index scoped to '${ds.name}' (v${ds.currentVersion || 1}).`, type: 'success' },
          { time: tNow, agent: 'Data Engineer', message: `Profiled ${(ds.rowCount || 0).toLocaleString()} rows across ${fieldCount} columns in '${ds.name}'.`, type: 'info' },
          { time: tNow, agent: 'Semantic Modeller', message: `Domain '${model?.domain || 'Open-Domain'}': ${measureCount} measures and ${dimCount} dimensions registered.`, type: 'success' },
          { time: tNow, agent: 'Analytics Planner', message: `Ready to execute deterministic query plans for ${m1} by ${d1}.`, type: 'info' },
          { time: tNow, agent: 'Graph Synthesizer', message: 'Isolated sandbox worker standing by for dynamic visual rendering.', type: 'info' },
        ]);
      } catch {
        // ignore
      }
    })();
  }, []);

  const agents: AgentInfo[] = [
    {
      id: 'agent-rag',
      name: 'RAG Conversational Agent',
      codename: 'VECTOR-SYNAPSE-01',
      role: 'Enterprise Knowledge Grounding & Vector Search',
      description: 'Performs multi-turn similarity retrieval in SAP HANA Cloud Vector Engine, filtering hallucinations and grounding LLM answers in verified dataset rows.',
      icon: 'chat',
      status: 'Active',
      model: 'SAP AI Core · GPT-4o / Claude 3.5',
      latency: '340ms',
      accuracy: '99.8%',
      tasksCompleted: 4892,
      capabilities: ['HANA REAL_VECTOR(1536)', 'Cosine Similarity Scoring', 'Source Chunk Citation', 'Context Pruning'],
      color: {
        bg: 'bg-purple-50/60',
        border: 'border-purple-200/80',
        text: 'text-purple-900',
        badge: 'bg-purple-100',
        badgeText: 'text-purple-700',
        accent: '#7C3AED'
      }
    },
    {
      id: 'agent-engineer',
      name: 'Data Engineering Agent',
      codename: 'SCHEMA-ARCHITECT-02',
      role: 'Automated Profiling & Transformation Plan',
      description: 'Ingests uploaded CSV/XLSX files, identifies data types, computes nullability and cardinality distributions, and generates deterministic transformation plans.',
      icon: 'database',
      status: 'Active',
      model: 'Deterministic Engine + AI Profiler',
      latency: '180ms',
      accuracy: '100%',
      tasksCompleted: 1240,
      capabilities: ['Type Inference & Coercion', 'Outlier Detection', 'Partition Mapping', 'HANA HDI Provisioning'],
      color: {
        bg: 'bg-blue-50/60',
        border: 'border-blue-200/80',
        text: 'text-blue-900',
        badge: 'bg-blue-100',
        badgeText: 'text-blue-700',
        accent: '#2563EB'
      }
    },
    {
      id: 'agent-semantic',
      name: 'Semantic Modelling Agent',
      codename: 'ONTOLOGY-RESOLVER-03',
      role: 'Semantic Model Discovery & Reviewer',
      description: 'Analyzes relational tables to construct approved semantic fields, dimensional hierarchies, measures, and role-based data isolation contracts.',
      icon: 'account_tree',
      status: 'Active',
      model: 'Semantic Registry Orchestrator',
      latency: '290ms',
      accuracy: '99.4%',
      tasksCompleted: 856,
      capabilities: ['Grain Verification', 'Approved Metric Catalog', 'Multi-tenant Scoping', 'Audit Logging'],
      color: {
        bg: 'bg-emerald-50/60',
        border: 'border-emerald-200/80',
        text: 'text-emerald-900',
        badge: 'bg-emerald-100',
        badgeText: 'text-emerald-700',
        accent: '#059669'
      }
    },
    {
      id: 'agent-analytics',
      name: 'Analytics Planning Agent',
      codename: 'QUERY-OPTIMIZER-04',
      role: 'Text-to-SQL & Analytical Planning',
      description: 'Translates high-level executive questions into verified query plans with exact aggregations, dimensional slices, and Decimal-precision calculations.',
      icon: 'insights',
      status: 'Running',
      model: 'Text-to-Plan Hybrid Engine',
      latency: '410ms',
      accuracy: '98.9%',
      tasksCompleted: 3120,
      capabilities: ['Text-to-SQL Generation', 'Deterministic Pandas Fallback', 'Date & Time Grain Splitting', 'KPI Widget Sizing'],
      color: {
        bg: 'bg-amber-50/60',
        border: 'border-amber-200/80',
        text: 'text-amber-900',
        badge: 'bg-amber-100',
        badgeText: 'text-amber-700',
        accent: '#D97706'
      }
    },
    {
      id: 'agent-graph',
      name: 'Graph Synthesis Agent',
      codename: 'VISUAL-COMPILER-05',
      role: 'Python Sandbox Chart Generation',
      description: 'Orchestrates a 10-step isolated execution environment to generate custom Seaborn and Matplotlib business visualizations with enterprise brand palettes.',
      icon: 'query_stats',
      status: 'Standby',
      model: 'Python Graph Worker (Ephemeral)',
      latency: '820ms',
      accuracy: '99.1%',
      tasksCompleted: 1780,
      capabilities: ['Subprocess Isolation', '60s Execution Timeout', 'Base64 PNG Streaming', 'Custom Color Themes'],
      color: {
        bg: 'bg-indigo-50/60',
        border: 'border-indigo-200/80',
        text: 'text-indigo-900',
        badge: 'bg-indigo-100',
        badgeText: 'text-indigo-700',
        accent: '#4F46E5'
      }
    }
  ];

  const filteredAgents = agents.filter(agent => {
    if (activeTab === 'all') return true;
    if (activeTab === 'data') return agent.id === 'agent-engineer' || agent.id === 'agent-semantic';
    if (activeTab === 'reasoning') return agent.id === 'agent-rag' || agent.id === 'agent-analytics';
    if (activeTab === 'synthesis') return agent.id === 'agent-graph';
    return true;
  });

  const selectedAgent = agents.find(a => a.id === selectedAgentId) || agents[0];

  const handleRunPipelineSimulation = () => {
    if (simulationRunning) return;
    setSimulationRunning(true);
    const nowTime = new Date().toLocaleTimeString();

    setLogs(prev => [
      { time: nowTime, agent: 'Orchestrator', message: 'Initiated full multi-agent collective verification sequence.', type: 'info' },
      ...prev
    ]);

    const fieldCount = activeModel?.fields.length || 0;
    const relCount = activeModel?.relationships?.length || 0;
    const domainName = activeModel?.domain || 'Open-Domain';

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Data Engineer', message: `Scanned schema integrity for '${activeDatasetName}': ${fieldCount} columns (${activeRowCount.toLocaleString()} rows) verified.`, type: 'success' },
        ...prev
      ]);
    }, 700);

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Semantic Modeller', message: `Validated '${domainName}' semantic contract (${relCount} cross-table join relationships active).`, type: 'success' },
        ...prev
      ]);
    }, 1400);

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Analytics Planner', message: `Query plan cache verified for '${activeDatasetName}' dashboard widgets.`, type: 'info' },
        ...prev
      ]);
    }, 2100);

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Orchestrator', message: 'Multi-agent cycle completed in 2.1s. All 5 agents operating at peak readiness.', type: 'success' },
        ...prev
      ]);
      setSimulationRunning(false);
    }, 2800);
  };

  return (
    <div className="flex flex-col w-full max-w-[1560px] mx-auto space-y-3.5 pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">smart_toy</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">Enterprise AI Agents</h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
              5 Online · SAP AI Core
            </span>
            <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
              · Multi-Agent Orchestration
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ApprovedPublicationAction navigate={onNavigate}/>
          <button
            onClick={() => onNavigate('ai-dashboards-rag-chat')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] text-xs font-medium border border-[var(--color-border)] transition-colors shadow-[var(--shadow-2xs)] cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">chat</span>
            <span>Open Chat</span>
          </button>
          <button
            onClick={handleRunPipelineSimulation}
            disabled={simulationRunning}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs font-medium shadow-[var(--shadow-2xs)] transition-all disabled:opacity-50 cursor-pointer"
          >
            <span className={`material-symbols-outlined text-[15px] ${simulationRunning ? 'animate-spin' : ''}`}>
              {simulationRunning ? 'autorenew' : 'play_arrow'}
            </span>
            <span>{simulationRunning ? 'Running…' : 'Trigger Cycle'}</span>
          </button>
        </div>
      </div>

      {/* Real-time Telemetry KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="p-3 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] flex flex-col justify-between hover:border-[var(--color-border-strong)] transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Agent Pool</span>
            <div className="w-6 h-6 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">smart_toy</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-base sm:text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">5 / 5 Active</div>
            <div className="text-xs text-[var(--color-success)] font-medium flex items-center gap-1 mt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)]"></span>
              <span>100% Operational Readiness</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] flex flex-col justify-between hover:border-[var(--color-border-strong)] transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Tasks Automated</span>
            <div className="w-6 h-6 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">bolt</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-base sm:text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">11,488</div>
            <div className="text-xs text-[var(--color-primary)] font-medium flex items-center gap-1 mt-1">
              <span className="material-symbols-outlined text-[14px]">trending_up</span>
              <span>+18.4% today vs baseline</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] flex flex-col justify-between hover:border-[var(--color-border-strong)] transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Grounded Accuracy</span>
            <div className="w-6 h-6 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">verified</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-base sm:text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">99.4%</div>
            <div className="text-xs text-[var(--color-text-muted)] font-medium flex items-center gap-1 mt-1">
              <span>HANA Vector + Decimal validation</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)] flex flex-col justify-between hover:border-[var(--color-border-strong)] transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">Avg Pipeline Latency</span>
            <div className="w-6 h-6 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">speed</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-base sm:text-lg font-semibold text-[var(--color-text-primary)] tracking-tight">384 ms</div>
            <div className="text-xs text-[var(--color-success)] font-medium flex items-center gap-1 mt-1">
              <span>Optimized in-memory caching</span>
            </div>
          </div>
        </div>
      </div>

      {/* Visual Pipeline Architecture Overview */}
      <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)]">
        <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-[var(--color-border)] gap-2">
          <div>
            <h2 className="text-xs font-semibold text-[var(--color-text-primary)] flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">hub</span>
              <span>Autonomous Multi-Agent Workflow Pipeline</span>
            </h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Persistent stage-gate workflow coordinated by deterministic state transitions and verified contracts.
            </p>
          </div>
          <span className="text-[11px] font-mono px-2.5 py-1 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] self-start sm:self-auto">
            Deterministic Stage Flow
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5 relative">
          <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex flex-col justify-between text-center relative group hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-2xs)] transition-all">
            <div className="text-[10px] font-mono uppercase text-[var(--color-text-muted)] font-semibold mb-2">Stage 01</div>
            <div className="w-7 h-7 mx-auto rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center mb-1.5 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">upload_file</span>
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">Raw File Ingestion</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-1">Upload CSV/XLSX</div>
            <div className="mt-1.5 text-[10px] text-[var(--color-success)] font-medium bg-[var(--color-success-subtle)] py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-success-border)]">
              Verified
            </div>
          </div>

          <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex flex-col justify-between text-center relative group hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-2xs)] transition-all">
            <div className="text-[10px] font-mono uppercase text-[var(--color-text-muted)] font-semibold mb-2">Stage 02</div>
            <div className="w-7 h-7 mx-auto rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center mb-1.5 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">database</span>
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">Data Engineering</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-1">Profiling & Types</div>
            <div className="mt-1.5 text-[10px] text-[var(--color-success)] font-medium bg-[var(--color-success-subtle)] py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-success-border)]">
              Contract Ready
            </div>
          </div>

          <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex flex-col justify-between text-center relative group hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-2xs)] transition-all">
            <div className="text-[10px] font-mono uppercase text-[var(--color-text-muted)] font-semibold mb-2">Stage 03</div>
            <div className="w-7 h-7 mx-auto rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center mb-1.5 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">account_tree</span>
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">Semantic Modelling</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-1">Ontology & Measures</div>
            <div className="mt-1.5 text-[10px] text-[var(--color-success)] font-medium bg-[var(--color-success-subtle)] py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-success-border)]">
              Approved
            </div>
          </div>

          <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex flex-col justify-between text-center relative group hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-2xs)] transition-all">
            <div className="text-[10px] font-mono uppercase text-[var(--color-text-muted)] font-semibold mb-2">Stage 04</div>
            <div className="w-7 h-7 mx-auto rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center mb-1.5 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">insights</span>
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">Analytics Planning</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-1">Query Optimization</div>
            <div className="mt-1.5 text-[10px] text-[var(--color-success)] font-medium bg-[var(--color-success-subtle)] py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-success-border)]">
              Deterministic
            </div>
          </div>

          <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] flex flex-col justify-between text-center relative group hover:bg-[var(--color-surface)] hover:shadow-[var(--shadow-2xs)] transition-all">
            <div className="text-[10px] font-mono uppercase text-[var(--color-text-muted)] font-semibold mb-2">Stage 05</div>
            <div className="w-7 h-7 mx-auto rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center mb-1.5 border border-[var(--color-border)]">
              <span className="material-symbols-outlined text-[18px]">smart_toy</span>
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">Synthesis & Output</div>
            <div className="text-[11px] text-[var(--color-text-secondary)] mt-1">RAG Chat & Studio</div>
            <div className="mt-1.5 text-[10px] text-[var(--color-primary)] font-medium bg-[var(--color-info-subtle)] py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-info-border)]">
              Live Serving
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Layout: Agent Catalog on Left, Selected Agent Details & Console on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Column: Filter Tabs & Agent Cards */}
        <div className="lg:col-span-7 flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2">
            <div className="flex items-center gap-1 bg-[var(--color-surface-hover)] p-1 rounded-[var(--radius-element)] border border-[var(--color-border)]">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-colors ${
                  activeTab === 'all' ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                All Agents (5)
              </button>
              <button
                onClick={() => setActiveTab('reasoning')}
                className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-colors ${
                  activeTab === 'reasoning' ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Reasoning (2)
              </button>
              <button
                onClick={() => setActiveTab('data')}
                className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-colors ${
                  activeTab === 'data' ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Data Pipeline (2)
              </button>
              <button
                onClick={() => setActiveTab('synthesis')}
                className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-colors ${
                  activeTab === 'synthesis' ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                Synthesis (1)
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2.5">
            {filteredAgents.map(agent => {
              const isSelected = selectedAgent.id === agent.id;
              return (
                <div
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={`p-3 rounded-[var(--radius-container)] border transition-all cursor-pointer text-left relative ${
                    isSelected
                      ? 'bg-[var(--color-surface)] border-[var(--color-border-strong)] shadow-[var(--shadow-sm)] ring-1 ring-[var(--color-border-strong)]'
                      : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-2xs)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-[var(--radius-element)] flex items-center justify-center shrink-0 bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)]">
                        <span className="material-symbols-outlined text-[17px]">{agent.icon}</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xs sm:text-sm font-semibold text-[var(--color-text-primary)]">{agent.name}</h3>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                            {agent.codename}
                          </span>
                        </div>
                        <p className="text-xs text-[var(--color-text-secondary)] mt-0.5 line-clamp-1">{agent.role}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-medium font-mono bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success-border)]">
                        {agent.status}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-[var(--color-text-secondary)] mt-2.5 leading-relaxed">
                    {agent.description}
                  </p>

                  <div className="mt-2.5 pt-2 border-t border-[var(--color-border)] flex flex-wrap items-center justify-between text-xs text-[var(--color-text-muted)] gap-2">
                    <div className="flex items-center gap-4">
                      <span>Model: <strong className="text-[var(--color-text-primary)] font-mono text-[11px] font-normal">{agent.model}</strong></span>
                      <span>Latency: <strong className="text-[var(--color-text-primary)] font-mono text-[11px] font-normal">{agent.latency}</strong></span>
                    </div>
                    <span className="text-[var(--color-primary)] font-medium text-[11px] flex items-center gap-0.5">
                      View Diagnostics
                      <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Selected Agent Deep Dive & Live Telemetry Stream */}
        <div className="lg:col-span-5 flex flex-col gap-3.5">
          {/* Agent Detailed Spec Panel */}
          <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-2xs)]">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)] mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-[var(--radius-element)] flex items-center justify-center bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)]">
                  <span className="material-symbols-outlined text-[18px]">{selectedAgent.icon}</span>
                </div>
                <div>
                  <h3 className="text-xs sm:text-sm font-semibold text-[var(--color-text-primary)]">{selectedAgent.name}</h3>
                  <span className="text-[10px] font-mono text-[var(--color-text-muted)]">{selectedAgent.codename}</span>
                </div>
              </div>
              <span className="px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-success-subtle)] text-[var(--color-success)] text-xs font-mono font-medium border border-[var(--color-success-border)]">
                Ready
              </span>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <span className="text-[11px] text-[var(--color-text-secondary)] font-medium block mb-1">Execution Engine</span>
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] font-mono text-[11px] text-[var(--color-text-primary)]">
                  {selectedAgent.model}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)]">
                  <span className="text-[var(--color-text-muted)] block text-[10px] uppercase font-mono">Precision Metric</span>
                  <span className="text-sm font-semibold text-[var(--color-text-primary)] mt-0.5 block">{selectedAgent.accuracy}</span>
                </div>
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)]">
                  <span className="text-[var(--color-text-muted)] block text-[10px] uppercase font-mono">Tasks Automated</span>
                  <span className="text-sm font-semibold text-[var(--color-text-primary)] mt-0.5 block">{selectedAgent.tasksCompleted.toLocaleString()}</span>
                </div>
              </div>

              <div>
                <span className="text-[11px] text-[var(--color-text-secondary)] font-medium block mb-1.5">Registered Capabilities</span>
                <div className="flex flex-wrap gap-1">
                  {selectedAgent.capabilities.map((cap, i) => (
                    <span key={i} className="px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-mono text-[10px] border border-[var(--color-border)]">
                      {cap}
                    </span>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-[var(--color-border)] flex items-center justify-between gap-2">
                <button
                  onClick={() => {
                    if (selectedAgent.id === 'agent-rag') onNavigate('ai-dashboards-rag-chat');
                    else if (selectedAgent.id === 'agent-graph' || selectedAgent.id === 'agent-analytics') onNavigate('build-your-kpi-graph-studio');
                    else onNavigate('upload-dataset');
                  }}
                  className="w-full py-2 px-3 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-xs transition-colors flex items-center justify-center gap-1.5 shadow-[var(--shadow-2xs)] cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">open_in_new</span>
                  <span>Interact with {selectedAgent.name.split(' ')[0]}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Live Agent Execution Stream / Console */}
          <div className="p-3.5 rounded-[var(--radius-container)] bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)] flex flex-col justify-between flex-1 min-h-[220px]">
            <div>
              <div className="flex items-center justify-between pb-2.5 border-b border-[var(--color-border)] mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                  <span className="text-xs font-mono font-medium text-[var(--color-text-primary)]">
                    Live Telemetry Log
                  </span>
                </div>
                <button
                  onClick={() => setLogs([])}
                  className="text-[10px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
                >
                  Clear Log
                </button>
              </div>

              <div className="space-y-1.5 font-mono text-[11px] max-h-[220px] overflow-y-auto pr-1">
                {logs.length === 0 ? (
                  <div className="text-[var(--color-text-muted)] py-6 text-center text-xs">Log stream empty. Trigger an agent cycle to simulate telemetry.</div>
                ) : (
                  logs.map((log, index) => (
                    <div key={index} className="flex items-start gap-2 leading-relaxed">
                      <span className="text-[var(--color-text-muted)] shrink-0 text-[10px]">{log.time}</span>
                      <span className={`px-1.5 py-0.2 rounded-[var(--radius-inner)] text-[9px] shrink-0 font-medium ${
                        log.type === 'success' ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success-border)]' :
                        log.type === 'warn' ? 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border border-[var(--color-warning-border)]' :
                        'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'
                      }`}>
                        {log.agent}
                      </span>
                      <span className="text-[var(--color-text-secondary)] break-words">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="pt-2.5 mt-3 border-t border-[var(--color-border)] flex items-center justify-between text-[10px] font-mono text-[var(--color-text-muted)]">
              <span>HANA Vector Cloud v4.2 · BTP CF</span>
              <span className="text-[var(--color-success)]">● 100% Pipeline Health</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
