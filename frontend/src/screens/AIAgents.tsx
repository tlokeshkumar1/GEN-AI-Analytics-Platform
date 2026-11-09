import React, { useState } from 'react';

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
  const [logs, setLogs] = useState<Array<{ time: string; agent: string; message: string; type: 'info' | 'success' | 'warn' }>>([
    { time: '14:40:12', agent: 'RAG Retriever', message: 'HANA REAL_VECTOR(1536) index synchronized with active dataset partition.', type: 'success' },
    { time: '14:41:05', agent: 'Data Engineer', message: 'Auto-profiled 20,000 rows across 39 columns; 0 type conflicts identified.', type: 'info' },
    { time: '14:42:33', agent: 'Semantic Modeller', message: 'Discovered and validated 14 business metrics and 8 hierarchical dimensions.', type: 'success' },
    { time: '14:44:19', agent: 'Analytics Planner', message: 'Executed deterministic query plan for NetRevenueUSD by MonthLabel in 26ms.', type: 'info' },
    { time: '14:45:01', agent: 'Graph Synthesizer', message: 'Isolated sandbox worker standing by for high-resolution visual rendering.', type: 'info' },
  ]);

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

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Data Engineer', message: 'Scanned schema integrity: 39 columns verified against SAP S/4HANA schema standards.', type: 'success' },
        ...prev
      ]);
    }, 700);

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Semantic Modeller', message: 'Derived verified relationships: ProductKey ↔ OrderItemKey validated with zero orphan records.', type: 'success' },
        ...prev
      ]);
    }, 1400);

    setTimeout(() => {
      setLogs(prev => [
        { time: new Date().toLocaleTimeString(), agent: 'Analytics Planner', message: 'KPI cache pre-warmed for executive sales widgets (100% hits).', type: 'info' },
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
      <div className="flex flex-wrap items-center justify-between gap-3 py-1.5 px-0.5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-purple-50 border border-purple-200 text-purple-700 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[15px]">smart_toy</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">Enterprise AI Agents</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
              5 Online · SAP AI Core
            </span>
            <span className="text-xs text-slate-400 font-mono hidden sm:inline">
              · Multi-Agent Orchestration
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onNavigate('ai-dashboards-rag-chat')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 text-xs font-semibold border border-purple-200 transition-colors shadow-2xs cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">chat</span>
            <span>Open Chat</span>
          </button>
          <button
            onClick={handleRunPipelineSimulation}
            disabled={simulationRunning}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-2xs transition-all disabled:opacity-50 cursor-pointer"
          >
            <span className={`material-symbols-outlined text-[15px] text-purple-400 ${simulationRunning ? 'animate-spin' : ''}`}>
              {simulationRunning ? 'autorenew' : 'play_arrow'}
            </span>
            <span>{simulationRunning ? 'Running…' : 'Trigger Cycle'}</span>
          </button>
        </div>
      </div>

      {/* Real-time Telemetry KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="p-3 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 font-medium">Agent Pool</span>
            <div className="w-6 h-6 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">smart_toy</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-lg font-bold text-slate-900 tracking-tight">5 / 5 Active</div>
            <div className="text-xs text-emerald-600 font-medium flex items-center gap-1 mt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
              <span>100% Operational Readiness</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 font-medium">Tasks Automated</span>
            <div className="w-6 h-6 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">bolt</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-lg font-bold text-slate-900 tracking-tight">11,488</div>
            <div className="text-xs text-blue-600 font-medium flex items-center gap-1 mt-1">
              <span className="material-symbols-outlined text-[14px]">trending_up</span>
              <span>+18.4% today vs baseline</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 font-medium">Grounded Accuracy</span>
            <div className="w-6 h-6 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">verified</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-lg font-bold text-slate-900 tracking-tight">99.4%</div>
            <div className="text-xs text-slate-500 font-medium flex items-center gap-1 mt-1">
              <span>HANA Vector + Decimal validation</span>
            </div>
          </div>
        </div>

        <div className="p-3 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between hover:border-slate-300 transition-all">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-500 font-medium">Avg Pipeline Latency</span>
            <div className="w-6 h-6 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
              <span className="material-symbols-outlined text-[15px]">speed</span>
            </div>
          </div>
          <div className="mt-2">
            <div className="text-lg font-bold text-slate-900 tracking-tight">384 ms</div>
            <div className="text-xs text-emerald-600 font-medium flex items-center gap-1 mt-1">
              <span>Optimized in-memory caching</span>
            </div>
          </div>
        </div>
      </div>

      {/* Visual Pipeline Architecture Overview */}
      <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs">
        <div className="flex items-center justify-between pb-2 mb-2.5 border-b border-slate-100 gap-2">
          <div>
            <h2 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-purple-600">hub</span>
              <span>Autonomous Multi-Agent Workflow Pipeline</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Persistent stage-gate workflow coordinated by deterministic state transitions and verified contracts.
            </p>
          </div>
          <span className="text-[11px] font-mono px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 self-start sm:self-auto">
            Deterministic Stage Flow
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 relative">
          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between text-center relative group hover:bg-white hover:shadow-2xs transition-all">
            <div className="text-[10px] font-mono uppercase text-slate-400 font-semibold mb-2">Stage 01</div>
            <div className="w-7 h-7 mx-auto rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center mb-1.5">
              <span className="material-symbols-outlined text-[20px]">upload_file</span>
            </div>
            <div className="text-xs font-semibold text-slate-900">Raw File Ingestion</div>
            <div className="text-[11px] text-slate-500 mt-1">Upload CSV/XLSX</div>
            <div className="mt-1.5 text-[10px] text-emerald-600 font-medium bg-emerald-50 py-0.5 rounded border border-emerald-100">
              Verified
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between text-center relative group hover:bg-white hover:shadow-2xs transition-all">
            <div className="text-[10px] font-mono uppercase text-slate-400 font-semibold mb-2">Stage 02</div>
            <div className="w-7 h-7 mx-auto rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center mb-1.5">
              <span className="material-symbols-outlined text-[20px]">database</span>
            </div>
            <div className="text-xs font-semibold text-slate-900">Data Engineering</div>
            <div className="text-[11px] text-slate-500 mt-1">Profiling & Types</div>
            <div className="mt-1.5 text-[10px] text-emerald-600 font-medium bg-emerald-50 py-0.5 rounded border border-emerald-100">
              Contract Ready
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between text-center relative group hover:bg-white hover:shadow-2xs transition-all">
            <div className="text-[10px] font-mono uppercase text-slate-400 font-semibold mb-2">Stage 03</div>
            <div className="w-7 h-7 mx-auto rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center mb-1.5">
              <span className="material-symbols-outlined text-[20px]">account_tree</span>
            </div>
            <div className="text-xs font-semibold text-slate-900">Semantic Modelling</div>
            <div className="text-[11px] text-slate-500 mt-1">Ontology & Measures</div>
            <div className="mt-1.5 text-[10px] text-emerald-600 font-medium bg-emerald-50 py-0.5 rounded border border-emerald-100">
              Approved
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex flex-col justify-between text-center relative group hover:bg-white hover:shadow-2xs transition-all">
            <div className="text-[10px] font-mono uppercase text-slate-400 font-semibold mb-2">Stage 04</div>
            <div className="w-7 h-7 mx-auto rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center mb-1.5">
              <span className="material-symbols-outlined text-[20px]">insights</span>
            </div>
            <div className="text-xs font-semibold text-slate-900">Analytics Planning</div>
            <div className="text-[11px] text-slate-500 mt-1">Query Optimization</div>
            <div className="mt-1.5 text-[10px] text-emerald-600 font-medium bg-emerald-50 py-0.5 rounded border border-emerald-100">
              Deterministic
            </div>
          </div>

          <div className="p-2.5 rounded-lg bg-purple-50/70 border border-purple-200 flex flex-col justify-between text-center relative group hover:bg-white hover:shadow-2xs transition-all">
            <div className="text-[10px] font-mono uppercase text-purple-600 font-semibold mb-2">Stage 05</div>
            <div className="w-7 h-7 mx-auto rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center mb-1.5">
              <span className="material-symbols-outlined text-[20px]">smart_toy</span>
            </div>
            <div className="text-xs font-semibold text-purple-950">Synthesis & Output</div>
            <div className="text-[11px] text-purple-700 mt-1">RAG Chat & Studio</div>
            <div className="mt-1.5 text-[10px] text-purple-700 font-medium bg-purple-100 py-0.5 rounded border border-purple-200">
              Live Serving
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Layout: Agent Catalog on Left, Selected Agent Details & Console on Right */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left Column: Filter Tabs & Agent Cards */}
        <div className="lg:col-span-7 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
            <div className="flex items-center gap-1">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'all' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                All Agents (5)
              </button>
              <button
                onClick={() => setActiveTab('reasoning')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'reasoning' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Reasoning (2)
              </button>
              <button
                onClick={() => setActiveTab('data')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'data' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Data Pipeline (2)
              </button>
              <button
                onClick={() => setActiveTab('synthesis')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'synthesis' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                Synthesis (1)
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {filteredAgents.map(agent => {
              const isSelected = selectedAgent.id === agent.id;
              return (
                <div
                  key={agent.id}
                  onClick={() => setSelectedAgentId(agent.id)}
                  className={`p-3 rounded-xl border transition-all cursor-pointer text-left relative ${
                    isSelected
                      ? 'bg-white border-purple-400 shadow-md ring-2 ring-purple-100'
                      : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-xs'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${agent.color.bg} ${agent.color.text} border ${agent.color.border}`}>
                        <span className="material-symbols-outlined text-[17px]">{agent.icon}</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-slate-900">{agent.name}</h3>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {agent.codename}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{agent.role}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-mono ${agent.color.badge} ${agent.color.badgeText}`}>
                        {agent.status}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                    {agent.description}
                  </p>

                  <div className="mt-2.5 pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between text-xs text-slate-500 gap-2">
                    <div className="flex items-center gap-4">
                      <span>Model: <strong className="text-slate-800 font-mono text-[11px]">{agent.model}</strong></span>
                      <span>Latency: <strong className="text-slate-800 font-mono text-[11px]">{agent.latency}</strong></span>
                    </div>
                    <span className="text-purple-600 font-medium text-[11px] flex items-center gap-0.5">
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
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* Agent Detailed Spec Panel */}
          <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div className="flex items-center gap-2.5">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${selectedAgent.color.bg} ${selectedAgent.color.text}`}>
                  <span className="material-symbols-outlined text-[19px]">{selectedAgent.icon}</span>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">{selectedAgent.name}</h3>
                  <span className="text-[10px] font-mono text-slate-400">{selectedAgent.codename}</span>
                </div>
              </div>
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-mono font-medium border border-emerald-200">
                Ready
              </span>
            </div>

            <div className="space-y-3.5 text-xs">
              <div>
                <span className="text-slate-400 text-[11px] text-slate-500 font-semibold block mb-1">Execution Engine</span>
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 font-mono text-[11px] text-slate-800">
                  {selectedAgent.model}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/70">
                  <span className="text-slate-400 block text-[10px] uppercase font-mono">Precision Metric</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">{selectedAgent.accuracy}</span>
                </div>
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/70">
                  <span className="text-slate-400 block text-[10px] uppercase font-mono">Tasks Automated</span>
                  <span className="text-base font-bold text-slate-900 mt-0.5 block">{selectedAgent.tasksCompleted.toLocaleString()}</span>
                </div>
              </div>

              <div>
                <span className="text-slate-400 text-[11px] text-slate-500 font-semibold block mb-1.5">Registered Capabilities</span>
                <div className="flex flex-wrap gap-1.5">
                  {selectedAgent.capabilities.map((cap, i) => (
                    <span key={i} className="px-2 py-1 rounded-md bg-slate-100 text-slate-700 font-mono text-[10px] border border-slate-200/60">
                      {cap}
                    </span>
                  ))}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                <button
                  onClick={() => {
                    if (selectedAgent.id === 'agent-rag') onNavigate('ai-dashboards-rag-chat');
                    else if (selectedAgent.id === 'agent-graph' || selectedAgent.id === 'agent-analytics') onNavigate('build-your-kpi-graph-studio');
                    else onNavigate('upload-dataset');
                  }}
                  className="w-full py-2 px-3 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-medium text-xs transition-colors flex items-center justify-center gap-1.5 shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                  <span>Interact with {selectedAgent.name.split(' ')[0]}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Live Agent Execution Stream / Console */}
          <div className="p-3.5 rounded-xl bg-slate-950 text-slate-200 shadow-2xs border border-slate-800 flex flex-col justify-between flex-1 min-h-[220px]">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span className="text-xs font-mono font-semibold text-slate-300 font-medium">
                    Live Telemetry Log
                  </span>
                </div>
                <button
                  onClick={() => setLogs([])}
                  className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Clear Log
                </button>
              </div>

              <div className="space-y-2 font-mono text-[11px] max-h-[220px] overflow-y-auto pr-1">
                {logs.length === 0 ? (
                  <div className="text-slate-600 py-6 text-center">Log stream empty. Trigger an agent cycle to simulate telemetry.</div>
                ) : (
                  logs.map((log, index) => (
                    <div key={index} className="flex items-start gap-2 leading-relaxed">
                      <span className="text-slate-500 shrink-0 text-[10px]">{log.time}</span>
                      <span className={`px-1.5 py-0.2 rounded text-[9px] shrink-0 font-bold ${
                        log.type === 'success' ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' :
                        log.type === 'warn' ? 'bg-amber-950 text-amber-300 border border-amber-800' :
                        'bg-slate-800 text-slate-300'
                      }`}>
                        {log.agent}
                      </span>
                      <span className="text-slate-300 break-words">{log.message}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="pt-3 mt-4 border-t border-slate-900 flex items-center justify-between text-[10px] font-mono text-slate-500">
              <span>HANA Vector Cloud v4.2 · BTP CF</span>
              <span className="text-emerald-400">● 100% Pipeline Health</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
