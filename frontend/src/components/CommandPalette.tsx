import React, { useState, useEffect } from 'react';
import { getSemanticModels, SemanticField } from '../services/semanticService';
import { selectedContext } from '../services/executionContext';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onSelectQuery?: (query: string) => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onNavigate,
  onSelectQuery,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [fields, setFields] = useState<SemanticField[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    const ctx = selectedContext();
    if (!ctx) return;
    getSemanticModels(ctx.datasetId, ctx.version)
      .then((models) => {
        const active =
          models.find((m) => m.revision === ctx.semanticRevision) ||
          models.find((m) => m.status === 'approved') ||
          models[0];
        if (active?.fields) setFields(active.fields);
      })
      .catch(() => { });
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) {
          onClose();
        }
      }
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const navigationCommands = [
    { id: 'executive-dashboard', title: 'Executive Analytics Dashboard', category: 'Navigation', icon: 'dashboard', hint: 'Live KPIs, trends, and published visualizations' },
    { id: 'ai-dashboards-rag-chat', title: 'Conversational Analytics & RAG Chat', category: 'Navigation', icon: 'chat', hint: 'Vector-grounded AI assistant' },
    { id: 'build-your-kpi-graph-studio', title: 'Build Your KPI', category: 'Navigation', icon: 'query_stats', hint: 'KPI builder & custom charts' },
    { id: 'ai-agents', title: 'Autonomous AI Agents Hub', category: 'Navigation', icon: 'smart_toy', hint: 'Multi-agent orchestration, autonomous workflows & reasoning telemetry' },
    { id: 'upload-dataset', title: 'Dataset Management & Ingestion', category: 'Navigation', icon: 'upload_file', hint: 'Upload Excel/CSV to HANA Vector store' },
    { id: 'hanaadmin', title: 'HANA Cloud Database Admin & Tables (/hanaadmin)', category: 'Administration', icon: 'database', hint: 'Auto-detect tables, inspect schema, explore records' },
    { id: 'data-explorer', title: 'Data Explorer & Query Analytics', category: 'Navigation', icon: 'terminal', hint: 'Structured & NL query builder for active dataset' },
    { id: 'alerts-notifications', title: 'Alerts & Thresholds', category: 'Navigation', icon: 'notifications', hint: 'Threshold alerts & trigger logs' },
    { id: 'reports-library', title: 'Reports Library & Audit Exports', category: 'Navigation', icon: 'folder', hint: 'Board decks & analytical exports' },
    { id: 'data-sources', title: 'Data Sources & BTP Connectors', category: 'Navigation', icon: 'cloud_sync', hint: 'SAP S/4HANA, OData, REST, S3 & HDI containers' },
    { id: 'user-management', title: 'User Management & Roles', category: 'Navigation', icon: 'group', hint: 'RBAC access controls' },
    { id: 'system-settings', title: 'System Management', category: 'Navigation', icon: 'settings', hint: 'Connections, sync jobs, AI & storage configuration' },
    { id: 'enterprise-signin', title: 'Log Out / Switch Enterprise Tenant', category: 'Authentication', icon: 'logout', hint: 'End active session and return to Enterprise Sign In' },
  ];

  const measures = fields.filter((f) => f.role === 'measure');
  const dims = fields.filter((f) => f.role === 'dimension');
  const timeFields = fields.filter((f) => f.role === 'time');
  const m1 = measures[0]?.name || 'primary metric';
  const d1 = dims[0]?.name || 'category';
  const t1 = timeFields[0]?.name || 'period';

  const quickPrompts = fields.length
    ? [
      `Show ${m1} trend across ${t1}`,
      `Compare ${m1} across top ${d1} values`,
      `Top 10 ${d1} ranked by ${m1} in descending order`,
      `Distribution breakdown of ${m1} by ${d1}`,
    ]
    : [
      'Show distribution across primary categories',
      'Compare top 10 records by primary metric',
      'Show trend over time',
      'Summarize key metrics in the active dataset',
    ];

  const filteredNav = navigationCommands.filter(c =>
    c.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.hint.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredColumns = fields.filter(col =>
    col.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (col.semantic_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    (col.description || '').toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 6);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 sm:pt-20 px-2 sm:px-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl bg-[var(--color-background-surface)] rounded-[var(--radius-container)] shadow-[var(--shadow-xl)] border border-[var(--color-border)] overflow-hidden flex flex-col z-10 max-h-[85vh] sm:max-h-[75vh]">
        {/* Search Input Bar */}
        <div className="flex items-center px-3.5 sm:px-4 py-3 border-b border-[var(--color-border)] gap-2.5">
          <span className="material-symbols-outlined text-[var(--color-text-muted)] text-[20px]">search</span>
          <input
            autoFocus
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search screens, prompts, or schema…"
            className="w-full bg-transparent text-[var(--color-text-primary)] placeholder:text-[var(--color-text-placeholder)] font-body-md focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-[var(--color-background-subtle)] text-[var(--color-text-muted)] border border-[var(--color-border)] rounded-[var(--radius-inner)]">ESC</kbd>
            <button
              onClick={onClose}
              className="sm:hidden w-8 h-8 rounded-[var(--radius-element)] flex items-center justify-center text-[var(--color-text-muted)] hover:bg-[var(--color-background-subtle)]"
              aria-label="Close search"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 divide-y divide-[var(--color-border)]">
          {/* Navigation Section */}
          <div className="py-1.5">
            <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[var(--color-text-muted)] tracking-wider">
              Screens & Workspaces
            </div>
            {filteredNav.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] text-left transition-colors group cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] text-[18px] transition-colors">
                    {item.icon}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-label-md font-medium text-[var(--color-text-primary)]">
                      {item.title}
                    </span>
                    <span className="font-body-sm text-[11px] text-[var(--color-text-muted)]">
                      {item.hint}
                    </span>
                  </div>
                </div>
                <span className="material-symbols-outlined text-[14px] text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
                  arrow_forward
                </span>
              </button>
            ))}
          </div>

          {/* Quick Prompts Section */}
          <div className="py-1.5">
            <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[var(--color-text-muted)] tracking-wider">
              Analytical Prompts
            </div>
            {quickPrompts.map((prompt, idx) => (
              <button
                key={idx}
                onClick={() => {
                  if (onSelectQuery) {
                    onSelectQuery(prompt);
                  }
                  onNavigate('build-your-kpi-graph-studio');
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-[var(--radius-element)] hover:bg-[var(--color-ai-soft)] text-left transition-colors group cursor-pointer"
              >
                <div className="flex items-center gap-2.5 truncate">
                  <span className="material-symbols-outlined text-[var(--color-ai)] text-[16px]">bolt</span>
                  <span className="font-body-sm text-[12px] text-[var(--color-text-primary)] truncate">
                    {prompt}
                  </span>
                </div>
                <span className="font-label-sm text-[10px] text-[var(--color-ai)] font-medium shrink-0">Open Graph</span>
              </button>
            ))}
          </div>

          {/* Schema Columns Preview */}
          {filteredColumns.length > 0 && (
            <div className="py-1.5">
              <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[var(--color-text-muted)] tracking-wider">
                Active Semantic Fields ({fields.length} Available)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 px-1 pt-1">
                {filteredColumns.map((col, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] flex items-center justify-between"
                  >
                    <div>
                      <div className="font-label-sm font-semibold text-[var(--color-text-primary)]">{col.semantic_name || col.name}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)]">{col.type}</div>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 bg-[var(--color-primary-soft)] text-[var(--color-primary)] border border-[var(--color-primary-muted)] rounded-[var(--radius-inner)] font-mono">
                      {col.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-[var(--color-background-subtle)] border-t border-[var(--color-border)] flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
          <div className="flex items-center gap-2">
            <span>Use <kbd className="px-1 bg-[var(--color-background-surface)] border border-[var(--color-border)] rounded-[var(--radius-inner)] shadow-[var(--shadow-xs)]">↑</kbd> <kbd className="px-1 bg-[var(--color-background-surface)] border border-[var(--color-border)] rounded-[var(--radius-inner)] shadow-[var(--shadow-xs)]">↓</kbd> to navigate</span>
            <span>·</span>
            <span><kbd className="px-1 bg-[var(--color-background-surface)] border border-[var(--color-border)] rounded-[var(--radius-inner)] shadow-[var(--shadow-xs)]">↵</kbd> to select</span>
          </div>
          <span className="font-medium text-[var(--color-text-secondary)]">SAP HANA In-Memory Column Store</span>
        </div>
      </div>
    </div>
  );
};
