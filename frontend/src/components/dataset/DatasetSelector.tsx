import React, { useState, useEffect, useRef } from 'react';
import {
  Database,
  ChevronDown,
  Search,
  RefreshCw,
  X,
  Check,
  FileSpreadsheet,
  AlertCircle,
  Layers,
} from 'lucide-react';
import { DatasetItem } from '../../types/dataset';
import { getDatasets } from '../../services/datasetService';

interface DatasetSelectorProps {
  selectedDataset: DatasetItem | null;
  onSelectDataset: (dataset: DatasetItem) => void;
  onClearSelection: () => void;
  className?: string;
  refreshTrigger?: number;
}

export const DatasetSelector: React.FC<DatasetSelectorProps> = ({
  selectedDataset,
  onSelectDataset,
  onClearSelection,
  className = '',
  refreshTrigger = 0,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);

  const fetchDatasetList = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await getDatasets();
      setDatasets(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load datasets');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDatasetList();
  }, [refreshTrigger]);

  // Handle outside clicks to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
      setFocusedIndex(-1);
    }
  }, [isOpen]);

  const filteredDatasets = datasets.filter((ds) => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return true;
    return (
      ds.name.toLowerCase().includes(query) ||
      ds.format.toLowerCase().includes(query) ||
      ds.source.toLowerCase().includes(query) ||
      (ds.description && ds.description.toLowerCase().includes(query))
    );
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setSearchQuery('');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((prev) => (prev < filteredDatasets.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((prev) => (prev > 0 ? prev - 1 : filteredDatasets.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedIndex >= 0 && focusedIndex < filteredDatasets.length) {
        onSelectDataset(filteredDatasets[focusedIndex]);
        setIsOpen(false);
        setSearchQuery('');
      }
    }
  };

  return (
    <div ref={dropdownRef} className={`relative inline-block text-left ${className}`} onKeyDown={handleKeyDown}>
      {/* Dropdown Trigger Button */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className={`h-9 px-3 rounded-[var(--radius-element)] border transition-all duration-150 flex items-center gap-2.5 shadow-[var(--shadow-xs)] text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
            selectedDataset
              ? 'bg-[var(--color-primary-soft)] border-[var(--color-primary-muted)] text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]'
              : 'bg-[var(--color-background-surface)] border-[var(--color-border)] text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)]'
          }`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label="Dataset selector"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="p-1 rounded-[var(--radius-inner)] bg-[var(--color-background-surface)] border border-[var(--color-border)] text-[var(--color-primary)] shrink-0">
              <Database className="w-3.5 h-3.5" />
            </span>
            <div className="flex flex-col min-w-0 pr-1">
              <span className="text-xs font-medium truncate max-w-[170px] sm:max-w-[220px]">
                {selectedDataset ? selectedDataset.name : 'Select dataset'}
              </span>
              {selectedDataset && (
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono leading-none truncate">
                  {selectedDataset.rowCount.toLocaleString()} rows · {selectedDataset.format.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <ChevronDown
            className={`w-3.5 h-3.5 text-[var(--color-text-muted)] transition-transform duration-150 shrink-0 ${
              isOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {/* Clear Selection Pill Button */}
        {selectedDataset && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClearSelection();
            }}
            className="h-9 px-2 rounded-[var(--radius-element)] bg-[var(--color-background-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)] transition-colors shadow-[var(--shadow-xs)] flex items-center justify-center cursor-pointer"
            title="Clear selection"
            aria-label="Clear dataset selection"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Dropdown Menu Popup */}
      {isOpen && (
        <div className="absolute right-0 mt-1.5 w-80 sm:w-96 rounded-[var(--radius-container)] bg-[var(--color-background-surface)] border border-[var(--color-border)] shadow-[var(--shadow-xl)] z-50 overflow-hidden animate-in fade-in duration-150">
          {/* Search Header */}
          <div className="p-2 border-b border-[var(--color-border)] bg-[var(--color-background-subtle)]">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--color-text-muted)] absolute left-2.5 top-2.5 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search datasets by name or format…"
                className="w-full pl-8 pr-3 py-1.5 text-xs rounded-[var(--radius-element)] bg-[var(--color-background-surface)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-placeholder)] focus:outline-none focus:border-[var(--color-primary)] transition-all font-sans"
              />
            </div>
          </div>

          {/* Options Body */}
          <div className="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
            {/* Loading State */}
            {isLoading && (
              <div className="py-8 px-4 flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] text-xs">
                <RefreshCw className="w-4 h-4 animate-spin text-[var(--color-primary)]" />
                <span>Loading available datasets…</span>
              </div>
            )}

            {/* Error State */}
            {!isLoading && error && (
              <div className="p-4 text-center space-y-2">
                <div className="flex items-center justify-center gap-1.5 text-[var(--color-error)] text-xs font-medium">
                  <AlertCircle className="w-4 h-4" />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={fetchDatasetList}
                  className="px-3 py-1 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] text-[var(--color-error)] text-xs font-medium transition-colors cursor-pointer"
                >
                  Retry loading
                </button>
              </div>
            )}

            {/* Empty State */}
            {!isLoading && !error && filteredDatasets.length === 0 && (
              <div className="py-8 px-4 text-center space-y-2 text-[var(--color-text-muted)]">
                <div className="w-9 h-9 rounded-full bg-[var(--color-background-subtle)] flex items-center justify-center mx-auto text-[var(--color-text-muted)]">
                  <Layers className="w-4 h-4" />
                </div>
                <div className="text-xs font-medium text-[var(--color-text-primary)]">
                  {searchQuery ? 'No matching datasets found' : 'No datasets yet'}
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)] max-w-[200px] mx-auto">
                  {searchQuery ? 'Try adjusting your search query' : 'Upload one to get started'}
                </p>
              </div>
            )}

            {/* Dataset Options List */}
            {!isLoading && !error && (
              <ul ref={listboxRef} role="listbox" aria-label="Available datasets" className="space-y-0.5">
                {filteredDatasets.map((ds, index) => {
                  const isSelected = selectedDataset?.id === ds.id;
                  const isFocused = focusedIndex === index;

                  return (
                    <li
                      key={ds.id}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        onSelectDataset(ds);
                        setIsOpen(false);
                        setSearchQuery('');
                      }}
                      className={`p-2 rounded-[var(--radius-element)] cursor-pointer transition-all flex items-start justify-between gap-2.5 ${
                        isSelected
                          ? 'bg-[var(--color-primary-soft)] border border-[var(--color-primary-muted)]'
                          : isFocused
                          ? 'bg-[var(--color-background-subtle)]'
                          : 'hover:bg-[var(--color-background-subtle)]'
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <div
                          className={`w-6 h-6 rounded-[var(--radius-inner)] flex items-center justify-center shrink-0 mt-0.5 ${
                            ds.format === 'xlsx'
                              ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border border-[var(--color-success-muted)]'
                              : ds.format === 'csv'
                              ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]'
                              : 'bg-[var(--color-ai-soft)] text-[var(--color-ai)] border border-[var(--color-ai-muted)]'
                          }`}
                        >
                          <FileSpreadsheet className="w-3.5 h-3.5" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-medium text-xs text-[var(--color-text-primary)] truncate" title={ds.name}>
                              {ds.name}
                            </span>
                            <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded-[var(--radius-inner)] bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] font-medium">
                              {ds.format}
                            </span>
                          </div>
                          <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 mt-0.5">
                            <span className="font-mono">{ds.rowCount.toLocaleString()} rows</span>
                            <span>·</span>
                            <span>{ds.lastUpdated}</span>
                          </div>
                        </div>
                      </div>

                      {isSelected && (
                        <div className="w-4 h-4 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center shrink-0 mt-1">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer Action: Clear Selection */}
          {selectedDataset && (
            <div className="p-2 border-t border-[var(--color-border)] bg-[var(--color-background-subtle)] flex items-center justify-between">
              <span className="text-[11px] text-[var(--color-text-muted)] font-medium">
                Active: <strong className="text-[var(--color-text-primary)]">{selectedDataset.name}</strong>
              </span>
              <button
                type="button"
                onClick={() => {
                  onClearSelection();
                  setIsOpen(false);
                  setSearchQuery('');
                }}
                className="text-xs font-medium text-[var(--color-error)] hover:underline flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>Clear selection</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
