import React, { useEffect, useState } from 'react';
import { DatasetItem } from '../../types/dataset';
import { getSemanticModels, proposeSemanticModel, saveSemanticModel, reviewSemanticModel, reuseDefinitions, SemanticField, SemanticModel } from '../../services/semanticService';
import { selectContext } from '../../services/executionContext';
import { getApiErrorMessage } from '../../services/api';

export function SemanticReview({
  dataset,
  forceExpanded = false,
  onClose,
}: {
  dataset: DatasetItem;
  forceExpanded?: boolean;
  onClose?: () => void;
}) {
  const [models, setModels] = useState<SemanticModel[]>([]);
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState('');
  const [reuseVersion, setReuseVersion] = useState('');
  const [reuseRevision, setReuseRevision] = useState('1');
  const [isExpanded, setIsExpanded] = useState(forceExpanded);
  const version = dataset.currentVersion || 1;

  useEffect(() => {
    if (forceExpanded) {
      setIsExpanded(true);
    }
  }, [forceExpanded]);

  useEffect(() => {
    let cancelled = false;
    getSemanticModels(dataset.id, version).then(async items => {
      if (cancelled) return;
      if (items.length > 0) {
        setModels(items);
        setModel(items.sort((a, b) => b.revision - a.revision)[0] || null);
        setDirty(false);
      } else {
        let inherited = false;
        if (version > 1 && dataset.versions?.length) {
          for (const vInfo of [...dataset.versions].reverse()) {
            if (vInfo.version !== version) {
              try {
                const prevItems = await getSemanticModels(dataset.id, vInfo.version);
                if (prevItems && prevItems.length > 0) {
                  const latest = prevItems.sort((a, b) => b.revision - a.revision)[0];
                  const res = await reuseDefinitions(dataset.id, version, vInfo.version, latest.revision);
                  if (!cancelled && res?.model) {
                    setModels([res.model]);
                    setModel(res.model);
                    setDirty(false);
                    inherited = true;
                    break;
                  }
                }
              } catch {
                // fall through
              }
            }
          }
        }
        if (!inherited && !cancelled) {
          try {
            const proposed = await proposeSemanticModel(dataset.id, version);
            if (!cancelled && proposed) {
              setModels([proposed]);
              setModel(proposed);
              setDirty(false);
            }
          } catch {
            // Keep empty state if propose fails
          }
        }
      }
    }).catch(err => { if (!cancelled) setError(getApiErrorMessage(err, 'Semantic models could not be loaded.')); });
    return () => { cancelled = true; };
  }, [dataset.id, version]);

  const updateField = (index: number, changes: Partial<SemanticField>) => {
    setModel(previous => previous && ({ ...previous, fields: previous.fields.map((field, i) => i === index ? { ...field, ...changes } : field) }));
    setDirty(true);
  };

  const run = async (operation: () => Promise<SemanticModel>) => {
    setBusy(true); setError('');
    try {
      const result = await operation();
      setModel(result); setDirty(false);
      setIsExpanded(true);
      setModels(await getSemanticModels(dataset.id, version));
      if (result.status === 'approved') selectContext({ datasetId: dataset.id, version, semanticRevision: result.revision });
    } catch (err) { setError(getApiErrorMessage(err, 'Semantic review failed.')); }
    finally { setBusy(false); }
  };

  const inputClass = 'h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-primary)] text-xs focus:border-[var(--color-primary)] focus:outline-none';

  return (
    <section className="bg-[var(--color-background-surface)] rounded-[var(--radius-container)] border border-[var(--color-border)] p-4 sm:p-5 space-y-4 shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div>
          <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Semantic model review</h2>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Confirm what the data means before publishing analytics.</p>
        </div>
        <div className="flex items-center gap-1.5">
          {model && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] hover:bg-[var(--color-background-subtle)] px-2.5 py-1.5 rounded-[var(--radius-element)] transition-colors cursor-pointer"
              title={isExpanded ? 'Collapse review' : 'Expand review'}
            >
              <span className="material-symbols-outlined text-[16px]">{isExpanded ? 'expand_less' : 'expand_more'}</span>
              <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
            </button>
          )}
          {model && (
            <button
              type="button"
              onClick={() => {
                setIsExpanded(false);
                onClose?.();
              }}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)] p-1.5 rounded-[var(--radius-element)] transition-colors flex items-center justify-center cursor-pointer"
              title="Close review"
              aria-label="Close semantic review"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
          <button
            disabled={busy}
            className="border border-[var(--color-primary-muted)] text-[var(--color-primary)] bg-[var(--color-primary-soft)] hover:bg-[var(--color-primary-muted)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer shadow-[var(--shadow-xs)]"
            onClick={() => void run(() => proposeSemanticModel(dataset.id, version))}
          >
            Propose a model
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] text-[var(--color-error)] border border-[var(--color-error-muted)] text-xs font-medium">
          {error}
        </p>
      )}

      {model ? (
        isExpanded ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-[var(--color-background-subtle)] p-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)]">
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="flex items-center gap-1 font-medium text-[var(--color-text-secondary)]">
                  <span>Revision</span>
                  <select
                    className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-1.5 bg-[var(--color-background-surface)] text-[var(--color-text-primary)] cursor-pointer"
                    value={model.revision}
                    onChange={e => { setModel(models.find(m => m.revision === Number(e.target.value)) || null); setDirty(false); }}
                  >
                    {models.map(m => <option key={m.revision} value={m.revision}>{m.revision} · {m.status}</option>)}
                  </select>
                </label>
                <span className={`px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-medium border ${
                  model.status === 'approved' ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-muted)]' :
                  model.status === 'rejected' ? 'bg-[var(--color-error-soft)] text-[var(--color-error)] border-[var(--color-error-muted)]' :
                  'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-muted)]'
                }`}>
                  {model.status.toUpperCase()}
                </span>
                {model.reviewer && <span className="text-[11px] text-[var(--color-text-muted)]">Reviewed by {model.reviewer}</span>}
                {model.reviewed_at && <time className="text-[10px] text-[var(--color-text-muted)] font-mono">{new Date(model.reviewed_at).toLocaleDateString()}</time>}
              </div>
              <button
                type="button"
                onClick={() => setIsExpanded(false)}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] flex items-center gap-1 font-medium cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">expand_less</span>
                <span>Hide details</span>
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <label className="text-xs flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
                <span>Business domain</span>
                <input className={`${inputClass} w-full`} value={model.domain} onChange={e => { setModel({ ...model, domain: e.target.value }); setDirty(true); }} />
              </label>
              <label className="text-xs flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
                <span>What does one row represent?</span>
                <input className={`${inputClass} w-full`} value={model.grain} onChange={e => { setModel({ ...model, grain: e.target.value }); setDirty(true); }} />
              </label>
            </div>

            <div className="overflow-x-auto rounded-[var(--radius-element)] border border-[var(--color-border)]">
              <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] text-[var(--color-text-secondary)]">
                    <th className="p-2.5 font-medium">Source field</th>
                    <th className="p-2.5 font-medium">Business name / aliases</th>
                    <th className="p-2.5 font-medium">Role</th>
                    <th className="p-2.5 font-medium">Permitted aggregations</th>
                    <th className="p-2.5 font-medium">Unit / currency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text-primary)]">
                  {model.fields.map((field, index) => (
                    <tr key={field.name} className="hover:bg-[var(--color-background-subtle)] align-top">
                      <td className="p-2.5">
                        <strong className="font-mono text-xs">{field.name}</strong>
                        <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">{field.type}</p>
                        <p className="text-[10px] text-[var(--color-text-muted)] max-w-48 mt-0.5 leading-tight">{field.evidence}</p>
                      </td>
                      <td className="p-2.5 space-y-1">
                        <input aria-label={`${field.name} business name`} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-full text-xs bg-[var(--color-background-surface)]" value={field.semantic_name} onChange={e => updateField(index, { semantic_name: e.target.value })} />
                        <input aria-label={`${field.name} aliases`} placeholder="Aliases, separated by commas" className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-full text-xs bg-[var(--color-background-surface)]" value={field.aliases.join(', ')} onChange={e => updateField(index, { aliases: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />
                        <input aria-label={`${field.name} description`} placeholder="Business description" className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-full text-xs bg-[var(--color-background-surface)]" value={field.description} onChange={e => updateField(index, { description: e.target.value })} />
                      </td>
                      <td className="p-2.5">
                        <select aria-label={`${field.name} role`} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 text-xs bg-[var(--color-background-surface)]" value={field.role} onChange={e => updateField(index, { role: e.target.value })}>
                          {['identifier', 'dimension', 'measure', 'time', 'attribute'].map(role => <option key={role}>{role}</option>)}
                        </select>
                      </td>
                      <td className="p-2.5 space-y-1">
                        <input aria-label={`${field.name} permitted aggregations`} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-full text-xs font-mono uppercase bg-[var(--color-background-surface)]" value={field.aggregations.join(',')} onChange={e => updateField(index, { aggregations: e.target.value.toUpperCase().split(',').map(v => v.trim()).filter(Boolean) })} />
                        <select aria-label={`${field.name} default aggregation`} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 text-xs w-full bg-[var(--color-background-surface)]" value={field.default_aggregation || ''} onChange={e => updateField(index, { default_aggregation: e.target.value || null })}>
                          <option value="">Require explicit choice</option>
                          {field.aggregations.map(agg => <option key={agg}>{agg}</option>)}
                        </select>
                      </td>
                      <td className="p-2.5 space-y-1">
                        <input aria-label={`${field.name} unit`} placeholder="Unit" className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-20 text-xs bg-[var(--color-background-surface)]" value={field.unit || ''} onChange={e => updateField(index, { unit: e.target.value || null })} />
                        <input aria-label={`${field.name} currency`} placeholder="Currency" className="h-7 border border-[var(--color-border)] rounded-[var(--radius-inner)] px-2 w-20 text-xs bg-[var(--color-background-surface)]" value={field.currency || ''} onChange={e => updateField(index, { currency: e.target.value || null })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--color-border)]">
              <div className="flex flex-wrap gap-2">
                <button disabled={busy || !dirty} onClick={() => void run(() => saveSemanticModel(model))} className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-background-muted)] transition-colors cursor-pointer disabled:opacity-40">
                  Save revision
                </button>
                <button disabled={busy || dirty || model.status !== 'proposed'} onClick={() => void run(() => reviewSemanticModel(model, 'approved'))} className="bg-[var(--color-primary)] text-white rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium disabled:opacity-40 hover:bg-[var(--color-primary-hover)] transition-colors shadow-[var(--shadow-xs)] cursor-pointer">
                  Approve
                </button>
                <button disabled={busy || dirty || model.status !== 'proposed'} onClick={() => void run(() => reviewSemanticModel(model, 'rejected'))} className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-error-soft)] text-[var(--color-error)] transition-colors cursor-pointer disabled:opacity-40">
                  Reject
                </button>
                {model.status === 'approved' && (
                  <button onClick={() => selectContext({ datasetId: dataset.id, version, semanticRevision: model.revision })} className="border border-[var(--color-primary-muted)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-primary-muted)] transition-colors cursor-pointer shadow-[var(--shadow-xs)]">
                    Use this semantic revision
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsExpanded(false);
                  onClose?.();
                }}
                className="px-3 py-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-muted)] text-xs font-medium transition-colors cursor-pointer"
              >
                Close Review
              </button>
            </div>

            <details className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3 space-y-2">
              <summary className="cursor-pointer font-medium text-xs text-[var(--color-text-primary)] select-none">
                Reviewed formulas and relationships
              </summary>
              <p className="text-[11px] text-[var(--color-text-muted)]">Formulas use named aggregate dependencies and arithmetic only. Relationships pin the target dataset, version, semantic revision and unique keys.</p>
              <pre className="text-[10px] overflow-auto bg-[var(--color-background-subtle)] p-2 rounded-[var(--radius-inner)] font-mono text-[var(--color-text-secondary)]">{JSON.stringify({ derived_metrics: model.derived_metrics || [], relationships: model.relationships }, null, 2)}</pre>
              <textarea aria-label="Formulas and relationships JSON" className="w-full border border-[var(--color-border)] rounded-[var(--radius-element)] p-2 font-mono text-xs bg-[var(--color-background-surface)] focus:border-[var(--color-primary)] focus:outline-none" rows={6} placeholder='{"derived_metrics":[],"relationships":[]}' value={advanced} onChange={e => setAdvanced(e.target.value)} />
              <button className="border border-[var(--color-border)] rounded-[var(--radius-element)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-background-muted)] cursor-pointer" onClick={() => {
                try {
                  const value = JSON.parse(advanced);
                  if (!Array.isArray(value.derived_metrics) || !Array.isArray(value.relationships)) throw new Error();
                  setModel({ ...model, derived_metrics: value.derived_metrics, relationships: value.relationships }); setDirty(true); setError('');
                } catch { setError('Provide a JSON object with derived_metrics and relationships arrays.'); }
              }}>Apply to draft</button>
            </details>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between p-3 bg-[var(--color-background-subtle)] border border-[var(--color-border)] rounded-[var(--radius-element)] text-xs gap-2">
            <div className="flex items-center gap-2.5">
              <span className="material-symbols-outlined text-[var(--color-primary)] text-[18px]">schema</span>
              <div>
                <span className="font-semibold text-[var(--color-text-primary)]">Semantic Model: Revision {model.revision}</span>
                <span className={`ml-2 px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-medium border ${
                  model.status === 'approved' ? 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-muted)]' :
                  model.status === 'rejected' ? 'bg-[var(--color-error-soft)] text-[var(--color-error)] border-[var(--color-error-muted)]' :
                  'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-muted)]'
                }`}>
                  {model.status.toUpperCase()}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)] ml-2 font-mono">({model.fields.length} fields)</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {model.status === 'approved' && (
                <button
                  type="button"
                  onClick={() => selectContext({ datasetId: dataset.id, version, semanticRevision: model.revision })}
                  className="text-xs bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] border border-[var(--color-border)] px-2.5 py-1 rounded-[var(--radius-element)] font-medium transition-colors cursor-pointer"
                >
                  Use this revision
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className="text-xs bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white px-3 py-1 rounded-[var(--radius-element)] font-medium transition-colors flex items-center gap-1 cursor-pointer shadow-[var(--shadow-xs)]"
              >
                <span>Open &amp; Edit Model</span>
                <span className="material-symbols-outlined text-[14px]">expand_more</span>
              </button>
            </div>
          </div>
        )
      ) : <p className="text-xs text-[var(--color-text-muted)]">No semantic model exists for this version. Propose one, review the fields and grain, then approve it.</p>}

      {!model && !!dataset.versions?.some(v => v.version !== version) && (
        <div className="flex flex-wrap gap-2 items-center border-t border-[var(--color-border)] pt-3 text-xs">
          <label className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
            <span>Reuse approved definitions from</span>
            <select className="h-7 border border-[var(--color-border)] rounded-[var(--radius-element)] px-2 bg-[var(--color-background-surface)]" value={reuseVersion} onChange={e => setReuseVersion(e.target.value)}>
              <option value="">Select version</option>
              {dataset.versions.filter(v => v.version !== version).map(v => <option key={v.version} value={v.version}>V{v.version}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 font-medium text-[var(--color-text-secondary)]">
            <span>Revision</span>
            <input aria-label="Source semantic revision" type="number" min={1} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-element)] px-2 w-16 bg-[var(--color-background-surface)]" value={reuseRevision} onChange={e => setReuseRevision(e.target.value)} />
          </label>
          <button disabled={busy || !reuseVersion} className="h-7 border border-[var(--color-border)] rounded-[var(--radius-element)] px-2.5 text-xs font-medium hover:bg-[var(--color-background-muted)] disabled:opacity-40 cursor-pointer" onClick={() => void run(async () => (await reuseDefinitions(dataset.id, version, Number(reuseVersion), Number(reuseRevision))).model)}>
            Review &amp; reuse compatible definitions
          </button>
        </div>
      )}
    </section>
  );
}
