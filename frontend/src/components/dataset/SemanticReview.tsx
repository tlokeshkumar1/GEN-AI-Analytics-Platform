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
        // Automatically check previous versions for approved models to inherit
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
  return <section className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
    <div className="flex flex-wrap justify-between items-center gap-3">
      <div>
        <h2 className="font-semibold text-lg text-slate-900">Semantic model review</h2>
        <p className="text-sm text-slate-500">Confirm what the data means before publishing analytics.</p>
      </div>
      <div className="flex items-center gap-2">
        {model && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 hover:bg-slate-50 px-2.5 py-1.5 rounded-lg transition-colors"
            title={isExpanded ? 'Collapse review' : 'Expand review'}
          >
            <span className="material-symbols-outlined text-sm">{isExpanded ? 'expand_less' : 'expand_more'}</span>
            <span>{isExpanded ? 'Collapse' : 'Expand'}</span>
          </button>
        )}
        {model && (
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            className="text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-1.5 rounded-lg transition-colors flex items-center justify-center"
            title="Close review"
            aria-label="Close semantic review"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        )}
        <button
          disabled={busy}
          className="border border-blue-300 text-blue-700 hover:bg-blue-50 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          onClick={() => void run(() => proposeSemanticModel(dataset.id, version))}
        >
          Propose a model
        </button>
      </div>
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {model ? (
      isExpanded ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm bg-slate-50 p-2.5 rounded-lg border border-slate-200">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1 font-medium">Revision <select className="border rounded p-1 bg-white" value={model.revision} onChange={e => { setModel(models.find(m => m.revision === Number(e.target.value)) || null); setDirty(false); }}>
                {models.map(m => <option key={m.revision} value={m.revision}>{m.revision} · {m.status}</option>)}
              </select></label>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                model.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                model.status === 'rejected' ? 'bg-rose-100 text-rose-800' :
                'bg-amber-100 text-amber-800'
              }`}>{model.status}</span>
              {model.reviewer ? <span className="text-xs text-slate-500">Reviewed by {model.reviewer}</span> : null}
              {model.reviewed_at && <time className="text-xs text-slate-400">{new Date(model.reviewed_at).toLocaleString()}</time>}
            </div>
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 font-medium"
            >
              <span className="material-symbols-outlined text-[14px]">expand_less</span>
              <span>Hide details</span>
            </button>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-sm">Business domain<input className="w-full border rounded-lg p-2" value={model.domain} onChange={e => { setModel({ ...model, domain: e.target.value }); setDirty(true); }} /></label>
            <label className="text-sm">What does one row represent?<input className="w-full border rounded-lg p-2" value={model.grain} onChange={e => { setModel({ ...model, grain: e.target.value }); setDirty(true); }} /></label>
          </div>
          <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr className="bg-slate-50"><th className="p-2">Source field</th><th>Business name / aliases</th><th>Role</th><th>Permitted aggregations / default</th><th>Unit / currency</th></tr></thead>
            <tbody>{model.fields.map((field, index) => <tr key={field.name} className="border-t align-top">
              <td className="p-2"><strong>{field.name}</strong><p className="text-xs text-slate-500">{field.type}</p><p className="text-xs text-slate-500 max-w-52">{field.evidence}</p></td>
              <td className="p-2"><input aria-label={`${field.name} business name`} className="border rounded p-1 w-full" value={field.semantic_name} onChange={e => updateField(index, { semantic_name: e.target.value })} />
                <input aria-label={`${field.name} aliases`} placeholder="Aliases, separated by commas" className="border rounded p-1 w-full mt-1" value={field.aliases.join(', ')} onChange={e => updateField(index, { aliases: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} />
                <input aria-label={`${field.name} description`} placeholder="Business description" className="border rounded p-1 w-full mt-1" value={field.description} onChange={e => updateField(index, { description: e.target.value })} /></td>
              <td className="p-2"><select aria-label={`${field.name} role`} className="border rounded p-1" value={field.role} onChange={e => updateField(index, { role: e.target.value })}>
                {['identifier', 'dimension', 'measure', 'time', 'attribute'].map(role => <option key={role}>{role}</option>)}
              </select></td>
              <td className="p-2"><input aria-label={`${field.name} permitted aggregations`} className="border rounded p-1 w-full" value={field.aggregations.join(',')} onChange={e => updateField(index, { aggregations: e.target.value.toUpperCase().split(',').map(v => v.trim()).filter(Boolean) })} />
                <select aria-label={`${field.name} default aggregation`} className="border rounded p-1 mt-1" value={field.default_aggregation || ''} onChange={e => updateField(index, { default_aggregation: e.target.value || null })}>
                  <option value="">Require an explicit choice</option>{field.aggregations.map(agg => <option key={agg}>{agg}</option>)}
                </select></td>
              <td className="p-2"><input aria-label={`${field.name} unit`} placeholder="Unit" className="border rounded p-1 w-24" value={field.unit || ''} onChange={e => updateField(index, { unit: e.target.value || null })} />
                <input aria-label={`${field.name} currency`} placeholder="Currency" className="border rounded p-1 w-24 mt-1" value={field.currency || ''} onChange={e => updateField(index, { currency: e.target.value || null })} /></td>
            </tr>)}</tbody></table></div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
            <div className="flex flex-wrap gap-2">
              <button disabled={busy || !dirty} onClick={() => void run(() => saveSemanticModel(model))} className="border rounded-lg px-3 py-2 text-sm hover:bg-slate-50 transition-colors">Save as a new revision</button>
              <button disabled={busy || dirty || model.status !== 'proposed'} onClick={() => void run(() => reviewSemanticModel(model, 'approved'))} className="bg-blue-600 text-white rounded-lg px-3 py-2 text-sm disabled:opacity-40 hover:bg-blue-700 transition-colors">Approve</button>
              <button disabled={busy || dirty || model.status !== 'proposed'} onClick={() => void run(() => reviewSemanticModel(model, 'rejected'))} className="border rounded-lg px-3 py-2 text-sm hover:bg-slate-50 transition-colors">Reject</button>
              {model.status === 'approved' && <button onClick={() => selectContext({ datasetId: dataset.id, version, semanticRevision: model.revision })} className="border rounded-lg px-3 py-2 text-sm hover:bg-slate-50 transition-colors">Use this semantic revision</button>}
            </div>
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:text-slate-900 hover:bg-slate-100 text-sm font-medium transition-colors"
            >
              Close Review
            </button>
          </div>
          <details className="border rounded-lg p-3 space-y-2"><summary className="cursor-pointer font-medium text-slate-800">Reviewed formulas and relationships</summary>
            <p className="text-sm text-slate-500">Formulas use named aggregate dependencies and arithmetic only. Relationships pin the target dataset, version, semantic revision and unique keys. Saving validates both against source data.</p>
            <pre className="text-xs overflow-auto bg-slate-50 p-2 rounded">{JSON.stringify({ derived_metrics: model.derived_metrics || [], relationships: model.relationships }, null, 2)}</pre>
            <textarea aria-label="Formulas and relationships JSON" className="w-full border rounded p-2 font-mono text-xs" rows={8} placeholder='{"derived_metrics":[],"relationships":[]}' value={advanced} onChange={e => setAdvanced(e.target.value)} />
            <button className="border rounded-lg px-3 py-2 text-sm" onClick={() => {
              try {
                const value = JSON.parse(advanced);
                if (!Array.isArray(value.derived_metrics) || !Array.isArray(value.relationships)) throw new Error();
                setModel({ ...model, derived_metrics: value.derived_metrics, relationships: value.relationships }); setDirty(true); setError('');
              } catch { setError('Provide a JSON object with derived_metrics and relationships arrays.'); }
            }}>Apply to draft</button>
          </details>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between p-3.5 bg-slate-50 border border-slate-200 rounded-xl text-sm gap-2">
          <div className="flex items-center gap-2.5">
            <span className="material-symbols-outlined text-blue-600 text-lg">schema</span>
            <div>
              <span className="font-semibold text-slate-800">Semantic Model: Revision {model.revision}</span>
              <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
                model.status === 'approved' ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' :
                model.status === 'rejected' ? 'bg-rose-100 text-rose-800 border border-rose-200' :
                'bg-amber-100 text-amber-800 border border-amber-200'
              }`}>
                {model.status.toUpperCase()}
              </span>
              <span className="text-xs text-slate-500 ml-2 font-mono">({model.fields.length} fields)</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {model.status === 'approved' && (
              <button
                type="button"
                onClick={() => selectContext({ datasetId: dataset.id, version, semanticRevision: model.revision })}
                className="text-xs bg-slate-200 hover:bg-slate-300 text-slate-700 px-2.5 py-1.5 rounded-lg font-medium transition-colors"
              >
                Use this revision
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsExpanded(true)}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1"
            >
              <span>Open & Edit Model</span>
              <span className="material-symbols-outlined text-[14px]">expand_more</span>
            </button>
          </div>
        </div>
      )
    ) : <p className="text-sm text-slate-500">No semantic model exists for this version. Propose one, review the fields and grain, then approve it.</p>}
    {!model && !!dataset.versions?.some(v => v.version !== version) && <div className="flex flex-wrap gap-2 items-center border-t pt-3">
      <label className="text-sm">Reuse approved definitions from <select className="border rounded p-2 ml-2" value={reuseVersion} onChange={e => setReuseVersion(e.target.value)}><option value="">Select version</option>{dataset.versions.filter(v => v.version !== version).map(v => <option key={v.version} value={v.version}>V{v.version}</option>)}</select></label>
      <label className="text-sm">Semantic revision <input aria-label="Source semantic revision" type="number" min={1} className="border rounded p-2 w-20" value={reuseRevision} onChange={e => setReuseRevision(e.target.value)} /></label>
      <button disabled={busy || !reuseVersion} className="border rounded px-3 py-2 disabled:opacity-40" onClick={() => void run(async () => (await reuseDefinitions(dataset.id, version, Number(reuseVersion), Number(reuseRevision))).model)}>Review and reuse compatible definitions</button>
    </div>}
  </section>;
}
