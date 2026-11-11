import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../services/api';
import { connectorTypes, listBindings, listConnections, listJobs, SYSTEM_TABS } from '../services/systemService';
import { getDatasets } from '../services/datasetService';

const inputClass = 'border border-slate-300 rounded-lg px-3 py-1.5 w-full bg-white text-slate-900 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all shadow-2xs';
const buttonPrimaryClass = 'inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 text-white font-semibold text-xs hover:bg-blue-700 active:scale-[0.98] transition-all shadow-2xs disabled:opacity-50 disabled:pointer-events-none cursor-pointer';
const buttonSecondaryClass = 'inline-flex items-center justify-center gap-1.5 px-3 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 font-semibold text-xs hover:bg-slate-50 hover:border-slate-300 active:scale-[0.98] transition-all shadow-2xs disabled:opacity-40 disabled:pointer-events-none cursor-pointer';

const configFields: Record<string, string[]> = {
  rest: ['base_url', 'discovery_path', 'records_path', 'pagination', 'next_link_path', 'page_size'],
  odata: ['base_url'],
  s4hana: ['base_url', 'api_service', 'api_key_header'],
  sap_icsm: ['base_url', 'api_service', 'spec_path'],
  sac: ['base_url', 'namespace', 'provider_id'],
  soap: ['base_url', 'wsdl_url', 'service_name', 'port_name', 'records_path'],
  hana: ['host', 'port', 'schema'],
  s3: ['bucket', 'region', 'prefix'],
  gcs: ['bucket', 'project', 'prefix'],
  azure_blob: ['account_url', 'bucket', 'prefix'],
};

const credentialFields: Record<string, string[]> = {
  none: [],
  managed: [],
  basic: ['username', 'password'],
  bearer: ['token'],
  api_key: ['api_key'],
  oauth2_client_credentials: ['client_id', 'client_secret'],
  aws_keys: ['access_key_id', 'secret_access_key', 'session_token'],
  service_account: ['service_account_json'],
  azure_key: ['account_key'],
  azure_sas: ['sas_token'],
};

export const SystemSettings: React.FC<{ onNavigate: (path: string) => void; initialTab?: string }> = ({ initialTab }) => {
  const [tab, setTab] = useState(initialTab || 'Connections');
  const [connections, setConnections] = useState<any[]>([]);
  const [types, setTypes] = useState<any[]>([]);
  const [bindings, setBindings] = useState<any[]>([]);
  const [datasets, setDatasets] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [access, setAccess] = useState<any>(null);
  const [ai, setAI] = useState<any>(null);
  const [storage, setStorage] = useState<any>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editRevision, setEditRevision] = useState(0);
  const [name, setName] = useState('');
  const [service, setService] = useState('rest');
  const [config, setConfig] = useState<Record<string, any>>({});
  const [auth, setAuth] = useState('none');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState('{}');
  const [operationParameters, setOperationParameters] = useState('{}');
  const [discovery, setDiscovery] = useState<any>(null);
  const [previewData, setPreviewData] = useState<any>(null);
  const [connectionId, setConnectionId] = useState('');
  const [source, setSource] = useState('');
  const [bindingName, setBindingName] = useState('');
  const [targetDataset, setTargetDataset] = useState('');
  const [mode, setMode] = useState('replace');
  const [keys, setKeys] = useState('');
  const [duplicatePolicy, setDuplicatePolicy] = useState('keep');
  const [deletionField, setDeletionField] = useState('');
  const [transformationPlan, setTransformationPlan] = useState('{}');

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch (err) {
      setError(getApiErrorMessage(err, 'System operation failed.'));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (tab === 'Connections') {
      const [items, registry, sources, data] = await Promise.all([
        listConnections(),
        connectorTypes(),
        listBindings(),
        getDatasets(),
      ]);
      setConnections(items);
      setTypes(registry);
      setBindings(sources);
      setDatasets(data);
    } else if (tab === 'Sync Jobs') {
      setJobs(await listJobs());
    } else if (tab === 'AI Configuration') {
      setAI((await api.get('/system/ai')).data);
    } else if (tab === 'Storage & Retention') {
      setStorage((await api.get('/system/storage')).data);
    } else {
      const [auditRes, accessRes] = await Promise.all([
        api.get('/system/audit'),
        api.get('/system/access'),
      ]);
      setAudit(auditRes.data);
      setAccess(accessRes.data);
    }
  };

  useEffect(() => {
    void run(refresh);
  }, [tab]);

  const hasActiveJobs = jobs.some(j => j.state === 'queued' || j.state === 'running');
  useEffect(() => {
    if (tab !== 'Sync Jobs' || !hasActiveJobs) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      listJobs()
        .then(setJobs)
        .catch(err => setError(getApiErrorMessage(err, 'Job polling failed.')));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [tab, hasActiveJobs]);

  const saveConnection = async () => {
    const descriptor = types.find(type => type.service === service);
    if (!descriptor) throw new Error('Choose a supported connector service.');
    const extra = ['rest', 'odata', 's4hana', 'sap_icsm', 'sac', 'soap'].includes(service)
      ? {
          response_mapping: JSON.parse(mapping),
          ...(service === 'soap' ? { operation_parameters: JSON.parse(operationParameters) } : {}),
        }
      : {};
    const body = {
      name,
      provider: descriptor.provider,
      protocol: descriptor.protocol,
      service: descriptor.service,
      auth_type: auth,
      config: { ...config, ...extra },
      credentials: Object.fromEntries(Object.entries(credentials).filter(([, val]) => val)),
    };
    if (editId) {
      await api.put(`/system/connections/${editId}`, body, { params: { revision: editRevision } });
    } else {
      await api.post('/system/connections', body);
    }
    setCredentials({});
    setEditId(null);
    setEditRevision(0);
    setName('');
    setConfig({});
    setConnections(await listConnections());
    setMessage('Connection configuration saved. Test it to verify live access.');
  };

  return (
    <div className="space-y-3.5 w-full max-w-[1560px] mx-auto pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-1.5 px-0.5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">settings</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">System Management</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              Infrastructure
            </span>
            <span className="text-xs text-slate-400 font-mono hidden sm:inline">
              · Enterprise Connectors & Jobs
            </span>
          </div>
        </div>

        <button
          disabled={busy}
          onClick={() => void run(refresh)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-slate-700 font-semibold text-xs border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-2xs disabled:opacity-50 cursor-pointer"
        >
          <span className={`material-symbols-outlined text-[15px] text-blue-600 ${busy ? 'animate-spin' : ''}`}>
            {busy ? 'sync' : 'refresh'}
          </span>
          <span>{busy ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </div>

      {/* Tabs */}
      <nav className="flex gap-1 p-0.5 bg-slate-100 rounded-lg border border-slate-200 overflow-x-auto" aria-label="System Management sections">
        {SYSTEM_TABS.map(value => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`px-3 py-1 rounded-md text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
              value === tab
                ? 'bg-white text-blue-700 shadow-2xs border border-slate-200/80 font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50'
            }`}
          >
            {value}
          </button>
        ))}
      </nav>

      {/* Alerts */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-red-50 border border-red-200 text-red-800 p-4 rounded-2xl text-sm shadow-sm">
          <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="font-semibold text-red-900">Operation Error</p>
            <p className="mt-0.5">{error}</p>
          </div>
        </div>
      )}
      {message && (
        <div role="status" className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-2xl text-sm shadow-sm">
          <svg className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <div>
            <p className="font-semibold text-emerald-900">Success</p>
            <p className="mt-0.5">{message}</p>
          </div>
        </div>
      )}

      {/* TAB: Connections */}
      {tab === 'Connections' && (
        <div className="space-y-6">
          {/* Create/Edit Form */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3.5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h2 className="text-xs font-bold text-slate-900">{editId ? 'Edit Connection' : 'Register New Connection'}</h2>
                <p className="text-xs text-slate-500 mt-0.5">Integrate SAP HANA, S/4HANA OData, SAC, REST APIs, or Cloud Object Stores</p>
              </div>
              {editId && (
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                  Editing: Revision #{editRevision}
                </span>
              )}
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Connection Name</label>
                <input
                  className={inputClass}
                  placeholder="e.g. Corporate HANA Cloud"
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Service Type</label>
                <select
                  className={inputClass}
                  value={service}
                  onChange={e => {
                    setService(e.target.value);
                    setAuth(types.find(t => t.service === e.target.value)?.auth_types?.[0] || 'none');
                    setConfig({});
                    setCredentials({});
                  }}
                >
                  {types.map(t => {
                    let label = `${t.provider.toUpperCase()} / ${t.service} (${t.protocol.toUpperCase()})`;
                    if (t.service === 'sap_icsm') {
                      label = 'SAP / ICSM - Clinical Trials PO (ODATA)';
                    } else if (t.service === 's4hana') {
                      label = 'SAP / S/4HANA (ODATA)';
                    } else if (t.service === 'sac') {
                      label = 'SAP / Analytics Cloud (ODATA)';
                    }
                    return (
                      <option key={t.service} value={t.service}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Authentication Protocol</label>
                <select
                  className={inputClass}
                  value={auth}
                  onChange={e => {
                    setAuth(e.target.value);
                    setCredentials({});
                  }}
                >
                  {(types.find(t => t.service === service)?.auth_types || ['none']).map((t: string) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              {(configFields[service] || []).map(field => (
                <div key={field}>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {field.replaceAll('_', ' ')}
                  </label>
                  <input
                    className={inputClass}
                    placeholder={`Enter ${field.replaceAll('_', ' ')}`}
                    value={config[field] ?? ''}
                    onChange={e => setConfig(prev => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}

              {auth === 'oauth2_client_credentials' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Token Endpoint URL</label>
                    <input
                      className={inputClass}
                      placeholder="https://auth.example.com/oauth/token"
                      value={config.token_url || ''}
                      onChange={e => setConfig({ ...config, token_url: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Scope</label>
                    <input
                      className={inputClass}
                      placeholder="e.g. read:analytics"
                      value={config.scope || ''}
                      onChange={e => setConfig({ ...config, scope: e.target.value })}
                    />
                  </div>
                </>
              )}

              {(credentialFields[auth] || []).map(field => (
                <div key={field}>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {field.replaceAll('_', ' ')}
                  </label>
                  <input
                    type="password"
                    autoComplete="off"
                    className={inputClass}
                    placeholder={editId ? '•••••••• (leave blank to retain)' : `Enter ${field.replaceAll('_', ' ')}`}
                    value={credentials[field] || ''}
                    onChange={e => setCredentials(prev => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}
            </div>

            {['rest', 'odata', 's4hana', 'sac', 'soap'].includes(service) && (
              <div className="grid sm:grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Response Field Mapping (JSON)
                  </label>
                  <textarea
                    className={`${inputClass} font-mono text-xs`}
                    rows={4}
                    value={mapping}
                    onChange={e => setMapping(e.target.value)}
                  />
                </div>
                {service === 'soap' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Operation Parameters (JSON)
                    </label>
                    <textarea
                      className={`${inputClass} font-mono text-xs`}
                      rows={4}
                      value={operationParameters}
                      onChange={e => setOperationParameters(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-100">
              <p className="text-xs text-slate-500 flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Credentials are encrypted in transit and at rest using enterprise KMS.
              </p>
              <div className="flex items-center gap-2">
                {editId && (
                  <button
                    className={buttonSecondaryClass}
                    onClick={() => {
                      setEditId(null);
                      setConfig({});
                      setCredentials({});
                      setName('');
                    }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  disabled={busy || !name}
                  className={buttonPrimaryClass}
                  onClick={() => void run(saveConnection)}
                >
                  {editId ? 'Update Connection' : 'Save Connection'}
                </button>
              </div>
            </div>
          </section>

          {/* Active Connections List */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-bold text-slate-900">Configured External Connections ({connections.length})</h2>
            </div>
            {!connections.length ? (
              <div className="bg-white border border-slate-200/80 rounded-2xl p-8 text-center text-slate-500">
                <p className="text-sm">No external connections configured yet.</p>
              </div>
            ) : (
              <div className="grid lg:grid-cols-2 gap-4">
                {connections.map(item => (
                  <div key={item.id} className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-900 text-base">{item.name}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 uppercase tracking-wider">
                            {item.provider}
                          </span>
                          <span className="text-slate-300">•</span>
                          <span className="text-xs text-slate-500 font-medium">{item.service}</span>
                          <span className="text-slate-300">•</span>
                          <span className="text-xs text-slate-500 uppercase">{item.protocol}</span>
                        </div>
                      </div>

                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                          item.enabled && item.verification === 'verified'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : item.enabled
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${item.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
                        {item.enabled ? item.verification : 'Disabled'}
                      </span>
                    </div>

                    {item.verified_at && (
                      <p className="text-xs text-slate-500 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Last verified: {new Date(item.verified_at).toLocaleString()}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100">
                      <button
                        disabled={busy || !item.enabled}
                        className={buttonSecondaryClass}
                        onClick={() =>
                          void run(async () => {
                            const result = (await api.post(`/system/connections/${item.id}/test`)).data;
                            setMessage(`Connection verified in ${result.elapsed_ms.toFixed(2)} ms.`);
                            setConnections(await listConnections());
                          })
                        }
                      >
                        ⚡ Test Latency
                      </button>
                      <button
                        disabled={busy || !item.enabled}
                        className={buttonSecondaryClass}
                        onClick={() =>
                          void run(async () => {
                            setConnectionId(item.id);
                            setDiscovery((await api.get(`/system/connections/${item.id}/discover`)).data);
                          })
                        }
                      >
                        🔍 Discover Schema
                      </button>
                      <button
                        disabled={busy}
                        className={buttonSecondaryClass}
                        onClick={() => {
                          setEditId(item.id);
                          setEditRevision(item.revision);
                          setName(item.name);
                          setService(item.service);
                          setAuth(item.auth_type);
                          setConfig(item.config);
                          setCredentials({});
                          setMapping(JSON.stringify(item.config.response_mapping || {}, null, 2));
                          setOperationParameters(JSON.stringify(item.config.operation_parameters || {}, null, 2));
                        }}
                      >
                        ✏️ Edit
                      </button>
                      <button
                        disabled={busy || !item.enabled}
                        className={buttonSecondaryClass}
                        onClick={() =>
                          void run(async () => {
                            await api.post(`/system/connections/${item.id}/disable`);
                            setConnections(await listConnections());
                          })
                        }
                      >
                        Disable
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Discovery Output */}
          {discovery && (
            <section className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-slate-900 text-sm">Discovered Objects & Schemas</h2>
                <button className="text-xs text-blue-600 hover:underline" onClick={() => setDiscovery(null)}>Close Preview</button>
              </div>
              <pre className="text-xs font-mono bg-slate-50 p-4 rounded-xl border border-slate-200/60 overflow-auto max-h-80 text-slate-800">
                {JSON.stringify(discovery, null, 2)}
              </pre>
            </section>
          )}

          {/* Bind a source to a dataset */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3.5">
            <div>
              <h2 className="text-xs font-bold text-slate-900">Bind Source to Analytics Dataset</h2>
              <p className="text-xs text-slate-500 mt-0.5">Map an external database or endpoint into the platform semantic catalog</p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Connection</label>
                <select className={inputClass} value={connectionId} onChange={e => setConnectionId(e.target.value)}>
                  <option value="">Choose an active connection</option>
                  {connections.filter(c => c.enabled).map(c => (
                    <option value={c.id} key={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Source Object / Entity</label>
                <input
                  className={inputClass}
                  placeholder="e.g. SalesOrders / /api/v2/items"
                  value={source}
                  onChange={e => setSource(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Binding Identifier</label>
                <input
                  className={inputClass}
                  placeholder="e.g. ERP_Daily_Sales"
                  value={bindingName}
                  onChange={e => setBindingName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Target Platform Dataset</label>
                <select className={inputClass} value={targetDataset} onChange={e => setTargetDataset(e.target.value)}>
                  <option value="">Auto-create dataset on first sync</option>
                  {datasets.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Import Mode</label>
                <select className={inputClass} value={mode} onChange={e => setMode(e.target.value)}>
                  {['replace', 'append', 'upsert'].map(val => (
                    <option key={val} value={val}>{val.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Duplicate Policy</label>
                <select className={inputClass} value={duplicatePolicy} onChange={e => setDuplicatePolicy(e.target.value)}>
                  {['keep', 'drop', 'reject'].map(val => (
                    <option key={val} value={val}>{val.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              {mode === 'upsert' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Stable Key Fields (CSV)</label>
                    <input className={inputClass} placeholder="ID, RegionCode" value={keys} onChange={e => setKeys(e.target.value)} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Deletion Flag Field (Optional)</label>
                    <input className={inputClass} placeholder="is_deleted" value={deletionField} onChange={e => setDeletionField(e.target.value)} />
                  </div>
                </>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Parsing & Transformation Rules (JSON)</label>
              <textarea
                aria-label="Source transformation plan"
                className={`${inputClass} font-mono text-xs`}
                rows={3}
                value={transformationPlan}
                onChange={e => setTransformationPlan(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                disabled={busy || !connectionId || !source}
                className={buttonSecondaryClass}
                onClick={() =>
                  void run(async () => {
                    setPreviewData((await api.post(`/system/connections/${connectionId}/preview`, { source })).data);
                  })
                }
              >
                Preview Source Data
              </button>
              <button
                type="button"
                disabled={busy || !connectionId || !source || !bindingName}
                className={buttonPrimaryClass}
                onClick={() =>
                  void run(async () => {
                    await api.post('/system/bindings', {
                      name: bindingName,
                      connection_id: connectionId,
                      source,
                      dataset_id: targetDataset || null,
                      mode,
                      keys: keys.split(',').map(v => v.trim()).filter(Boolean),
                      duplicate_policy: duplicatePolicy,
                      deletion_field: deletionField || null,
                      transformation_plan: JSON.parse(transformationPlan),
                    });
                    setBindings(await listBindings());
                    setPreviewData(null);
                    setMessage('Source binding saved successfully. You can now trigger a sync.');
                  })
                }
              >
                Save Source Binding
              </button>
            </div>

            {/* Live Data Preview inside Bind Source Section */}
            {previewData && (
              <div className="mt-4 p-4 rounded-xl border border-slate-200/80 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-blue-600 text-base">visibility</span>
                    <h3 className="font-bold text-slate-900 text-sm">
                      Live Data Preview: {source}
                    </h3>
                    {Array.isArray(previewData?.records) && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-semibold">
                        {previewData.records.length} sample records
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-xs text-slate-500 hover:text-slate-800 font-medium cursor-pointer"
                    onClick={() => setPreviewData(null)}
                  >
                    Close Preview
                  </button>
                </div>
                <pre className="text-xs font-mono bg-white p-4 rounded-xl border border-slate-200/80 overflow-auto max-h-80 text-slate-800 leading-relaxed shadow-xs">
                  {JSON.stringify(previewData, null, 2)}
                </pre>
              </div>
            )}
          </section>

          {/* Source Bindings List (Fixed ? characters) */}
          <section className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm space-y-4">
            <h2 className="text-base font-bold text-slate-900">Configured Source Bindings ({bindings.length})</h2>
            {!bindings.length ? (
              <p className="text-sm text-slate-500">No active source bindings configured.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {bindings.map(binding => (
                  <div key={binding.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 text-sm">{binding.name}</span>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200 uppercase">
                          {binding.mode}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                        <span>Source: <strong className="font-mono text-slate-700">{binding.source}</strong></span>
                        {binding.last_synced_at && (
                          <>
                            <span className="text-slate-300">•</span>
                            <span>Last sync: {new Date(binding.last_synced_at).toLocaleString()}</span>
                          </>
                        )}
                      </div>
                    </div>

                    <button
                      disabled={busy}
                      className={buttonSecondaryClass}
                      onClick={() =>
                        void run(async () => {
                          await api.post(`/system/bindings/${binding.id}/sync`, { idempotency_key: crypto.randomUUID() });
                          setMessage('Sync job queued. Monitor real-time progress in Sync Jobs tab.');
                        })
                      }
                    >
                      ▶ Start Sync Now
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* TAB: Sync Jobs (Fixed ? characters) */}
      {tab === 'Sync Jobs' && (
        <section className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3.5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xs font-bold text-slate-900">Ingestion & Indexing Pipeline Jobs</h2>
              <p className="text-xs text-slate-500 mt-0.5">Live background queue polling every 3 seconds</p>
            </div>
            <button
              className={buttonSecondaryClass}
              onClick={() => void run(async () => setJobs(await listJobs()))}
            >
              🔄 Refresh
            </button>
          </div>

          {!jobs.length ? (
            <div className="text-center py-12 text-slate-500">
              <p className="text-sm">No pipeline jobs have been queued yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {jobs.map(job => (
                <div key={job.id} className="border border-slate-200/80 rounded-xl p-4 bg-slate-50/50 hover:bg-white transition-all space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <span className="font-semibold text-slate-900 text-sm capitalize">{job.kind.replace('_', ' ')}</span>
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                          job.state === 'completed'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : job.state === 'running'
                            ? 'bg-blue-50 text-blue-700 border-blue-200 animate-pulse'
                            : job.state === 'failed'
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-slate-100 text-slate-600 border-slate-200'
                        }`}
                      >
                        {job.state.toUpperCase()}
                      </span>
                      <span className="text-xs font-medium text-slate-500 bg-white px-2 py-0.5 rounded border border-slate-200">
                        Stage: {job.stage}
                      </span>
                    </div>

                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span>Attempts: <strong className="text-slate-700">{job.attempts}</strong></span>
                      <span className="text-slate-300">•</span>
                      <span>{new Date(job.updated_at).toLocaleTimeString()}</span>
                    </div>
                  </div>

                  {job.error && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800 font-mono">
                      {job.error}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    {['queued', 'running'].includes(job.state) && (
                      <button
                        className={buttonSecondaryClass}
                        onClick={() =>
                          void run(async () => {
                            await api.post(`/system/jobs/${job.id}/cancel`);
                            setJobs(await listJobs());
                          })
                        }
                      >
                        Cancel Job
                      </button>
                    )}
                    {['failed', 'cancelled'].includes(job.state) && (
                      <button
                        className={buttonSecondaryClass}
                        onClick={() =>
                          void run(async () => {
                            await api.post(`/system/jobs/${job.id}/retry`);
                            setJobs(await listJobs());
                          })
                        }
                      >
                        Retry Job
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* TAB: AI Configuration (Fixed ? characters) */}
      {tab === 'AI Configuration' && ai && (
        <section className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-xs font-bold text-slate-900">Generative AI & LLM Inference Settings</h2>
            <p className="text-xs text-slate-500 mt-0.5">Control base models, context windows, and vector embedding pipelines</p>
          </div>

          {/* Credentials Status Badges */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900 text-sm">NVIDIA AI Foundation</p>
                <p className="text-xs text-slate-500">Direct NIM & Cloud Endpoints</p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  ai.nvidia_credentials_configured
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${ai.nvidia_credentials_configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {ai.nvidia_credentials_configured ? 'Configured & Active' : 'Not Configured'}
              </span>
            </div>

            <div className="p-4 rounded-xl border border-slate-200/80 bg-slate-50/60 flex items-center justify-between">
              <div>
                <p className="font-semibold text-slate-900 text-sm">SAP AI Core</p>
                <p className="text-xs text-slate-500">BTP Enterprise Destination</p>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  ai.aicore_credentials_configured
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${ai.aicore_credentials_configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {ai.aicore_credentials_configured ? 'Configured & Active' : 'Not Configured'}
              </span>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            {['llm_model', 'embedding_model', 'max_tokens', 'temperature'].map(field => (
              <div key={field}>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {field.replaceAll('_', ' ')}
                </label>
                <input
                  className={inputClass}
                  value={ai[field]}
                  onChange={e =>
                    setAI({
                      ...ai,
                      [field]: ['max_tokens', 'temperature'].includes(field) ? Number(e.target.value) : e.target.value,
                    })
                  }
                />
              </div>
            ))}
          </div>

          <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Embedding changes require vector re-indexing for historical datasets. Active requests retain their current models.
          </div>

          <button
            disabled={busy}
            className={buttonPrimaryClass}
            onClick={() =>
              void run(async () => {
                const { llm_model, embedding_model, max_tokens, temperature } = ai;
                setAI((await api.put('/system/ai', { llm_model, embedding_model, max_tokens, temperature })).data);
                setMessage('AI configuration saved successfully.');
              })
            }
          >
            Save AI Parameters
          </button>
        </section>
      )}

      {/* TAB: Storage & Retention (Fixed ? characters) */}
      {tab === 'Storage & Retention' && storage && (
        <section className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-xs font-bold text-slate-900">Storage Backends & Snapshot Retention</h2>
            <p className="text-xs text-slate-500 mt-0.5">Control storage tiers and automatic dataset pruning policies</p>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/60">
              <span className="text-[11px] font-medium text-slate-500">Metadata Backend</span>
              <p className="font-bold text-slate-900 text-sm mt-1">{storage.metadata_backend}</p>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/60">
              <span className="text-[11px] font-medium text-slate-500">Dataset Catalog</span>
              <p className="font-bold text-slate-900 text-sm mt-1">{storage.dataset_backend}</p>
            </div>
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/60">
              <span className="text-[11px] font-medium text-slate-500">Object Store</span>
              <p className="font-bold text-slate-900 text-sm mt-1">{storage.object_backend}</p>
            </div>
          </div>

          <div className="max-w-md">
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Maximum Retained Versions (0 retains all)
            </label>
            <input
              type="number"
              min={0}
              className={inputClass}
              value={storage.max_versions}
              onChange={e => setStorage({ ...storage, max_versions: Number(e.target.value) })}
            />
          </div>

          {storage.retention_note && (
            <p className="text-xs text-slate-500">{storage.retention_note}</p>
          )}

          <button
            disabled={busy}
            className={buttonPrimaryClass}
            onClick={() =>
              void run(async () => {
                setStorage((await api.put('/system/storage', { max_versions: storage.max_versions })).data);
                setMessage('Retention policy updated.');
              })
            }
          >
            Save Retention Policy
          </button>
        </section>
      )}

      {/* TAB: Access & Audit (Fixed ? characters) */}
      {tab === 'Access & Audit' && (
        <section className="bg-white border border-slate-200/80 rounded-2xl p-6 shadow-sm space-y-6">
          <div>
            <h2 className="text-xs font-bold text-slate-900">Access Governance & Security Audit Trail</h2>
            <p className="text-xs text-slate-500 mt-0.5">Immutable audit logging for compliance and RBAC access verification</p>
          </div>

          {access && (
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-slate-600">
                  Active Workspace: <strong className="text-slate-900">{access.workspace_id}</strong>
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-xs text-slate-600">
                  Assigned Roles: <strong className="text-blue-700">{access.roles.join(', ')}</strong>
                </span>
              </div>
              <p className="text-xs text-slate-500">{access.policy}</p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-bold text-slate-900 mb-3">Recent Security & Mutation Events</h3>
            <div className="border border-slate-200/80 rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-100/80 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                    <tr>
                      <th className="py-3 px-4">Timestamp</th>
                      <th className="py-3 px-4">User Account</th>
                      <th className="py-3 px-4">Action</th>
                      <th className="py-3 px-4">Target Resource</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {audit.map((item, index) => (
                      <tr key={index} className="hover:bg-slate-50/80 transition-colors">
                        <td className="py-2.5 px-4 font-mono text-slate-600 whitespace-nowrap">{item.timestamp}</td>
                        <td className="py-2.5 px-4 font-medium text-slate-900">{item.user_id}</td>
                        <td className="py-2.5 px-4">
                          <span className="inline-flex px-2 py-0.5 rounded font-mono text-[11px] font-semibold bg-slate-100 text-slate-800">
                            {item.action}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 font-mono text-slate-600">{item.resource}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
