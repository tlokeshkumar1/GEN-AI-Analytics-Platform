export function PersonalDashboardSkeleton() {
  const card = 'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)]';

  return (
    <div role="status" aria-label="Loading dashboard" aria-busy="true" className="space-y-3.5 motion-safe:animate-pulse">
      <span className="sr-only">Loading dashboard…</span>
      <div aria-hidden="true" className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={`${card} h-24`} />
        ))}
      </div>
      <div aria-hidden="true" className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className={`${card} h-72`} />
        ))}
      </div>
    </div>
  );
}
