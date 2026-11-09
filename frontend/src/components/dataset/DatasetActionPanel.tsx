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
      className={`w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 ${className}`}
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
            className={`group relative flex items-center gap-3.5 p-3.5 sm:p-4 rounded-2xl border transition-all duration-200 text-left cursor-pointer ${
              isActive
                ? config.isDanger
                  ? 'bg-rose-50/80 text-rose-900 border-rose-300 shadow-sm ring-2 ring-rose-500/15'
                  : 'bg-[#EFF6FF] text-[#1E40AF] border-[#93C5FD] shadow-sm ring-2 ring-blue-500/15'
                : isDisabled
                ? 'opacity-50 cursor-not-allowed bg-slate-50 border-slate-200 text-slate-400'
                : 'bg-white hover:bg-[#F8FAFC] border-slate-200/90 text-slate-700 hover:text-slate-900 shadow-2xs hover:shadow-xs hover:border-slate-300'
            }`}
            aria-current={isActive ? 'page' : undefined}
            title={
              !isPermitted
                ? `Requires ${config.label} permissions (view-only mode active)`
                : config.description
            }
          >
            {/* Squircle Icon Container */}
            <div
              className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 transition-colors shadow-2xs ${
                isActive
                  ? config.isDanger
                    ? 'bg-rose-600 text-white'
                    : 'bg-[#2563EB] text-white'
                  : config.isDanger
                  ? 'bg-rose-50 text-rose-600 group-hover:bg-rose-100'
                  : 'bg-[#F1F5F9] text-[#475569] group-hover:bg-[#E2E8F0] group-hover:text-[#0F172A]'
              }`}
            >
              <Icon className="w-5 h-5" />
            </div>

            {/* Label & Description */}
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span
                  className={`text-sm font-semibold tracking-tight ${
                    isActive
                      ? config.isDanger
                        ? 'text-rose-900'
                        : 'text-[#1D4ED8]'
                      : 'text-[#0F172A]'
                  }`}
                >
                  {config.label}
                </span>
                {!isPermitted && (
                  <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                )}
              </div>
              <span
                className={`text-xs mt-0.5 leading-snug line-clamp-1 truncate ${
                  isActive
                    ? config.isDanger
                      ? 'text-rose-700/80'
                      : 'text-blue-700/80'
                    : 'text-[#64748B]'
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
