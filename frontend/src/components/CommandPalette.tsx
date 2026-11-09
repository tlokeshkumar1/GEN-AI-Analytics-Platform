import React, { useState, useEffect } from 'react';
import { SCHEMA_COLUMNS } from '../data/schemaData';

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) {
          onClose();
        } else {
          // Open handled by parent or toggle
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
    { id: 'executive-dashboard', title: 'Executive Sales & Analytics Dashboard', category: 'Navigation', icon: 'dashboard', hint: 'Live metrics, regional breakdown, SKU leaderboard' },
    { id: 'ai-dashboards-rag-chat', title: 'Conversational Analytics & RAG Chat', category: 'Navigation', icon: 'chat', hint: 'Vector-grounded AI assistant' },
    { id: 'build-your-kpi-graph-studio', title: 'Build Your KPI', category: 'Navigation', icon: 'query_stats', hint: 'KPI builder & custom charts' },
    { id: 'ai-agents', title: 'Autonomous AI Agents Hub', category: 'Navigation', icon: 'smart_toy', hint: 'Multi-agent orchestration, autonomous workflows & reasoning telemetry' },
    { id: 'upload-dataset', title: 'Dataset Management & Ingestion', category: 'Navigation', icon: 'upload_file', hint: 'Upload Excel/CSV to HANA Vector store' },
    { id: 'hanaadmin', title: 'HANA Cloud Database Admin & Tables (/hanaadmin)', category: 'Administration', icon: 'database', hint: 'Auto-detect future tables, inspect schema, explore records' },
    { id: 'data-explorer', title: 'Data Explorer & Text-to-SQL Analytics', category: 'Navigation', icon: 'terminal', hint: 'SQL generator across 39 columns' },
    { id: 'alerts-notifications', title: 'Alerts & Margin Thresholds', category: 'Navigation', icon: 'notifications', hint: 'Breach alerts & trigger logs' },
    { id: 'reports-library', title: 'Reports Library & Audit Exports', category: 'Navigation', icon: 'folder', hint: 'PDF/Excel board decks' },
    { id: 'data-sources', title: 'Data Sources & BTP Connectors', category: 'Navigation', icon: 'cloud_sync', hint: 'SAP S/4HANA & HDI containers' },
    { id: 'user-management', title: 'User Management & Roles', category: 'Navigation', icon: 'group', hint: 'Tier-1 RBAC access controls' },
    { id: 'system-settings', title: 'System Management', category: 'Navigation', icon: 'settings', hint: 'Embedding models and cache parameters' },
    { id: 'enterprise-signin', title: 'Log Out / Switch Enterprise Tenant', category: 'Authentication', icon: 'logout', hint: 'End active session and return to Enterprise Sign In' },
  ];

  const quickPrompts = [
    'Show monthly Net Revenue and Gross Margin comparison across 2024 and 2025',
    'Compare gross profit margin across top 4 product categories for 2024',
    'Compare NetRevenueUSD and GrossMarginUSD across Categories',
    'Top 10 products ranked by total gross margin USD in descending order',
  ];

  const filteredNav = navigationCommands.filter(c =>
    c.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.hint.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const filteredColumns = SCHEMA_COLUMNS.filter(col =>
    col.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    col.description.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 5);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 sm:pt-20 px-2 sm:px-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="fixed inset-0"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl border border-[#CBD5E1] overflow-hidden flex flex-col z-10 max-h-[85vh] sm:max-h-[75vh]">
        {/* Search Input Bar */}
        <div className="flex items-center px-3 sm:px-4 py-3 border-b border-[#E2E8F0] gap-2.5">
          <span className="material-symbols-outlined text-[#64748B] text-[20px]">search</span>
          <input
            autoFocus
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search screens, prompts, or schema..."
            className="w-full bg-transparent text-[#0F172A] placeholder:text-[#64748B] font-body-md text-body-md focus:outline-none"
          />
          <div className="flex items-center gap-1.5">
            <kbd className="hidden sm:inline-block px-2 py-0.5 text-[10px] font-mono bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0] rounded">ESC</kbd>
            <button
              onClick={onClose}
              className="sm:hidden w-8 h-8 rounded-lg flex items-center justify-center text-[#64748B] hover:bg-[#F1F5F9]"
              aria-label="Close search"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>

        {/* Results List */}
        <div className="overflow-y-auto p-2 divide-y divide-[#F1F5F9]">
          {/* Navigation Section */}
          <div className="py-2">
            <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[#64748B] tracking-wider">
              Screens & Workspaces
            </div>
            {filteredNav.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onNavigate(item.id);
                  onClose();
                }}
                className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#F1F5F9] text-left transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <span className="material-symbols-outlined text-[#64748B] group-hover:text-[#2563EB] text-[18px] transition-colors">
                    {item.icon}
                  </span>
                  <div className="flex flex-col">
                    <span className="font-label-md text-label-md font-medium text-[#0F172A]">
                      {item.title}
                    </span>
                    <span className="font-body-sm text-[11px] text-[#64748B]">
                      {item.hint}
                    </span>
                  </div>
                </div>
                <span className="material-symbols-outlined text-[14px] text-[#64748B] opacity-0 group-hover:opacity-100 transition-opacity">
                  arrow_forward
                </span>
              </button>
            ))}
          </div>

          {/* Quick Prompts Section */}
          <div className="py-2">
            <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[#64748B] tracking-wider">
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
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-[#F5F3FF] text-left transition-colors group"
              >
                <div className="flex items-center gap-2.5 truncate">
                  <span className="material-symbols-outlined text-[#7C3AED] text-[16px]">bolt</span>
                  <span className="font-body-sm text-[12px] text-[#0F172A] truncate">
                    {prompt}
                  </span>
                </div>
                <span className="font-label-sm text-[10px] text-[#7C3AED] font-medium shrink-0">Open Graph</span>
              </button>
            ))}
          </div>

          {/* Schema Columns Preview */}
          {filteredColumns.length > 0 && (
            <div className="py-2">
              <div className="px-3 pb-1 text-[10px] uppercase font-semibold text-[#64748B] tracking-wider">
                HANA Schema Columns ({SCHEMA_COLUMNS.length} Available)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 px-1">
                {filteredColumns.map((col, idx) => (
                  <div
                    key={idx}
                    className="p-2 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-between"
                  >
                    <div>
                      <div className="font-label-sm font-semibold text-[#0F172A]">{col.name}</div>
                      <div className="text-[10px] text-[#64748B]">{col.dataType}</div>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 bg-[#EFF6FF] text-[#1D4ED8] border border-[#BFDBFE] rounded font-mono">
                      {col.type}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-[#F8FAFC] border-t border-[#E2E8F0] flex items-center justify-between text-[11px] text-[#64748B]">
          <div className="flex items-center gap-2">
            <span>Use <kbd className="px-1 bg-white border border-[#CBD5E1] rounded shadow-2xs">↑</kbd> <kbd className="px-1 bg-white border border-[#CBD5E1] rounded shadow-2xs">↓</kbd> to navigate</span>
            <span>·</span>
            <span><kbd className="px-1 bg-white border border-[#CBD5E1] rounded shadow-2xs">↵</kbd> to select</span>
          </div>
          <span className="font-medium text-[#475569]">SAP HANA In-Memory Column Store</span>
        </div>
      </div>
    </div>
  );
};
