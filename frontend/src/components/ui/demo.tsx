import React, { useState, useRef } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Loader2, 
  Check, 
  Search, 
  FileText, 
  BrainCircuit,
  AlertTriangle,
  Code,
  TerminalSquare
} from 'lucide-react';

export type PlanStepStatus = 'pending' | 'active' | 'success' | 'error';

export interface PlanStep {
  id: string;
  title: string;
  content?: React.ReactNode;
  status: PlanStepStatus;
  statusBadge?: React.ReactNode;
  icon?: React.ReactNode;
  duration?: string;
  defaultExpanded?: boolean;
}

export interface AgentPlanningProps {
  title?: string;
  steps?: PlanStep[];
  hideOuterCard?: boolean;
}

const DEFAULT_STEPS: PlanStep[] = [
  {
    id: '1',
    title: 'Analyze request and extract constraints',
    status: 'success',
    duration: '0.4s',
    icon: <Search className="w-3.5 h-3.5" />,
    content: (
      <div className="space-y-2 text-[12px] text-slate-700 mt-2">
        <div className="flex items-center gap-2 text-emerald-800 font-semibold">
          <Check className="w-3.5 h-3.5 shrink-0 text-emerald-600 font-bold" />
          <span>Parsed user intent: Build minimalist UI Component</span>
        </div>
        <div className="grid grid-cols-[80px_1fr] gap-1.5 mt-2 bg-slate-50 p-2.5 rounded-lg border border-slate-200 text-slate-800 text-[11px] font-mono">
          <span className="text-slate-500 font-medium">Language:</span>
          <span className="text-slate-900 font-bold">TypeScript, React</span>
          
          <span className="text-slate-500 font-medium">Styling:</span>
          <span className="text-slate-900 font-bold">Tailwind CSS (Clean White & Slate)</span>
          
          <span className="text-slate-500 font-medium">Telemetry:</span>
          <span className="text-emerald-700 font-bold">Green Process, Red Error</span>
        </div>
      </div>
    )
  },
  {
    id: '2',
    title: 'Search UI knowledge base',
    status: 'success',
    duration: '1.2s',
    icon: <FileText className="w-3.5 h-3.5" />,
    content: (
      <div className="space-y-2 text-[12px] mt-2">
        <div className="flex items-center gap-2">
          <span className="text-slate-500 text-[11px]">Executing tool:</span>
          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-900 border border-slate-300 font-mono text-[11px] font-semibold flex items-center gap-1">
            <TerminalSquare className="w-3 h-3 text-slate-600" />
            vector_search
          </span>
        </div>
        <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-800 text-[11px]">
          <div className="text-emerald-800 mb-1.5 font-bold flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-emerald-600 font-bold" />
            <span>Success: Retrieved 3 semantic patterns</span>
          </div>
          <ul className="space-y-1 list-disc list-inside text-slate-700">
            <li>High-contrast enterprise card styling</li>
            <li>Zero-latency micro-interactions</li>
            <li>State-driven smooth expandable accordions</li>
          </ul>
        </div>
      </div>
    )
  },
  {
    id: '3',
    title: 'Synthesize component logic',
    status: 'active',
    duration: '...',
    icon: <BrainCircuit className="w-3.5 h-3.5" />,
    defaultExpanded: true,
    content: (
      <div className="space-y-2.5 text-[12px] mt-2">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 p-3.5 font-mono text-[11px] text-slate-800 space-y-2.5 shadow-xs">
          <div className="flex items-center gap-2 text-emerald-800 font-bold">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-600 shrink-0" />
            <span>Processing: Generating structured timeline layout...</span>
          </div>
          <div className="space-y-1 text-slate-600 pl-6 leading-relaxed">
            <div><span className="text-slate-400">const</span> <span className="text-emerald-700 font-bold">timelineLayout</span> = <span className="text-slate-700">useMemo</span>(...)</div>
            <div>• Standardizing linear vertical timeline</div>
            <div>• Aligning distinct icon columns</div>
            <div className="text-emerald-700 font-semibold flex items-center gap-1.5">
              <ChevronRight className="w-3.5 h-3.5 text-emerald-600" />
              <span>Streaming agent telemetry panels...</span>
            </div>
          </div>
          <div className="w-full bg-emerald-100 h-1.5 rounded-full overflow-hidden mt-2">
            <div className="bg-emerald-500 h-full w-2/3 rounded-full animate-pulse" />
          </div>
        </div>
      </div>
    )
  },
  {
    id: '4',
    title: 'Review dependency conflicts',
    status: 'error',
    duration: '0.8s',
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
    content: (
      <div className="space-y-2 text-[12px] mt-2">
        <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-900 text-[11px]">
          <div className="text-red-700 font-bold mb-1 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
            Warning: Conflict flagged
          </div>
          <div className="text-red-700 leading-relaxed">
            Layout conflict detected. Sub-agent is resolving dependencies to strict enterprise standards.
          </div>
        </div>
      </div>
    )
  },
  {
    id: '5',
    title: 'Execute final rendering',
    status: 'pending',
    icon: <Code className="w-3.5 h-3.5" />,
  }
];

export const AgentPlanning: React.FC<AgentPlanningProps> = ({
  title = "Agent is planning",
  steps = DEFAULT_STEPS,
  hideOuterCard = false,
}) => {
  const [isMainExpanded, setIsMainExpanded] = useState(true);
  
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>(
    steps.reduce((acc, step) => {
      acc[step.id] = step.defaultExpanded !== undefined ? step.defaultExpanded : true;
      return acc;
    }, {} as Record<string, boolean>)
  );

  React.useEffect(() => {
    const activeStep = steps.find(s => s.status === 'active');
    if (activeStep) {
      setExpandedSteps(prev => ({ ...prev, [activeStep.id]: true }));
    }
  }, [steps]);

  const mainContentRef = useRef<HTMLDivElement>(null);

  const toggleStep = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedSteps(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const hasActive = steps.some(s => s.status === 'active');
  const allSuccess = steps.every(s => s.status === 'success');

  const getStatusColor = (status: PlanStepStatus) => {
    switch (status) {
      case 'success':
        return 'bg-emerald-50 text-emerald-600 border border-emerald-300 ring-2 ring-emerald-100 shadow-xs';
      case 'active':
        return 'bg-emerald-50 text-emerald-600 border border-emerald-400 ring-4 ring-emerald-100 animate-pulse shadow-xs';
      case 'error':
        return 'bg-red-50 text-red-600 border border-red-300 ring-2 ring-red-100 shadow-xs';
      case 'pending':
        return 'bg-slate-100 text-slate-400 border border-slate-200';
    }
  };

  const content = (
    <div ref={mainContentRef} className="flex flex-col">
      {steps.map((step, index) => {
        const isStepExpanded = expandedSteps[step.id];
        const isLast = index === steps.length - 1;
        
        return (
          <div 
            key={step.id} 
            className={`relative flex gap-3.5 transition-all
              ${step.status === 'pending' ? 'opacity-40' : 'opacity-100'}
            `}
          >
            {/* Timeline connecting line */}
            {!isLast && (
              <div className="absolute left-[11px] top-6 bottom-[-6px] w-[1.5px] bg-slate-200 z-0" />
            )}

            {/* Icon Column */}
            <div className="relative z-10 flex-none w-6 h-6 mt-0.5">
              <div className={`flex items-center justify-center w-full h-full rounded-full transition-colors duration-200
                ${getStatusColor(step.status)}
              `}>
                {step.status === 'success' ? (
                  <Check className="w-3.5 h-3.5 font-bold text-emerald-600" />
                ) : step.status === 'active' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />
                ) : step.status === 'error' ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-red-600" />
                ) : (
                  step.icon || <div className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                )}
              </div>
            </div>

            {/* Content Column */}
            <div className="flex-1 pb-5">
              {/* Step Header */}
              <div 
                className={`flex items-center justify-between group rounded-md -mx-2 px-2 py-1 transition-colors
                  ${step.content ? 'cursor-pointer hover:bg-slate-100/60' : ''}
                `}
                onClick={(e) => step.content && toggleStep(step.id, e)}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-[13px] tracking-tight transition-colors duration-150
                    ${step.status === 'active' ? 'text-slate-900 font-bold' : 
                      step.status === 'error' ? 'text-red-700 font-bold' : 
                      step.status === 'success' ? 'text-slate-900 font-semibold' :
                      'text-slate-500 font-normal'}
                  `}>
                    {step.title}
                  </span>
                </div>

                <div className="flex items-center gap-2.5">
                  {step.statusBadge ? (
                    step.statusBadge
                  ) : step.status === 'active' ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase tracking-wider flex items-center gap-1">
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-emerald-600" />
                      Running
                    </span>
                  ) : step.status === 'error' ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-red-50 text-red-700 border border-red-200 uppercase tracking-wider">
                      Error
                    </span>
                  ) : step.status === 'pending' ? (
                    <span className="text-[11px] text-slate-400 font-mono">Queued</span>
                  ) : null}
                  {step.duration && (
                    <span className="text-[11px] font-mono text-slate-500 font-medium tabular-nums">
                      {step.duration}
                    </span>
                  )}
                  {step.content && (
                    <div className="text-slate-400 group-hover:text-slate-700 transition-colors">
                      {isStepExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    </div>
                  )}
                </div>
              </div>

              {/* Step Expanded Content */}
              {step.content && (
                <div 
                  className={`grid transition-all duration-200 ease-in-out ${
                    isStepExpanded ? 'grid-rows-[1fr] mt-1 opacity-100' : 'grid-rows-[0fr] mt-0 opacity-0'
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="pt-1 pb-0.5">
                      {step.content}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (hideOuterCard) {
    return (
      <div className="w-full font-sans text-slate-900">
        {content}
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto my-2 font-sans text-slate-900">
      <div className="bg-white border border-slate-200 shadow-xs rounded-xl overflow-hidden transition-all duration-200">
        <div 
          onClick={() => setIsMainExpanded(!isMainExpanded)}
          className={`flex items-center justify-between px-4 py-3 cursor-pointer select-none transition-colors
            ${isMainExpanded ? 'bg-slate-50 border-b border-slate-200' : 'hover:bg-slate-50/80'}
          `}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-5 h-5">
              {hasActive ? (
                <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />
              ) : allSuccess ? (
                <Check className="w-4 h-4 text-emerald-600 font-bold" />
              ) : (
                <BrainCircuit className="w-4 h-4 text-slate-400" />
              )}
            </div>
            
            <span className="text-[13px] font-bold text-slate-900 tracking-tight">
              {title}
            </span>
          </div>

          <div className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-slate-200 text-slate-400 hover:text-slate-800 transition-colors">
            {isMainExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
          </div>
        </div>

        <div 
          className={`grid transition-all duration-200 ease-in-out bg-white ${
            isMainExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden p-4 sm:p-5">
            {content}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentPlanning;
