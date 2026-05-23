"use client";

// A skeleton that structurally matches the real Dashboard layout —
// shapes must be identical to what loads, so there's zero layout shift.

function SkeletonBlock({
  className,
  style,
}: {
  className?: string;
  style?:     React.CSSProperties;
}) {
  return <div className={`skeleton ${className ?? ""}`} style={style} />;
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-surface-03/75 p-5 shadow-e2">
      {children}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading dashboard">

      {/* Welcome card */}
      <CardShell>
        <div className="flex items-center gap-2.5 py-0.5">
          <SkeletonBlock className="h-3.5 w-3.5 rounded-full" />
          <SkeletonBlock className="h-3.5 w-64" />
        </div>
      </CardShell>

      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <CardShell key={i}>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-3 flex-1">
                <SkeletonBlock className="h-2.5 w-20" />
                <SkeletonBlock className="h-8 w-16" />
                <SkeletonBlock className="h-2 w-24" />
              </div>
              <SkeletonBlock className="h-11 w-11 rounded-xl shrink-0" />
            </div>
          </CardShell>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <CardShell key={i}>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <SkeletonBlock className="h-3.5 w-36" />
                <SkeletonBlock className="h-4 w-4 rounded" />
              </div>
              {/* Fake chart bars */}
              <div className="flex items-end justify-between gap-2 h-[200px] pt-4">
                {Array.from({ length: 7 }).map((_, j) => (
                  <SkeletonBlock
                    key={j}
                    className="flex-1 rounded-t"
                    style={{
                      height: `${30 + Math.abs(Math.sin(j * 1.3 + i)) * 55}%`,
                    } as React.CSSProperties}
                  />
                ))}
              </div>
            </div>
          </CardShell>
        ))}
      </div>

      {/* Heatmap */}
      <CardShell>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <SkeletonBlock className="h-3.5 w-48" />
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-3 w-3 rounded-sm" />
              ))}
            </div>
          </div>
          <div
            className="grid min-w-[640px] gap-1.5 overflow-x-auto"
            style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
          >
            {Array.from({ length: 30 }).map((_, i) => (
              <div key={i} className="flex flex-col items-center gap-1">
                <SkeletonBlock className="h-3.5 w-3.5 rounded-sm" />
                <SkeletonBlock className="h-2 w-3 rounded" />
              </div>
            ))}
          </div>
        </div>
      </CardShell>

    </div>
  );
}
