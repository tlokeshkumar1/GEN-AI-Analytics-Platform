import React from 'react';
import {
  Eye,
  Edit3,
  PlusCircle,
  Trash2,
  Lock,
} from 'lucide-react';
import { DatasetItem, DatasetAction, DATASET_ACTIONS } from '../../types/dataset';

interface DatasetActionPanelProps {
  dataset: DatasetItem;
  activeAction: DatasetAction;
  onSelectAction: (action: DatasetAction) => void;
  permissions: {
    canView: boolean;
    canEdit: boolean;
    canAppend: boolean;
    canDelete: boolean;
  };
  isBusy?: boolean;
  className?: string;
}

export const ACTION_CONFIGS = [
  {
    id: DATASET_ACTIONS.VIEW,
    label: 'View',
    description: 'Browse, filter & sort dataset',
    icon: Eye,
    requiresPermission: 'canView' as const,
  },
  {
    id: DATASET_ACTIONS.EDIT,
    label: 'Edit',
    description: 'Inline & row-level modifications',
    icon: Edit3,
    requiresPermission: 'canEdit' as const,
  },
  {
    id: DATASET_ACTIONS.APPEND,
    label: 'Append',
    description: 'Add records via file or manual entry',
    icon: PlusCircle,
    requiresPermission: 'canAppend' as const,
  },
  {
    id: DATASET_ACTIONS.DELETE,
    label: 'Delete',
    description: 'Prune rows or purge dataset',
    icon: Trash2,
    requiresPermission: 'canDelete' as const,
    isDanger: true,
  },
];

export const DatasetActionPanel: React.FC<DatasetActionPanelProps> = ({
  dataset: _dataset,
  activeAction,
  onSelectAction,
  permissions,
  isBusy = false,
  className = '',
}) => {
  return (
    <div
      className={`w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 ${className}`}
      role="navigation"
      aria-label="Dataset operations"
    >
      {ACTION_CONFIGS.map((config) => {
        const Icon = config.icon;
        const isActive = activeAction === config.id;
        const isPermitted = permissions[config.requiresPermission];
        const isDisabled = !isPermitted || isBusy;

        return (
          <button
            key={config.id}
            type="button"
            disabled={isDisabled}
            onClick={() => onSelectAction(config.id)}
            className={`group relative flex items-center gap-3 p-3 sm:p-3.5 rounded-[var(--radius-container)] border transition-all duration-150 text-left cursor-pointer ${
              isActive
                ? config.isDanger
                  ? 'bg-[var(--color-error-soft)] text-[var(--color-error)] border-[var(--color-error-muted)] shadow-[var(--shadow-xs)]'
                  : 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-muted)] shadow-[var(--shadow-xs)]'
                : isDisabled
                ? 'opacity-40 cursor-not-allowed bg-[var(--color-background-subtle)] border-[var(--color-border)] text-[var(--color-text-muted)]'
                : 'bg-[var(--color-background-surface)] hover:bg-[var(--color-background-subtle)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] shadow-[var(--shadow-xs)]'
            }`}
            aria-current={isActive ? 'page' : undefined}
            title={
              !isPermitted
                ? `Requires ${config.label} permissions (view-only mode active)`
                : config.description
            }
          >
            {/* Concentric Icon Container */}
            <div
              className={`w-9 h-9 rounded-[var(--radius-element)] flex items-center justify-center shrink-0 transition-colors ${
                isActive
                  ? config.isDanger
                    ? 'bg-[var(--color-error)] text-white'
                    : 'bg-[var(--color-primary)] text-white'
                  : config.isDanger
                  ? 'bg-[var(--color-error-soft)] text-[var(--color-error)] group-hover:bg-[var(--color-error-muted)]'
                  : 'bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] group-hover:bg-[var(--color-background-muted)] group-hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon className="w-4 h-4" />
            </div>

            {/* Label & Description */}
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span
                  className={`text-xs font-medium tracking-tight ${
                    isActive
                      ? config.isDanger
                        ? 'text-[var(--color-error)] font-semibold'
                        : 'text-[var(--color-primary)] font-semibold'
                      : 'text-[var(--color-text-primary)]'
                  }`}
                >
                  {config.label}
                </span>
                {!isPermitted && (
                  <Lock className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
                )}
              </div>
              <span
                className={`text-[11px] mt-0.5 leading-snug line-clamp-1 truncate ${
                  isActive
                    ? config.isDanger
                      ? 'text-[var(--color-error)]/80'
                      : 'text-[var(--color-primary)]/80'
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                {config.description}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
};
