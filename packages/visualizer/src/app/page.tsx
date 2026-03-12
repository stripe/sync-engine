'use client'

import dynamic from 'next/dynamic'

const ExplorerClient = dynamic(() => import('./ExplorerClient'), {
  ssr: false,
  loading: () => <ExplorerLoadingSkeleton />,
})

export default function VisualizerPage() {
  return <ExplorerClient />
}

function ExplorerLoadingSkeleton() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      <aside className="flex h-full w-72 min-w-0 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 bg-white px-4 py-4">
          <div className="h-3 w-16 animate-pulse rounded bg-indigo-200" />
          <div className="mt-3 h-4 w-20 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-hidden p-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-100 bg-white px-3 py-2.5">
              <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
              <div className="mt-2 h-2.5 w-1/3 animate-pulse rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden bg-slate-100/70 p-3">
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-[0_12px_28px_-22px_rgba(15,23,42,0.28)]">
          <section className="flex min-h-0 flex-[44] flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 text-slate-900">
              <div>
                <div className="h-3 w-12 animate-pulse rounded bg-indigo-200" />
                <div className="mt-2 h-4 w-24 animate-pulse rounded bg-slate-200" />
              </div>
              <div className="h-11 w-32 animate-pulse rounded-xl bg-indigo-200" />
            </div>
            <div className="flex flex-1 flex-col gap-3 p-4">
              <div className="h-4 w-full animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-4/5 animate-pulse rounded bg-slate-100" />
              <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
            </div>
          </section>

          <div className="relative flex h-4 items-center justify-center bg-white">
            <div className="h-px w-full bg-slate-200" />
            <div className="absolute flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
            </div>
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 text-slate-900">
              <div>
                <div className="h-3 w-16 animate-pulse rounded bg-indigo-200" />
                <div className="mt-2 h-4 w-28 animate-pulse rounded bg-slate-200" />
              </div>
              <div className="h-6 w-16 animate-pulse rounded-full bg-slate-200" />
            </div>
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
                <p className="text-sm text-slate-500">Loading visualizer...</p>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
