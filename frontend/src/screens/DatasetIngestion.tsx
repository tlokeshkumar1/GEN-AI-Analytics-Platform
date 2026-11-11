import React, { useState, useRef, useEffect, useCallback } from 'react';
import { selectContext, selectedContext } from '../services/executionContext';
import { SemanticReview } from '../components/dataset/SemanticReview';
import { DatasetGovernance } from '../components/dataset/DatasetGovernance';
import { FileImportReview } from '../components/dataset/FileImportReview';
import { AIAgentIngestionStepper, IngestionStageStatus } from '../components/AIAgentIngestionStepper';
import { getApiErrorMessage } from '../services/api';
import { DatasetSelector } from '../components/dataset/DatasetSelector';
import { DatasetActionPanel } from '../components/dataset/DatasetActionPanel';
import { DatasetViewTable } from '../components/dataset/DatasetViewTable';
import { DatasetEditView } from '../components/dataset/DatasetEditView';
import { DatasetAppendView } from '../components/dataset/DatasetAppendView';
import { DatasetDeleteDialog } from '../components/dataset/DatasetDeleteDialog';
import { DatasetItem, DatasetAction, DATASET_ACTIONS } from '../types/dataset';
import { UploadResponse, UploadStageEvent } from '../services/uploadService';
import { getDatasets, getDatasetData, getUserPermissions, rollbackDataset, activateDataset, reindexDataset, getDatasetStatus, reconcileTables } from '../services/datasetService';
import { listConnections } from '../services/systemService';

interface DatasetIngestionProps {
  onNavigate: (path: string) => void;
}

export const DatasetIngestion: React.FC<DatasetIngestionProps> = ({ onNavigate }) => {
  const [activeDataset, setActiveDataset] = useState<DatasetItem | null>(null);
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [syncingTables, setSyncingTables] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [sourceTab, setSourceTab] = useState<'all' | 'uploads' | 'connected'>('all');

  const [latestVersion, setLatestVersion] = useState<number | null>(null);
  const [activeAction, setActiveAction] = useState<DatasetAction>(DATASET_ACTIONS.VIEW);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isBusy, setIsBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [message, setMessage] = useState('Upload a dataset to get started, or select an existing dataset.');
  const [ingestionStepper, setIngestionStepper] = useState<{
    isOpen: boolean;
    isProcessing: boolean;
    filename: string;
    result: UploadResponse | null;
    partialResult: Partial<UploadResponse> | null;
    stageStatuses: Record<number, IngestionStageStatus>;
    error?: string | null;
  }>({
    isOpen: false,
    isProcessing: false,
    filename: '',
    result: null,
    partialResult: null,
    stageStatuses: {},
    error: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [restoreVersion, setRestoreVersion] = useState('');
  const [forceExpandSemantic, setForceExpandSemantic] = useState(false);
  const semanticReviewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const basePermissions = getUserPermissions();

  const handleOpenSemanticModel = () => {
    setForceExpandSemantic(true);
    setTimeout(() => {
      semanticReviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };
  const historical = latestVersion !== null && activeDataset?.currentVersion !== latestVersion;
  const permissions = {
    ...basePermissions,
    canEdit: basePermissions.canEdit && !historical,
    canAppend: basePermissions.canAppend && !historical,
    canDelete: basePermissions.canDelete && !historical,
  };

  const selectDataset = (dataset: DatasetItem) => {
    const previous = selectedContext();
    const version = dataset.currentVersion || 1;
    selectContext({
      datasetId: dataset.id,
      version,
      semanticRevision:
        previous?.datasetId === dataset.id && previous.version === version
          ? previous.semanticRevision
          : 1,
    });
    setActiveDataset(dataset);
    setLatestVersion(dataset.currentVersion || 1);
    setActiveAction(DATASET_ACTIONS.VIEW);
    setRestoreVersion('');
    const url = new URL(window.location.href);
    url.searchParams.set('datasetId', dataset.id);
    window.history.replaceState({}, '', url.toString());
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const clearDataset = () => {
    selectContext(null);
    setActiveDataset(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('datasetId');
    window.history.replaceState({}, '', url.toString());
  };

  // Initial load: Fetch datasets & connections
  useEffect(() => {
    let cancelled = false;
    setLoadingDatasets(true);
    getDatasets()
      .then(list => {
        if (cancelled) return;
        setDatasets(list);
        setLoadingDatasets(false);

        // Only auto-open if specifically requested via URL search param ?datasetId=...
        const requested = new URLSearchParams(window.location.search).get('datasetId');
        if (requested) {
          const selected = list.find(d => d.id === requested);
          if (selected) {
            setLatestVersion(selected.currentVersion || 1);
            selectDataset(selected);
          }
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(getApiErrorMessage(err, 'Failed to load datasets.'));
          setLoadingDatasets(false);
        }
      });

    listConnections()
      .then(items => {
        if (!cancelled && Array.isArray(items)) setConnections(items);
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, []);

  // Poll status when active dataset is indexing or syncing
  useEffect(() => {
    if (!activeDataset) return;
    const isProcessing =
      activeDataset.embeddingStatus === 'Indexing' ||
      activeDataset.embeddingStatus === 'Pending' ||
      activeDataset.hanaSyncStatus === 'Pending';
    if (!isProcessing) return;

    const interval = setInterval(async () => {
      try {
        const status = await getDatasetStatus(activeDataset.id, activeDataset.currentVersion);
        if (
          status.embeddingStatus !== activeDataset.embeddingStatus ||
          status.hanaSyncStatus !== activeDataset.hanaSyncStatus ||
          status.currentVersion !== activeDataset.currentVersion
        ) {
          const updated = {
            ...activeDataset,
            embeddingStatus: status.embeddingStatus,
            embeddingCount: status.embeddingCount,
            hanaSyncStatus: status.hanaSyncStatus,
          };
          if (updated) {
            setActiveDataset(prev =>
              prev?.id === updated.id && prev.currentVersion === updated.currentVersion ? updated : prev
            );
            setDatasets(prev =>
              prev.map(d => (d.id === updated.id ? { ...d, ...updated } : d))
            );
            if (updated.embeddingStatus === 'Ready' && updated.hanaSyncStatus === 'Ready') {
              setMessage(`Indexing and HANA sync complete for ${updated.name}. Full vector search is ready.`);
            } else if (updated.embeddingStatus === 'Ready') {
              setMessage(`Vector indexing complete for ${updated.name}. Full AI search is ready.`);
            } else if (updated.embeddingStatus === 'Error') {
              setMessage(`Embedding generation encountered an issue; chat is using current source text.`);
            }
          }
        }
      } catch {
        // silent polling catch
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [activeDataset]);

  const refresh = useCallback(async () => {
    setRefreshTrigger(n => n + 1);
    try {
      const list = await getDatasets();
      setDatasets(list);
      if (activeDataset) {
        const latest = list.find(d => d.id === activeDataset.id);
        setLatestVersion(latest?.currentVersion ?? null);
        if (!latest) {
          setActiveDataset(null);
        } else {
          const result = await getDatasetData(
            activeDataset.id,
            1,
            10,
            undefined,
            'asc',
            undefined,
            activeDataset.currentVersion
          );
          setActiveDataset(result.dataset);
        }
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to refresh dataset.'));
    }
  }, [activeDataset]);

  const handleSyncTables = async () => {
    setSyncingTables(true);
    setError(null);
    try {
      const res = await reconcileTables();
      setMessage(`Successfully reconciled ${res.totalDatasets} HANA tables (${res.unbundledCount} multi-sheet tables unbundled).`);
      setRefreshTrigger(n => n + 1);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Failed to reconcile HANA tables.'));
    } finally {
      setSyncingTables(false);
    }
  };

  const upload = async (file: File) => {
    if (isBusy || !basePermissions.canAppend) return;
    setPendingFile(file);
  };

  const performVersionAction = async (action: 'rollback' | 'activate' | 'reindex', versionToRestore?: number) => {
    if (!activeDataset) return;
    setIsBusy(true);
    setError(null);
    try {
      const targetVersion = versionToRestore ?? Number(restoreVersion);
      const result =
        action === 'rollback'
          ? await rollbackDataset(activeDataset.id, targetVersion)
          : action === 'activate'
            ? await activateDataset(activeDataset.id)
            : await reindexDataset(activeDataset.id);
      setMessage(result.message);
      selectDataset(result.dataset);
      setRestoreVersion('');
      setRefreshTrigger(n => n + 1);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Version operation failed.'));
    } finally {
      setIsBusy(false);
    }
  };

  // Determine pipeline active step
  const getPipelineStep = () => {
    if (!activeDataset) return 1;
    if (activeDataset.embeddingStatus === 'Ready' && activeDataset.hanaSyncStatus === 'Ready') return 4;
    if (activeDataset.embeddingStatus === 'Indexing' || activeDataset.hanaSyncStatus === 'Pending') return 3;
    return 2;
  };
  const activeStep = getPipelineStep();

  // Categorize datasets
  const uploadedDatasets = datasets.filter(
    d => d.source?.toLowerCase().includes('upload') || d.source?.toLowerCase().includes('file') || !d.source
  );
  const connectedDatasets = datasets.filter(
    d => !d.source?.toLowerCase().includes('upload') && !d.source?.toLowerCase().includes('file') && !!d.source
  );

  const filteredDatasets = datasets.filter(d => {
    if (sourceTab === 'uploads' && !uploadedDatasets.some(u => u.id === d.id)) return false;
    if (sourceTab === 'connected' && !connectedDatasets.some(c => c.id === d.id)) return false;
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      d.name.toLowerCase().includes(q) ||
      d.format.toLowerCase().includes(q) ||
      (d.source && d.source.toLowerCase().includes(q)) ||
      (d.description && d.description.toLowerCase().includes(q))
    );
  });

  return (
    <div className="flex flex-col w-full max-w-[1560px] mx-auto gap-3.5 pb-16">
      {/* Sleek, Single-Row Compact Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-1.5 px-0.5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">cloud_upload</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              {activeDataset ? activeDataset.name : 'Dataset Ingestion & Management'}
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              Data Studio
            </span>
            <span className="text-xs text-slate-400 font-mono hidden sm:inline">
              · {datasets.length} datasets
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {activeDataset && (
            <button
              type="button"
              onClick={clearDataset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 hover:border-slate-400 transition-all shadow-2xs cursor-pointer group"
            >
              <span className="material-symbols-outlined text-[16px] text-slate-500 group-hover:-translate-x-0.5 transition-transform">
                arrow_back
              </span>
              <span>Back to Upload</span>
            </button>
          )}
          <DatasetSelector
            selectedDataset={activeDataset}
            onSelectDataset={selectDataset}
            onClearSelection={clearDataset}
            refreshTrigger={refreshTrigger}
          />
        </div>
      </div>

      {/* Notifications */}
      {message && (
        <div
          role="status"
          className="rounded-2xl border border-blue-200/80 bg-blue-50/60 p-4 text-xs font-medium text-blue-900 flex items-center justify-between shadow-sm"
        >
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-blue-600 text-base">info</span>
            <span>{message}</span>
          </div>
          <button onClick={() => setMessage('')} className="text-slate-400 hover:text-slate-600 cursor-pointer">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-medium text-red-800 flex items-center justify-between shadow-sm"
        >
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-red-600 text-base">error</span>
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-700 cursor-pointer">
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* CONDITIONAL DISPLAY: Screen B (Particular Dataset View) vs Screen A (Upload) */}
      {/* ========================================================================= */}
      {activeDataset ? (
        /* SCREEN B: Dataset Detail View (Image 2) */
        <>
          {/* Back Action Bar */}
          <div className="flex items-center justify-between bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 shadow-2xs">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={clearDataset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 hover:text-blue-600 hover:border-blue-300 transition-all shadow-2xs cursor-pointer group"
              >
                <span className="material-symbols-outlined text-[17px] text-slate-500 group-hover:text-blue-600 group-hover:-translate-x-0.5 transition-transform">
                  arrow_back
                </span>
                <span>Back to Upload & Datasets</span>
              </button>
              <span className="text-slate-300">|</span>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                <span className="text-xs font-medium text-slate-500">Active Dataset:</span>
                <span className="text-xs font-bold text-slate-900 font-mono">{activeDataset.name}</span>
                <span className="px-2 py-0.5 text-[10px] font-bold rounded-md bg-blue-100 text-blue-800 uppercase font-mono">
                  .{activeDataset.format}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  ({activeDataset.rowCount.toLocaleString()} rows)
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={clearDataset}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-blue-700 hover:bg-blue-100/60 transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">upload_file</span>
              <span>Upload New File</span>
            </button>
          </div>

          {/* Visual 4-Step Pipeline Ribbon */}
          <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { step: 1, title: '1. Ingest Data', desc: 'Excel / CSV Ingestion', icon: 'cloud_upload' },
                { step: 2, title: '2. Semantic Model', desc: 'Schema Review & Rules', icon: 'account_tree' },
                { step: 3, title: '3. Vector & HANA', desc: 'Embeddings & In-Memory Sync', icon: 'hub' },
                { step: 4, title: '4. Analytics Ready', desc: 'RAG & Executive KPIs', icon: 'insights' },
              ].map(item => {
                const isCompleted = activeStep > item.step;
                const isCurrent = activeStep === item.step;
                return (
                  <div
                    key={item.step}
                    className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${isCurrent
                        ? 'bg-blue-50/70 border-blue-500 shadow-sm ring-2 ring-blue-500/20'
                        : isCompleted
                          ? 'bg-slate-50/60 border-slate-200 text-slate-700'
                          : 'bg-white border-slate-200/50 text-slate-400 opacity-60'
                      }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isCurrent
                          ? 'bg-blue-600 text-white'
                          : isCompleted
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-400'
                        }`}
                    >
                      <span className="material-symbols-outlined text-lg">
                        {isCompleted ? 'check' : item.icon}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div
                        className={`text-xs font-bold truncate ${isCurrent ? 'text-blue-900' : isCompleted ? 'text-slate-800' : 'text-slate-500'
                          }`}
                      >
                        {item.title}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">{item.desc}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {historical && (
            <div role="status" className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-center gap-2">
              <span className="material-symbols-outlined text-base text-amber-600">history</span>
              <span>
                Viewing historical snapshot <strong>V{activeDataset.currentVersion}</strong>. Switch to latest version to make edits or append rows.
              </span>
            </div>
          )}

          {/* Semantic Model Review */}
          <div ref={semanticReviewRef} className="scroll-mt-4">
            <SemanticReview dataset={activeDataset} forceExpanded={forceExpandSemantic} />
          </div>

          {/* Governance & Version History */}
          <DatasetGovernance
            key={`${activeDataset.id}-${activeDataset.currentVersion}`}
            dataset={activeDataset}
          />

          {/* Dataset Action Options Bar Placed Above Dataset (View, Edit, Append, Delete) */}
          <DatasetActionPanel
            dataset={activeDataset}
            activeAction={activeAction}
            onSelectAction={setActiveAction}
            permissions={permissions}
            isBusy={isBusy}
          />

          {/* Dataset Table / Sub-view Content Area - Full Width */}
          <div
            key={`${activeDataset.id}-${activeDataset.currentVersion}-${refreshTrigger}`}
            className="w-full min-w-0"
          >
            {activeAction === DATASET_ACTIONS.VIEW && (
              <DatasetViewTable
                dataset={activeDataset}
                onRefresh={() => void refresh()}
                onRestoreVersion={(v) => void performVersionAction('rollback', v)}
                onRefreshEmbeddings={() => void performVersionAction('reindex')}
                onOpenSemanticModel={handleOpenSemanticModel}
                canEdit={permissions.canEdit}
                isBusy={isBusy}
              />
            )}
            {activeAction === DATASET_ACTIONS.EDIT && (
              <DatasetEditView
                dataset={activeDataset}
                onSaved={updated => {
                  if (updated) {
                    selectDataset(updated);
                  }
                  void refresh();
                }}
                onToast={setMessage}
                onProceedToSemanticModel={handleOpenSemanticModel}
              />
            )}
            {activeAction === DATASET_ACTIONS.APPEND && (
              <DatasetAppendView
                dataset={activeDataset}
                onAppended={updated => {
                  if (updated) {
                    selectDataset(updated);
                  }
                  void refresh();
                }}
                onToast={setMessage}
              />
            )}
            {activeAction === DATASET_ACTIONS.DELETE && (
              <>
                <DatasetViewTable
                  dataset={activeDataset}
                  onRestoreVersion={(v) => void performVersionAction('rollback', v)}
                  onRefreshEmbeddings={() => void performVersionAction('reindex')}
                  canEdit={permissions.canEdit}
                  isBusy={isBusy}
                />
                <DatasetDeleteDialog
                  dataset={activeDataset}
                  isOpen
                  onClose={() => setActiveAction(DATASET_ACTIONS.VIEW)}
                  onDatasetDeleted={() => {
                    clearDataset();
                    setRefreshTrigger(n => n + 1);
                  }}
                  onRowsDeleted={() => void refresh()}
                  onToast={setMessage}
                />
              </>
            )}
          </div>
        </>
      ) : (
        /* SCREEN A: Upload Page with Available Data Below (Image 1 + Available Data) */
        <>
          {/* Compact, High-Density Upload Banner */}
          <div
            onDragOver={e => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files[0]) void upload(e.dataTransfer.files[0]);
            }}
            className={`rounded-xl border border-dashed px-4 py-3 bg-white transition-all shadow-2xs flex flex-wrap items-center justify-between gap-3 ${
              dragOver ? 'border-blue-500 bg-blue-50/40 ring-2 ring-blue-500/20' : 'border-slate-300 hover:border-slate-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={e => {
                if (e.target.files?.[0]) void upload(e.target.files[0]);
              }}
            />
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 border border-blue-100">
                <span className="material-symbols-outlined text-xl">upload_file</span>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-800 text-xs">
                    {basePermissions.canAppend ? 'Upload / Drag & Drop Enterprise Dataset' : 'Upload Dataset (Admin Only)'}
                  </span>
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200 uppercase">
                    .XLSX
                  </span>
                  <span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200 uppercase">
                    .CSV
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 truncate max-w-xl">
                  Drop file here or click browse · Max 100MB · Encrypted with AES-256
                </p>
              </div>
            </div>

            <button
              type="button"
              disabled={isBusy || !basePermissions.canAppend}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 active:scale-[0.98] px-3.5 py-1.5 text-xs font-semibold text-white shadow-2xs transition-all disabled:opacity-50 cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-[16px]">{basePermissions.canAppend ? 'cloud_upload' : 'lock'}</span>
              <span>{isBusy ? 'Processing...' : basePermissions.canAppend ? 'Upload File' : 'Upload Restricted'}</span>
            </button>
          </div>

          {/* Under That: Available Data & Enterprise Sources */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3.5">
            {/* Section Header with Quick Filters & Search */}
            {/* Streamlined Section Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-blue-600 text-lg">database</span>
                <h2 className="text-sm font-bold text-slate-900">Available Data & Enterprise Sources</h2>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {/* Search Bar */}
                <div className="relative w-48 sm:w-60">
                  <span className="material-symbols-outlined absolute left-2.5 top-2 text-slate-400 text-[16px] pointer-events-none">
                    search
                  </span>
                  <input
                    type="text"
                    value={searchFilter}
                    onChange={e => setSearchFilter(e.target.value)}
                    placeholder="Search data..."
                    className="w-full pl-8 pr-7 py-1 text-xs rounded-lg bg-slate-50 border border-slate-200 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-500 focus:bg-white transition-all"
                  />
                  {searchFilter && (
                    <button
                      onClick={() => setSearchFilter('')}
                      className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-600"
                    >
                      <span className="material-symbols-outlined text-[14px]">close</span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onNavigate('system-settings/connections')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-600 hover:text-blue-700 hover:bg-blue-50 border border-slate-200 transition-colors"
                >
                  <span className="material-symbols-outlined text-[15px] text-blue-600">cable</span>
                  <span className="hidden sm:inline">System Connections</span>
                </button>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  title="Refresh datasets list"
                  className="w-7 h-7 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors"
                >
                  <span className="material-symbols-outlined text-[15px]">refresh</span>
                </button>
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 p-1 bg-slate-100 rounded-xl">
                <button
                  type="button"
                  onClick={() => setSourceTab('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${sourceTab === 'all'
                      ? 'bg-white text-blue-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                    }`}
                >
                  <span className="material-symbols-outlined text-[16px]">apps</span>
                  <span>All Data</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-200 text-slate-700 font-mono">
                    {datasets.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setSourceTab('uploads')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${sourceTab === 'uploads'
                      ? 'bg-white text-blue-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                    }`}
                >
                  <span className="material-symbols-outlined text-[16px]">upload_file</span>
                  <span>Uploaded Files</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-200 text-slate-700 font-mono">
                    {uploadedDatasets.length}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setSourceTab('connected')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${sourceTab === 'connected'
                      ? 'bg-white text-blue-700 shadow-2xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                    }`}
                >
                  <span className="material-symbols-outlined text-[16px]">hub</span>
                  <span>Connected Systems</span>
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-slate-200 text-slate-700 font-mono">
                    {connectedDatasets.length + connections.length}
                  </span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSyncTables()}
                  disabled={syncingTables}
                  title="Rescan and sync all tables from SAP HANA Cloud"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[16px] text-emerald-600 ${syncingTables ? 'animate-spin' : ''}`}>
                    sync
                  </span>
                  <span>{syncingTables ? 'Syncing...' : 'Sync HANA Tables'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('system-settings/connections')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-slate-600 hover:text-blue-700 hover:bg-blue-50 border border-slate-200 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px] text-blue-600">cable</span>
                  <span>Manage System Connections</span>
                </button>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  title="Refresh datasets list"
                  className="w-8 h-8 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-500 hover:text-slate-800 transition-colors"
                >
                  <span className="material-symbols-outlined text-[17px]">refresh</span>
                </button>
              </div>
            </div>

            {/* Loading State */}
            {loadingDatasets && (
              <div className="py-12 text-center space-y-3">
                <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-slate-500">Loading available enterprise data sources...</p>
              </div>
            )}

            {/* Datasets Grid */}
            {!loadingDatasets && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredDatasets.map(ds => {
                  const isExcel = ds.format === 'xlsx' || ds.format === 'xls';
                  const isExternal =
                    ds.source?.toLowerCase().includes('connection') ||
                    ds.source?.toLowerCase().includes('external') ||
                    ds.source?.toLowerCase().includes('hana');

                  return (
                    <div
                      key={ds.id}
                      onClick={() => selectDataset(ds)}
                      className="group bg-white border border-slate-200 hover:border-blue-400 hover:shadow-sm rounded-xl p-3.5 transition-all flex flex-col justify-between cursor-pointer relative overflow-hidden"
                    >
                      {/* Top Accent Strip */}
                      <div
                        className={`absolute top-0 left-0 right-0 h-1 ${isExternal ? 'bg-purple-500' : isExcel ? 'bg-emerald-500' : 'bg-blue-500'
                          }`}
                      />

                      <div>
                        {/* Header Row: Icon, Badges */}
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${isExternal
                                ? 'bg-purple-50 border-purple-200 text-purple-600'
                                : isExcel
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                                  : 'bg-blue-50 border-blue-200 text-blue-600'
                              }`}
                          >
                            <span className="material-symbols-outlined text-2xl">
                              {isExternal ? 'hub' : isExcel ? 'table_chart' : 'description'}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 justify-end">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${isExternal
                                  ? 'bg-purple-50 text-purple-700 border-purple-200'
                                  : 'bg-blue-50 text-blue-700 border-blue-200'
                                }`}
                            >
                              <span className="material-symbols-outlined text-[12px]">
                                {isExternal ? 'cable' : 'cloud_upload'}
                              </span>
                              <span>{isExternal ? 'Connected System' : 'File Upload'}</span>
                            </span>
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200 uppercase font-mono">
                              .{ds.format}
                            </span>
                          </div>
                        </div>

                        {/* Title & Info */}
                        <h3
                          title={ds.tableName || ds.displayName || ds.name}
                          className="font-bold text-slate-900 text-sm group-hover:text-blue-600 transition-colors truncate"
                        >
                          {ds.tableName || ds.displayName || ds.name.replace(/\.[^/.]+$/, '')}
                        </h3>
                        <div className="flex flex-col gap-0.5 mt-0.5">
                          <p className="text-[11px] text-slate-500 truncate" title={ds.sourceFile || ds.sourceFilename || ds.currentFilename || ds.name}>
                            <span className="font-semibold text-slate-600">Source:</span> {ds.sourceFile || ds.sourceFilename || ds.currentFilename || ds.name}
                            {ds.sheetName ? <span className="ml-1 px-1.5 py-0.2 bg-blue-50 text-blue-700 rounded text-[10px] font-semibold border border-blue-200">Sheet: {ds.sheetName}</span> : null}
                          </p>
                          <p className="text-[10px] text-slate-400">
                            Version {ds.currentVersion || 1} · Ingested{' '}
                            {new Date(ds.lastUpdated).toLocaleDateString()}
                          </p>
                        </div>

                        {/* Metrics Grid */}
                        <div className="grid grid-cols-2 gap-2 mt-2.5 p-2 rounded-lg bg-slate-50 border border-slate-100">
                          <div>
                            <span className="text-[10px] uppercase font-semibold text-slate-500 tracking-wider">
                              Records
                            </span>
                            <p className="text-xs font-bold text-slate-800 font-mono mt-0.5">
                              {(ds.rowCount || 0).toLocaleString()} rows
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] uppercase font-semibold text-slate-500 tracking-wider">
                              Schema
                            </span>
                            <p className="text-xs font-bold text-slate-800 font-mono mt-0.5">
                              {ds.columnCount || ds.columns?.length || 0} columns
                            </p>
                          </div>
                        </div>

                        {/* Status Badges */}
                        <div className="flex flex-wrap items-center gap-2 mt-3 text-[11px]">
                          {ds.embeddingStatus === 'Ready' ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium text-[10px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              <span>Vector Ready ({ds.embeddingCount || ds.rowCount || 0})</span>
                            </span>
                          ) : ds.embeddingStatus === 'Indexing' ? (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-medium text-[10px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-spin" />
                              <span>Indexing Vector...</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200 text-[10px]">
                              <span>Pending Index</span>
                            </span>
                          )}

                          {ds.hanaSyncStatus === 'Ready' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium text-[10px]">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              <span>HANA Synced</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Card Footer Action */}
                      <div className="mt-2.5 pt-2 border-t border-slate-100 flex items-center justify-between">
                        <span className="text-[11px] text-slate-500 font-medium">Click to inspect data</span>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            selectDataset(ds);
                          }}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-600 hover:text-white transition-all group-hover:bg-blue-600 group-hover:text-white cursor-pointer"
                        >
                          <span>Open Dataset</span>
                          <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Connected System Configuration Cards (when in All or Connected tab) */}
                {(sourceTab === 'connected' || sourceTab === 'all') &&
                  connections.map(conn => (
                    <div
                      key={conn.id || conn.name}
                      onClick={() => onNavigate('system-settings/connections')}
                      className="group bg-gradient-to-br from-purple-50/40 to-indigo-50/20 border border-purple-200 hover:border-purple-400 hover:shadow-sm rounded-xl p-3.5 transition-all flex flex-col justify-between cursor-pointer relative overflow-hidden"
                    >
                      <div className="absolute top-0 left-0 right-0 h-1 bg-purple-600" />
                      <div>
                        <div className="flex items-start justify-between gap-3 mb-3">
                          <div className="w-8 h-8 rounded-lg bg-purple-100 border border-purple-200 text-purple-700 flex items-center justify-center shrink-0">
                            <span className="material-symbols-outlined text-2xl">cable</span>
                          </div>
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-purple-100 text-purple-800 border border-purple-300 font-mono">
                            {conn.provider || 'SYSTEM'}
                          </span>
                        </div>

                        <h3 className="font-bold text-slate-900 text-sm group-hover:text-purple-700 transition-colors truncate">
                          {conn.name || 'Enterprise System Connection'}
                        </h3>
                        <p className="text-[11px] text-slate-600 mt-0.5">
                          Protocol: {conn.protocol || 'HTTPS'} · Auth: {conn.auth_type || 'OAuth2 / SSO'}
                        </p>

                        <div className="mt-4 p-2.5 rounded-xl bg-white/80 border border-purple-100 text-xs text-slate-700 space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">Integration:</span>
                            <span className="font-semibold text-purple-900">{conn.service?.toUpperCase() || 'LIVE FEED'}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">Live Status:</span>
                            <span className="font-semibold text-emerald-700 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              {conn.enabled ? 'Active Synced' : 'Configured'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="mt-2.5 pt-2 border-t border-purple-100 flex items-center justify-between">
                        <span className="text-[11px] text-purple-700 font-medium">System connection</span>
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            onNavigate('system-settings/connections');
                          }}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-700 hover:text-white transition-all cursor-pointer"
                        >
                          <span>Manage Connection</span>
                          <span className="material-symbols-outlined text-[15px]">arrow_forward</span>
                        </button>
                      </div>
                    </div>
                  ))}

                {/* Empty State when no datasets match */}
                {filteredDatasets.length === 0 && connections.length === 0 && (
                  <div className="col-span-full py-12 px-4 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50 space-y-3">
                    <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200 flex items-center justify-center mx-auto text-slate-400">
                      <span className="material-symbols-outlined text-2xl">layers</span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-800">
                      {searchFilter ? `No datasets found matching "${searchFilter}"` : 'No datasets available yet'}
                    </h3>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto">
                      {searchFilter
                        ? 'Try clearing the search query or switching between Uploaded Files and Connected Systems.'
                        : 'Upload an Excel or CSV file in the upload zone above, or configure an external system connection.'}
                    </p>
                    {searchFilter && (
                      <button
                        type="button"
                        onClick={() => setSearchFilter('')}
                        className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                      >
                        Clear search
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* AI Autonomous 3-Agent Ingestion Cockpit & Chart Recommender */}
      <AIAgentIngestionStepper
        isOpen={ingestionStepper.isOpen}
        isProcessing={ingestionStepper.isProcessing}
        filename={ingestionStepper.filename}
        result={ingestionStepper.result}
        partialResult={ingestionStepper.partialResult}
        stageStatuses={ingestionStepper.stageStatuses}
        error={ingestionStepper.error}
        onClose={() => setIngestionStepper(prev => ({ ...prev, isOpen: false }))}
        onNavigateToDashboard={() => onNavigate('dashboard')}
      />

      {/* File Import Review Dialog */}
      {pendingFile && (
        <FileImportReview
          file={pendingFile}
          onCancel={() => setPendingFile(null)}
          onCommitStart={(filename) => {
            setIngestionStepper({
              isOpen: true,
              isProcessing: true,
              filename,
              result: null,
              partialResult: null,
              stageStatuses: { 1: 'running', 2: 'queued', 3: 'queued', 4: 'queued' },
              error: null,
            });
          }}
          onCommitProgress={(event: UploadStageEvent) => {
            setIngestionStepper(prev => {
              const nextStatuses: Record<number, IngestionStageStatus> = { ...prev.stageStatuses };
              if (event.status === 'running') {
                for (let s = 1; s < event.stage; s += 1) {
                  if (nextStatuses[s] !== 'completed') nextStatuses[s] = 'completed';
                }
                nextStatuses[event.stage] = 'running';
                for (let s = event.stage + 1; s <= 4; s += 1) {
                  nextStatuses[s] = 'queued';
                }
              } else {
                nextStatuses[event.stage] = event.status;
              }
              return {
                ...prev,
                stageStatuses: nextStatuses,
                partialResult: event.data
                  ? { ...(prev.partialResult || {}), ...event.data }
                  : prev.partialResult,
              };
            });
          }}
          onCommitError={(err) => {
            setIngestionStepper(prev => ({
              ...prev,
              isProcessing: false,
              error: err,
            }));
          }}
          onSaved={(result: UploadResponse) => {
            setPendingFile(null);
            setMessage(result.message || `Dataset ${result.filename} imported successfully.`);
            if (result.dataset) {
              setDatasets(prev => [result.dataset!, ...prev.filter(d => d.id !== result.dataset!.id)]);
              selectDataset(result.dataset);
            } else {
              void refresh();
            }
            setRefreshTrigger(n => n + 1);
            setIngestionStepper({
              isOpen: true,
              isProcessing: false,
              filename: result.filename,
              result: result,
              partialResult: result,
              stageStatuses: { 1: 'completed', 2: 'completed', 3: 'completed', 4: 'completed' },
              error: null,
            });
          }}
        />
      )}
    </div>
  );
};
