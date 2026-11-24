import { useState } from 'react';
import api from '../services/api';
import { control, contentChanged, FileDialog, fileError } from './ContentFiles';

type Scope = 'widget' | 'page' | 'dashboard';
type Condition = { column: string; operator: string; value?: unknown };
export type ScopedFilters = Record<Scope, Condition[]>;

export function PlacementFilters({
  dashboard,
  revision,
  placement,
  fields,
  filters,
  close,
}: {
  dashboard: string;
  revision: number;
  placement: string;
  fields: string[];
  filters: ScopedFilters;
  close: () => void;
}) {
  const [scope, setScope] = useState<Scope>('widget');
  const [rows, setRows] = useState<Condition[]>(filters.widget);
  const [column, setColumn] = useState(fields[0] || '');
  const [operator, setOperator] = useState('=');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.put('/content/files/' + dashboard + '/filters', {
        placement_id: placement,
        revision,
        scope,
        filters: rows,
      });
      close();
      contentChanged();
    } catch (err) {
      setError(fileError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FileDialog title="Filters" close={close}>
      <fieldset disabled={busy} className="grid gap-3">
        <label>
          Apply to{' '}
          <select
            className={control}
            value={scope}
            onChange={(e) => {
              const next = e.target.value as Scope;
              setScope(next);
              setRows(filters[next]);
            }}
          >
            <option value="widget">This widget</option>
            <option value="page">Matching sources on this page</option>
            <option value="dashboard">Matching sources in this dashboard</option>
          </select>
        </label>
        <ul>
          {rows.map((f, i) => (
            <li key={i}>
              {f.column} {f.operator} {String(f.value ?? '')}{' '}
              <button onClick={() => setRows(rows.filter((_, n) => n !== i))}>Remove</button>
            </li>
          ))}
        </ul>
        <label>
          Field{' '}
          <select className={control} value={column} onChange={(e) => setColumn(e.target.value)}>
            {fields.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          Operator{' '}
          <select
            className={control}
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          >
            {['=', '!=', '>', '<', '>=', '<=', 'CONTAINS', 'IS_NULL', 'NOT_NULL'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        {!operator.endsWith('NULL') && (
          <label>
            Value{' '}
            <input
              className={control}
              maxLength={512}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <button
          className={control}
          disabled={!column || rows.length >= 20}
          onClick={() => {
            setRows([
              ...rows,
              { column, operator, value: operator.endsWith('NULL') ? null : value },
            ]);
            setValue('');
          }}
        >
          Add condition
        </button>
        <button className={control} onClick={save}>
          Save filters
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </FileDialog>
  );
}
