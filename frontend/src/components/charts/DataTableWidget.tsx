import React from 'react';
import { humanizeColumnName, formatTableCell } from './chartUtils';

interface DataTableWidgetProps {
  columns: string[];
  rows: Record<string, unknown>[];
}

export const DataTableWidget: React.FC<DataTableWidgetProps> = ({ columns, rows }) => {
  return (
    <div className="overflow-auto max-h-80 rounded-xl border border-slate-200">
      <table className="w-full text-sm text-left">
        <thead>
          <tr className="bg-slate-50/80">
            {columns.map(c => (
              <th
                key={c}
                className="px-4 py-2.5 font-semibold text-slate-700 text-xs tracking-wider border-b border-slate-200 whitespace-nowrap"
              >
                {humanizeColumnName(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, index) => (
            <tr
              key={index}
              className={`border-b border-slate-100 transition-colors hover:bg-blue-50/40 ${
                index % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'
              }`}
            >
              {columns.map(c => {
                const formatted = formatTableCell(row[c], c);
                return (
                  <td
                    key={c}
                    className="px-4 py-2.5 whitespace-nowrap text-slate-700 tabular-nums text-xs"
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
        <div className="px-4 py-2 text-center text-xs text-slate-500 bg-slate-50/60 border-t border-slate-200">
          Showing first 100 of {rows.length.toLocaleString()} rows
        </div>
      )}
    </div>
  );
};

