import React from 'react';
import { Database, Cpu, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { DatasetItem, EmbeddingStatus, HanaSyncStatus } from '../../types/dataset';

interface StatusBadgeProps {
  type: 'embedding' | 'hana';
  status?: EmbeddingStatus | HanaSyncStatus;
  chunkCount?: number;
  className?: string;
  embeddingStatus?: EmbeddingStatus;
  errorMessage?: string | null;
}

export const DatasetStatusBadge: React.FC<StatusBadgeProps> = ({
  type,
  status = 'Pending',
  chunkCount,
  className = '',
  embeddingStatus,
  errorMessage,
}) => {
  const isBlocked = type === 'hana' && (status === 'Blocked' || (status === 'Pending' && embeddingStatus === 'Error'));
  const isReady = status === 'Ready';
  const isProcessing = !isBlocked && (status === 'Indexing' || status === 'Pending');
  const isError = status === 'Error';

  let label = '';
  let title = '';

  if (type === 'embedding') {
    if (isReady) {
      label = `Embeddings: Ready${chunkCount !== undefined ? ` (${chunkCount})` : ''}`;
      title = 'Vector embeddings are up to date and active for similarity search.';
    } else if (status === 'Indexing') {
      label = 'Embeddings: Indexing…';
      title = 'Generating vector embeddings in the background.';
    } else if (status === 'Pending') {
      label = 'Embeddings: Pending';
      title = 'Vector embedding generation is queued in the background.';
    } else {
      label = 'Embeddings: Error';
      title = errorMessage || 'Embedding generation failed; chat falls back to current source text.';
    }
  } else {
    // hana
    if (isReady) {
      label = 'HANA: Synced';
      title = 'Vectors are synchronized to SAP HANA Cloud vector engine.';
    } else if (isBlocked) {
      label = 'HANA: Waiting for embeddings';
      title = 'Vector synchronization is blocked until embedding generation succeeds. The uploaded table data remains saved.';
    } else if (isProcessing) {
      label = 'HANA: Syncing…';
      title = 'Synchronizing vectors with SAP HANA Cloud.';
    } else {
      label = 'HANA: Offline';
      title = 'SAP HANA Cloud vector sync is unavailable; using local saved vectors.';
    }
  }

  const badgeColor = isReady
    ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-muted)]'
    : isBlocked
    ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-muted)]'
    : isProcessing
    ? 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-muted)] animate-pulse'
    : 'bg-[var(--color-error-soft)] text-[var(--color-error)] border-[var(--color-error-muted)]';

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium border shadow-[var(--shadow-xs)] select-none transition-all ${badgeColor} ${className}`}
      title={title}
      role="status"
    >
      {type === 'embedding' ? (
        <Cpu className="w-3 h-3 shrink-0" />
      ) : (
        <Database className="w-3 h-3 shrink-0" />
      )}
      {isProcessing && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
      {isReady && <CheckCircle2 className="w-3 h-3 shrink-0 text-[var(--color-success)]" />}
      {isError && <AlertTriangle className="w-3 h-3 shrink-0 text-[var(--color-error)]" />}
      <span className="font-medium tracking-tight">{label}</span>
    </div>
  );
};

export function DatasetIndexStatus({ dataset }: { dataset: DatasetItem }) {
  return <div className="flex min-w-0 flex-col items-start gap-2">
    <div className="flex items-center gap-2 flex-wrap">
      <DatasetStatusBadge type="embedding" status={dataset.embeddingStatus} chunkCount={dataset.embeddingCount} errorMessage={dataset.embeddingError} />
      <DatasetStatusBadge type="hana" status={dataset.hanaSyncStatus} embeddingStatus={dataset.embeddingStatus} />
    </div>
    {dataset.embeddingStatus === 'Error' && <p role="alert" className="max-w-3xl break-words text-xs text-[var(--color-error)]">
      {dataset.embeddingError || 'Embedding generation failed. Your file data is saved; retry embeddings to resume.'}
      {!!dataset.embeddingCount && <> {dataset.embeddingCount} of {dataset.embeddingTotal || dataset.rowCount} vectors retained for retry.</>}
    </p>}
  </div>;
}
