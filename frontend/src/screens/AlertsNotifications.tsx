import React, { useState } from 'react';

interface AlertsNotificationsProps {
  onNavigate: (path: string) => void;
}

export const AlertsNotifications: React.FC<AlertsNotificationsProps> = ({ onNavigate }) => {
  const [alerts, setAlerts] = useState([
    {
      id: 'alt-1',
      title: 'Heavy Machinery Gross Margin Compression',
      severity: 'Critical',
      time: '12m ago',
      desc: 'Gross margin fell below 35.0% threshold (realized 34.2%) due to European raw material surcharge index.',
      status: 'Active',
      color: 'bg-red-500',
    },
    {
      id: 'alt-2',
      title: 'SAP BTP Vector Buffer Exceeding 95%',
      severity: 'Warning',
      time: '48m ago',
      desc: 'In-memory buffer utilized at 98.4%. Scheduled automatic compaction will run at 02:00 UTC.',
      status: 'Acknowledged',
      color: 'bg-amber-500',
    },
    {
      id: 'alt-3',
      title: 'Robotics & Automation Outperformance',
      severity: 'Info',
      time: '2h ago',
      desc: 'SKU X-400 exceeded quarterly revenue plan by +14.8%. Auto-scaling allocation recommendations generated.',
      status: 'Resolved',
      color: 'bg-emerald-500',
    },
    {
      id: 'alt-4',
      title: 'Order SO-106760 Validation Passed',
      severity: 'Info',
      time: '5h ago',
      desc: 'Tax compliance verified across German DAX enterprise delivery pipeline.',
      status: 'Resolved',
      color: 'bg-neutral-500',
    },
  ]);

  const [filter, setFilter] = useState<'All' | 'Active' | 'Resolved'>('All');

  const filteredAlerts = alerts.filter(a => {
    if (filter === 'All') return true;
    if (filter === 'Active') return a.status === 'Active' || a.status === 'Acknowledged';
    return a.status === 'Resolved';
  });

  const toggleAcknowledge = (id: string) => {
    setAlerts(prev => prev.map(a => {
      if (a.id === id) {
        return { ...a, status: a.status === 'Active' ? 'Acknowledged' : 'Resolved' };
      }
      return a;
    }));
  };

  return (
    <div className="flex flex-col w-full max-w-[1560px] mx-auto space-y-3.5 pb-16">
      {/* Sleek Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">notifications</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">Alerts & Notifications</h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
              Real-Time Monitoring · SAP HANA Health
            </span>
            <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
              · {filteredAlerts.length} events
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button 
            onClick={() => setAlerts(prev => prev.map(a => ({ ...a, status: 'Resolved' })))}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] font-medium text-xs border border-[var(--color-border)] transition-colors shadow-[var(--shadow-2xs)] cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">done_all</span>
            <span>Mark All Resolved</span>
          </button>
        </div>
      </div>

      <div className="bg-[var(--color-surface)] p-4 rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)] flex flex-col gap-3.5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--color-border)] pb-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">System Notification Stream</span>
            <span className="px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] text-[10px] font-mono font-medium border border-[var(--color-border)]">
              {filteredAlerts.length} Events
            </span>
          </div>

          <div className="flex items-center gap-1 p-1 rounded-[var(--radius-element)] bg-[var(--color-surface-hover)] border border-[var(--color-border)] self-start sm:self-auto">
            {(['All', 'Active', 'Resolved'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`h-7 px-3 rounded-[var(--radius-inner)] text-xs font-medium transition-colors flex items-center justify-center cursor-pointer ${
                  filter === tab
                    ? 'bg-[var(--color-surface)] text-[var(--color-text-primary)] font-semibold shadow-[var(--shadow-2xs)] border border-[var(--color-border)]'
                    : 'bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          {filteredAlerts.map(alert => (
            <div 
              key={alert.id}
              className="p-3.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] transition-colors flex flex-col md:flex-row md:items-center justify-between gap-3 border border-[var(--color-border)]"
            >
              <div className="flex items-start gap-3">
                <span className={`w-2 h-2 rounded-full ${
                  alert.severity === 'Critical' ? 'bg-[var(--color-danger)]' :
                  alert.severity === 'Warning' ? 'bg-[var(--color-warning)]' :
                  'bg-[var(--color-primary)]'
                } mt-1.5 shrink-0`}></span>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs sm:text-sm font-semibold text-[var(--color-text-primary)]">{alert.title}</span>
                    <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] font-medium">
                      {alert.severity}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">{alert.time}</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1 max-w-2xl leading-relaxed">{alert.desc}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                <span className={`text-[10px] px-2 py-0.5 rounded-[var(--radius-full)] font-medium border ${
                  alert.status === 'Active' ? 'bg-[var(--color-danger-subtle)] text-[var(--color-danger)] border-[var(--color-danger-border)]' :
                  alert.status === 'Acknowledged' ? 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border-[var(--color-warning-border)]' :
                  'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]'
                }`}>
                  {alert.status}
                </span>
                {alert.status !== 'Resolved' && (
                  <button 
                    onClick={() => toggleAcknowledge(alert.id)}
                    className="px-2.5 py-1 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] text-xs font-medium border border-[var(--color-border)] transition-colors shadow-[var(--shadow-2xs)] cursor-pointer"
                  >
                    {alert.status === 'Active' ? 'Acknowledge' : 'Resolve'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
