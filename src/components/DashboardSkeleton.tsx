"use client";

import { GlassCard } from "./GlassCard";

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      {/* Welcome Card Skeleton */}
      <GlassCard>
        <div className="flex items-center gap-2 py-1 animate-pulse">
          <div className="h-4 w-4 rounded-full bg-emerald-500/20" />
          <div className="h-4 w-72 rounded bg-white/5" />
        </div>
      </GlassCard>

      {/* Stats Cards Skeleton Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <GlassCard key={i}>
            <div className="flex items-center justify-between animate-pulse">
              <div className="space-y-3">
                <div className="h-3 w-28 rounded bg-white/5" />
                <div className="h-7 w-20 rounded bg-white/10" />
              </div>
              <div className="h-10 w-10 rounded bg-[#E95420]/10" />
            </div>
          </GlassCard>
        ))}
      </div>

      {/* Charts Grid Skeleton */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Chart 1 */}
        <GlassCard>
          <div className="space-y-4 animate-pulse">
            <div className="h-4 w-40 rounded bg-white/5" />
            <div className="w-full h-[220px] rounded bg-white/5 flex items-end justify-between p-4 gap-2">
              {[...Array(7)].map((_, idx) => (
                <div 
                  key={idx} 
                  className="w-full bg-white/10 rounded-t" 
                  style={{ height: `${20 + Math.sin(idx) * 40}%` }}
                />
              ))}
            </div>
          </div>
        </GlassCard>

        {/* Chart 2 */}
        <GlassCard>
          <div className="space-y-4 animate-pulse">
            <div className="h-4 w-40 rounded bg-white/5" />
            <div className="w-full h-[220px] rounded bg-white/5 flex items-end justify-between p-4 gap-4">
              {[...Array(5)].map((_, idx) => (
                <div 
                  key={idx} 
                  className="w-full bg-[#E95420]/20 rounded-t" 
                  style={{ height: `${30 + Math.cos(idx) * 50}%` }}
                />
              ))}
            </div>
          </div>
        </GlassCard>
      </div>

      {/* Heatmap Card Skeleton */}
      <GlassCard>
        <div className="space-y-4 animate-pulse">
          <div className="h-4 w-56 rounded bg-white/5" />
          <div className="overflow-x-auto pb-2">
            <div
              className="grid min-w-[720px] gap-2"
              style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
            >
              {[...Array(30)].map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <div className="h-4 w-4 rounded-sm bg-white/5" />
                  <div className="h-2 w-3 rounded bg-white/5" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
