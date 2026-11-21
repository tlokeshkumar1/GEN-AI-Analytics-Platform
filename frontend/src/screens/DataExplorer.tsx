import React, { useEffect, useState, useRef } from 'react';
import { selectedContext, ensureDefaultContext } from '../services/executionContext';
import { AnalyticsDefinition, ExecutionResult, SemanticModel, executePlan, getSemanticModels } from '../services/semanticService';
import { queryAnalytics } from '../services/analyticsService';
import { getApiErrorMessage } from '../services/api';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { DataExplorerSkeleton, DataExplorerResultsSkeleton } from '../components/dashboard/DataExplorerSkeleton';

// Chip-based multi-select component
function ChipSelector({ options, selected, onChange, label }: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (values: string[]) => void;
  label: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(search.toLowerCase()) && !selected.includes(o.value)
  );

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">{label}</label>
      <div
        className={`min-h-[34px] border rounded-[var(--radius-element)] px-2 py-1 bg-[var(--color-surface)] cursor-text flex flex-wrap gap-1 items-center transition-all shadow-[var(--shadow-2xs)] ${
          open ? 'border-[var(--color-primary)] ring-1 ring-[var(--color-primary)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)]'
        }`}
        onClick={() => { setOpen(true); }}
      >
        {selected.map(val => {
          const opt = options.find(o => o.value === val);
          return (
            <span key={val} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] text-xs font-medium border border-[var(--color-border)]">
              {opt?.label ?? val}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onChange(selected.filter(s => s !== val)); }}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors ml-0.5 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[12px]">close</span>
              </button>
            </span>
          );
        })}
        <input
          className="flex-1 min-w-[80px] text-xs outline-none border-none bg-transparent py-0.5 px-1 placeholder:text-[var(--color-text-muted)] text-[var(--color-text-primary)]"
          placeholder={selected.length ? 'Add more…' : 'Search and select fields…'}
          value={search}
          onChange={e => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-lg)] max-h-52 overflow-auto">
          {filtered.map(opt => (
            <button
              key={opt.value}
              type="button"
              className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--color-surface-hover)] transition-colors flex items-center gap-2 text-[var(--color-text-primary)] cursor-pointer"
              onClick={() => { onChange([...selected, opt.value]); setSearch(''); }}
            >
              <span className="material-symbols-outlined text-[16px] text-[var(--color-text-muted)]">add_circle_outline</span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Dynamic quick suggestion builder from active semantic model
function buildDynamicSuggestions(model: SemanticModel | null): string[] {
  if (!model || !model.fields.length) {
    return [
      'Show record count summary',
      'Top 5 items by primary measure',
      'Monthly trend overview',
      'Compare distributions across categories',
    ];
  }
  const measures = model.fields.filter(f => f.role === 'measure');
  const dims = model.fields.filter(f => f.role === 'dimension');
  const timeFields = model.fields.filter(f => f.role === 'time');
  const m1 = measures[0]?.semantic_name || measures[0]?.name || 'Records';
  const m2 = measures[1]?.semantic_name || measures[1]?.name || m1;
  const d1 = dims[0]?.semantic_name || dims[0]?.name;
  const d2 = dims[1]?.semantic_name || dims[1]?.name || d1;
  const t1 = timeFields[0]?.semantic_name || timeFields[0]?.name;

  const out: string[] = [];
  if (d1) out.push(`Total ${m1} by ${d1}`);
  if (d2) out.push(`Top 5 ${d2} by ${m1}`);
  if (t1) out.push(`${m1} trend by ${t1}`);
  if (d1) out.push(`Average ${m2} by ${d1}`);
  return out.length ? out : ['Show total record count', 'Summarize all numeric measures'];
}

export const DataExplorer: React.FC<{ onNavigate: (path: string) => void }> = ({ onNavigate }) => {
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState('*');
  const [aggregation, setAggregation] = useState('COUNT');
  const [dimensions, setDimensions] = useState<string[]>([]);
  const [filters, setFilters] = useState('[]');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [executedPlan, setExecutedPlan] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'structured' | 'natural'>('structured');

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setLoading(true);
      setError('');
      try {
        let context = selectedContext();
        if (!context) {
          context = await ensureDefaultContext();
        }
        if (!context) {
          if (!cancelled) setError('Select a dataset and version first.');
          return;
        }
        const models = await getSemanticModels(context.datasetId, context.version);
        if (cancelled) return;
        const approved = models.find(m => m.revision === context!.semanticRevision && m.status === 'approved') || models.find(m => m.status === 'approved') || models[0];
        if (!approved) {
          setModel(null);
        } else {
          setModel(approved);
        }
      } catch (err) {
        if (!cancelled) setError(getApiErrorMessage(err, 'Semantic model could not be loaded.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void init();

    const handleContextChanged = () => {
      void init();
    };
    window.addEventListener('dataset-context-changed', handleContextChanged);

    return () => {
      cancelled = true;
      window.removeEventListener('dataset-context-changed', handleContextChanged);
    };
  }, []);

  const run = async (natural: boolean) => {
    setBusy(true); setError(''); setResult(null);
    try {
      if (natural) {
        const response = await queryAnalytics(prompt);
        const plan = (response as any).query_plan || {};
        setExecutedPlan(plan);
        if ((response as any).status === 'invalid_query') throw new Error(response.summary_insights);
        setResult({ success: true, status: (response as any).status, data: response.results, summary: {}, records_matched: (response as any).records_matched ?? 0,
          records_total: response.records_scanned || 0, execution_time_ms: (response as any).execution_time_ms, context: {}, execution_backend: (response as any).execution_backend });
      } else {
        const plan = { metric, aggregation, dimensions, filters: JSON.parse(filters) };
        setExecutedPlan(plan); setResult(await executePlan(plan));
      }
    } catch (err) { setError(getApiErrorMessage(err, 'Query failed.')); }
    finally { setBusy(false); }
  };

  const definition: AnalyticsDefinition = { id: 'explorer', title: 'Query results', kind: 'table', revision: 1, semantic_revision: model?.revision || 1, query_plan: executedPlan, dependencies: [], explanation: '', status: 'proposed' };
  const dimensionOptions = model?.fields.filter(f => f.role !== 'measure').map(f => ({ value: f.name, label: f.semantic_name })) ?? [];

  // When initial data is loading, render skeleton matching the layout and design
  if (loading) {
    return <DataExplorerSkeleton mode={mode} />;
  }

  return (
    <div className="space-y-3.5 w-full max-w-[1560px] mx-auto pb-16 animate-fade-in">
      {/* Sleek Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">explore</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">Data Explorer</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              Query Engine
            </span>
            {model && (
              <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
                · Model Rev {model.revision} ({model.fields.length} fields)
              </span>
            )}
          </div>
        </div>

        {/* Mode Selector in Header */}
        <div className="flex items-center gap-1 p-1 bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] border border-[var(--color-border)]">
          <button
            onClick={() => setMode('structured')}
            className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-all cursor-pointer ${
              mode === 'structured'
                ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">tune</span>
              Structured Query
            </span>
          </button>
          <button
            onClick={() => setMode('natural')}
            className={`px-3 py-1 rounded-[var(--radius-inner)] text-xs font-medium transition-all cursor-pointer ${
              mode === 'natural'
                ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[15px] text-[var(--color-text-secondary)]">auto_awesome</span>
              Natural Language (AI)
            </span>
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] rounded-[var(--radius-container)] p-4 shadow-[var(--shadow-2xs)]">
          <span className="material-symbols-outlined text-[var(--color-danger)] text-xl mt-0.5">error</span>
          <p className="text-xs font-medium text-[var(--color-danger)] flex-1">{error}</p>
          <button onClick={() => setError('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      {!model && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-page)] p-10 text-center space-y-4 shadow-[var(--shadow-xs)]">
          <div className="w-12 h-12 mx-auto rounded-[var(--radius-container)] bg-[var(--color-surface-active)] border border-[var(--color-border)] flex items-center justify-center">
            <span className="material-symbols-outlined text-[var(--color-warning)] text-2xl">schema</span>
          </div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">No semantic model available</p>
          <button className="inline-flex items-center gap-2 border border-[var(--color-border)] rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer" onClick={() => onNavigate('upload-dataset')}>
            <span className="material-symbols-outlined text-[16px]">open_in_new</span>
            Open semantic review
          </button>
        </div>
      )}

      {model && (
        <>
          {/* Structured Query Panel */}
          {mode === 'structured' && (
            <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 space-y-3.5 shadow-[var(--shadow-2xs)]">
              <div className="grid sm:grid-cols-3 gap-4 text-xs">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Metric</label>
                  <select
                    className="w-full border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:border-[var(--color-primary)] outline-none transition-all shadow-[var(--shadow-2xs)]"
                    value={metric}
                    onChange={e => { setMetric(e.target.value); setAggregation('COUNT'); }}
                  >
                    <option value="*">Source rows</option>
                    {model.fields.map(f => <option key={f.name} value={f.name}>{f.semantic_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Aggregation</label>
                  <select
                    className="w-full border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-text-primary)] text-xs focus:border-[var(--color-primary)] outline-none transition-all shadow-[var(--shadow-2xs)]"
                    value={aggregation}
                    onChange={e => setAggregation(e.target.value)}
                  >
                    {(metric === '*' ? ['COUNT'] : model.fields.find(f => f.name === metric)?.aggregations || []).map(a =>
                      <option key={a}>{a}</option>
                    )}
                  </select>
                </div>
                <ChipSelector
                  label="Group by"
                  options={dimensionOptions}
                  selected={dimensions}
                  onChange={setDimensions}
                />
              </div>
              <details className="rounded-[var(--radius-element)] border border-[var(--color-border)] overflow-hidden text-xs">
                <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-primary)] px-3 py-2 bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] transition-colors flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-text-muted)]">filter_alt</span>
                  Typed filters
                </summary>
                <div className="p-4 space-y-2">
                  <p className="text-xs text-[var(--color-text-secondary)]">Example: <code className="px-1.5 py-0.5 bg-[var(--color-surface-hover)] rounded text-[11px] border border-[var(--color-border)]">[{`{"column":"Department","operator":"=","value":"IT"}`}]</code></p>
                  <textarea
                    aria-label="Typed query filters"
                    className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3 w-full font-mono text-xs resize-y bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:border-[var(--color-primary)] outline-none transition-all"
                    rows={3}
                    value={filters}
                    onChange={e => setFilters(e.target.value)}
                  />
                </div>
              </details>
              <button
                disabled={busy}
                onClick={() => void run(false)}
                className="inline-flex items-center gap-1.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium shadow-[var(--shadow-2xs)] transition-all disabled:opacity-50 cursor-pointer"
              >
                <span className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}>
                  {busy ? 'sync' : 'play_arrow'}
                </span>
                <span>{busy ? 'Running…' : 'Execute query'}</span>
              </button>
            </section>
          )}

          {/* Natural Language Panel */}
          {mode === 'natural' && (
            <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 space-y-3 shadow-[var(--shadow-2xs)]">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-[var(--color-primary)] text-xl">auto_awesome</span>
                <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Ask in natural language</h2>
              </div>

              {/* Suggestion Chips */}
              <div className="flex flex-wrap gap-2">
                {buildDynamicSuggestions(model).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setPrompt(s)}
                    className="text-xs px-3 py-1 rounded-[var(--radius-full)] border border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-border-strong)] transition-all cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
              </div>

              <div className="relative">
                <textarea
                  aria-label="Analytics question"
                  className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3 pr-12 w-full text-xs resize-y bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:border-[var(--color-primary)] outline-none transition-all shadow-[var(--shadow-2xs)]"
                  placeholder="Describe the metric, aggregation, and filters…"
                  rows={3}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim()) void run(true); }}
                />
                <div className="absolute bottom-3 right-3 text-[10px] text-[var(--color-text-muted)] font-mono">
                  ⌘ Enter
                </div>
              </div>
              <button
                disabled={busy || !prompt.trim()}
                onClick={() => void run(true)}
                className="inline-flex items-center gap-1.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium shadow-[var(--shadow-2xs)] transition-all disabled:opacity-50 cursor-pointer"
              >
                <span className={`material-symbols-outlined text-[16px] ${busy ? 'animate-spin' : ''}`}>
                  {busy ? 'sync' : 'psychology'}
                </span>
                <span>{busy ? 'Planning…' : 'Plan and execute'}</span>
              </button>
            </section>
          )}
        </>
      )}

      {/* Results Section */}
      {busy ? (
        <DataExplorerResultsSkeleton />
      ) : result ? (
        <section className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 space-y-3 shadow-[var(--shadow-2xs)] animate-fade-in">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
              <span className="material-symbols-outlined text-[var(--color-primary)] text-lg">table_chart</span>
              Query results
            </h2>
          </div>
          <AnalyticsWidget definition={definition} result={result} showTable={true} />
          <details className="rounded-[var(--radius-element)] border border-[var(--color-border)] overflow-hidden text-xs">
            <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-primary)] px-3 py-2 bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface-active)] transition-colors flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px] text-[var(--color-text-muted)]">code</span>
              Executed query plan
            </summary>
            <pre className="text-xs bg-[var(--color-surface-hover)] p-3 overflow-auto font-mono text-[var(--color-text-primary)] border-t border-[var(--color-border)]">{JSON.stringify(executedPlan, null, 2)}</pre>
          </details>
        </section>
      ) : (
        <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] rounded-[var(--radius-container)] p-8 text-center text-[var(--color-text-secondary)] shadow-[var(--shadow-2xs)] animate-fade-in">
          <div className="w-10 h-10 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)] flex items-center justify-center mx-auto mb-2">
            <span className="material-symbols-outlined text-2xl">insights</span>
          </div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">Analytical Output Canvas</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Select dimensions or enter a natural language prompt above to compute results over the verified schema.
          </p>
        </div>
      )}
    </div>
  );
};
