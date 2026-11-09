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
          className={`h-10 px-3.5 sm:px-4 rounded-xl border transition-all duration-150 flex items-center gap-2.5 shadow-xs text-left cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#2563EB]/30 ${
            selectedDataset
              ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E3A8A] hover:bg-[#DBEAFE]'
              : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F8FAFC]'
          }`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-label="Dataset selector"
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="p-1 rounded-lg bg-white/80 border border-slate-200 text-[#2563EB] shrink-0">
              <Database className="w-4 h-4" />
            </span>
            <div className="flex flex-col min-w-0 pr-1">
              <span className="text-xs font-semibold truncate max-w-[170px] sm:max-w-[220px]">
                {selectedDataset ? selectedDataset.name : 'Select dataset'}
              </span>
              {selectedDataset && (
                <span className="text-[10px] text-[#475569] font-mono leading-none truncate">
                  {selectedDataset.rowCount.toLocaleString()} rows · {selectedDataset.format.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <ChevronDown
            className={`w-4 h-4 text-slate-500 transition-transform duration-200 shrink-0 ${
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
            className="h-10 px-2.5 rounded-xl bg-white border border-[#CBD5E1] text-[#64748B] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors shadow-xs flex items-center justify-center cursor-pointer"
            title="Clear selection (Return to default upload view)"
            aria-label="Clear dataset selection"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Dropdown Menu Popup */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-white border border-[#CBD5E1] shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
          {/* Search Header */}
          <div className="p-2.5 border-b border-[#E2E8F0] bg-[#F8FAFC]">
            <div className="relative">
              <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-2.5 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search datasets by name or format..."
                className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl bg-white border border-[#CBD5E1] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 transition-all font-sans"
              />
            </div>
          </div>

          {/* Options Body */}
          <div className="max-h-80 overflow-y-auto p-1.5 space-y-1">
            {/* Loading State */}
            {isLoading && (
              <div className="py-8 px-4 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
                <RefreshCw className="w-5 h-5 animate-spin text-[#2563EB]" />
                <span>Loading available datasets...</span>
              </div>
            )}

            {/* Error State */}
            {!isLoading && error && (
              <div className="p-4 text-center space-y-2">
                <div className="flex items-center justify-center gap-1.5 text-rose-600 text-xs font-semibold">
                  <AlertCircle className="w-4 h-4" />
                  <span>{error}</span>
                </div>
                <button
                  type="button"
                  onClick={fetchDatasetList}
                  className="px-3 py-1 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 text-xs font-medium transition-colors"
                >
                  Retry loading
                </button>
              </div>
            )}

            {/* Empty State */}
            {!isLoading && !error && filteredDatasets.length === 0 && (
              <div className="py-8 px-4 text-center space-y-2 text-slate-500">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
                  <Layers className="w-5 h-5" />
                </div>
                <div className="text-xs font-medium text-slate-700">
                  {searchQuery ? 'No matching datasets found' : 'No datasets yet'}
                </div>
                <p className="text-[11px] text-slate-500 max-w-[200px] mx-auto">
                  {searchQuery ? 'Try adjusting your search query' : 'Upload one to get started'}
                </p>
              </div>
            )}

            {/* Dataset Options List */}
            {!isLoading && !error && (
              <ul ref={listboxRef} role="listbox" aria-label="Available datasets" className="space-y-1">
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
                      className={`p-2.5 rounded-xl cursor-pointer transition-all flex items-start justify-between gap-2.5 ${
                        isSelected
                          ? 'bg-[#EFF6FF] border border-[#BFDBFE]'
                          : isFocused
                          ? 'bg-[#F1F5F9]'
                          : 'hover:bg-[#F8FAFC]'
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            ds.format === 'xlsx'
                              ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                              : ds.format === 'csv'
                              ? 'bg-blue-50 text-blue-600 border border-blue-200'
                              : 'bg-purple-50 text-purple-600 border border-purple-200'
                          }`}
                        >
                          <FileSpreadsheet className="w-4 h-4" />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-xs text-[#0F172A] truncate" title={ds.name}>
                              {ds.name}
                            </span>
                            <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-medium">
                              {ds.format}
                            </span>
                          </div>
                          <div className="text-[11px] text-[#64748B] flex items-center gap-2 mt-0.5">
                            <span className="font-mono">{ds.rowCount.toLocaleString()} rows</span>
                            <span>·</span>
                            <span>{ds.lastUpdated}</span>
                          </div>
                          {ds.source && (
                            <span className="text-[10px] text-[#94A3B8] truncate mt-0.5">
                              {ds.source}
                            </span>
                          )}
                        </div>
                      </div>

                      {isSelected && (
                        <div className="w-5 h-5 rounded-full bg-[#2563EB] text-white flex items-center justify-center shrink-0 mt-1 shadow-2xs">
                          <Check className="w-3 h-3 stroke-[3]" />
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
            <div className="p-2 border-t border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
              <span className="text-[11px] text-[#64748B] font-medium">
                Active: <strong className="text-[#0F172A]">{selectedDataset.name}</strong>
              </span>
              <button
                type="button"
                onClick={() => {
                  onClearSelection();
                  setIsOpen(false);
                  setSearchQuery('');
                }}
                className="text-xs font-semibold text-rose-600 hover:text-rose-700 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear selection</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
