import React from 'react';
import { Database, Cpu, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { EmbeddingStatus, HanaSyncStatus } from '../../types/dataset';

interface StatusBadgeProps {
  type: 'embedding' | 'hana';
  status?: EmbeddingStatus | HanaSyncStatus;
  chunkCount?: number;
  className?: string;
}

export const DatasetStatusBadge: React.FC<StatusBadgeProps> = ({
  type,
  status = 'Pending',
  chunkCount,
  className = '',
}) => {
  const isReady = status === 'Ready';
  const isProcessing = status === 'Indexing' || status === 'Pending';
  const isError = status === 'Error';

  let label = '';
  let title = '';

  if (type === 'embedding') {
    if (isReady) {
      label = `Embeddings: Ready${chunkCount !== undefined ? ` (${chunkCount})` : ''}`;
      title = 'Vector embeddings are up to date and active for similarity search.';
    } else if (status === 'Indexing') {
      label = 'Embeddings: Indexing...';
      title = 'Generating vector embeddings in the background.';
    } else if (status === 'Pending') {
      label = 'Embeddings: Pending';
      title = 'Vector embedding generation is queued in the background.';
    } else {
      label = 'Embeddings: Error';
      title = 'Embedding generation failed; chat falls back to current source text.';
    }
  } else {
    // hana
    if (isReady) {
      label = 'HANA: Synced';
      title = 'Vectors are synchronized to SAP HANA Cloud vector engine.';
    } else if (isProcessing) {
      label = 'HANA: Syncing...';
      title = 'Synchronizing vectors with SAP HANA Cloud.';
    } else {
      label = 'HANA: Offline';
      title = 'SAP HANA Cloud vector sync is unavailable; using local saved vectors.';
    }
  }

  const badgeColor = isReady
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : isProcessing
    ? 'bg-amber-50 text-amber-700 border-amber-200 animate-pulse'
    : 'bg-rose-50 text-rose-700 border-rose-200';

  return (
    <div
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border shadow-2xs select-none transition-all ${badgeColor} ${className}`}
      title={title}
      role="status"
    >
      {type === 'embedding' ? (
        <Cpu className="w-3.5 h-3.5 shrink-0" />
      ) : (
        <Database className="w-3.5 h-3.5 shrink-0" />
      )}
      {isProcessing && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
      {isReady && <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-600" />}
      {isError && <AlertTriangle className="w-3 h-3 shrink-0 text-rose-600" />}
      <span className="font-semibold tracking-tight">{label}</span>
    </div>
  );
};
