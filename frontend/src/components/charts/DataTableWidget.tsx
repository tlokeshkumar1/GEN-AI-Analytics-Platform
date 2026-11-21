import React from 'react';
import { humanizeColumnName, formatTableCell } from './chartUtils';

interface DataTableWidgetProps {
  columns: string[];
  rows: Record<string, unknown>[];
}

export const DataTableWidget: React.FC<DataTableWidgetProps> = ({ columns, rows }) => {
  return (
    <div className="overflow-auto max-h-80 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-[var(--color-background-subtle)] border-b border-[var(--color-border)]">
            {columns.map(c => (
              <th
                key={c}
                className="px-3.5 py-2 font-medium text-[var(--color-text-secondary)] text-[11px] tracking-wider uppercase whitespace-nowrap"
              >
                {humanizeColumnName(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.slice(0, 100).map((row, index) => (
            <tr
              key={index}
              className="transition-colors hover:bg-[var(--color-background-subtle)]"
            >
              {columns.map(c => {
                const formatted = formatTableCell(row[c], c);
                return (
                  <td
                    key={c}
                    className="px-3.5 py-2 whitespace-nowrap text-[var(--color-text-primary)] tabular-nums text-xs"
                    title={formatted.tooltip}
                  >
                    {formatted.display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && (
        <div className="px-3.5 py-1.5 text-center text-[11px] text-[var(--color-text-muted)] bg-[var(--color-background-subtle)] border-t border-[var(--color-border)]">
          Showing first 100 of {rows.length.toLocaleString()} rows
        </div>
      )}
    </div>
  );
};
