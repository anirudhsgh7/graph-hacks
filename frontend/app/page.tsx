import Link from "next/link";
import { mockCaseList } from "@/lib/mocks";
import { API_BASE, IS_MOCK } from "@/lib/api";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 lg:px-6">
      <section className="mb-10">
        <p className="text-xs font-medium uppercase tracking-widest text-amber-400/90">
          Graph Hacks · Track 1 · Multi-hop agent over FalkorDB
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-slate-100 sm:text-4xl">
          Investigate money movement on the graph
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-400">
          An agent works a synthetic transaction network stored in FalkorDB: it detects mule rings with community
          detection, reconstructs money trails with shortest paths, ranks cash-out hubs with PageRank, and simulates
          the impact of freezing accounts before anyone acts. Every claim is linked to the graph evidence behind it.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <span className="chip">multi-hop trails</span>
          <span className="chip">community detection</span>
          <span className="chip">max-flow freeze simulation</span>
          <span className="chip">evidence-linked findings</span>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {mockCaseList.map((c) => (
          <Link
            key={c.id}
            href={`/case/${c.id}`}
            className="card flex flex-col transition hover:border-amber-500/50"
          >
            <div className="flex items-center justify-between">
              <span className="chip font-mono">{c.id}</span>
              <span className="text-[11px] uppercase tracking-wide text-slate-500">alert</span>
            </div>
            <h2 className="mt-3 text-base font-semibold text-slate-100">{c.title}</h2>
            <p className="mt-1 flex-1 text-sm leading-relaxed text-slate-400">{c.alert}</p>
            <span className="mt-4 text-xs font-medium text-amber-400">Open investigation →</span>
          </Link>
        ))}
      </section>

      <section className="mt-10 grid gap-4 md:grid-cols-2">
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-100">Why the graph is load-bearing</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-slate-400">
            <li>Rings are communities — <span className="font-mono text-xs text-slate-300">algo.labelPropagation</span> over transfers, devices and IPs.</li>
            <li>Trails are paths — <span className="font-mono text-xs text-slate-300">algo.SPpaths</span> between victim accounts and cash-out hubs.</li>
            <li>Hubs are ranks — <span className="font-mono text-xs text-slate-300">algo.pageRank</span> on directed flows.</li>
            <li>Freeze impact is <span className="font-mono text-xs text-slate-300">algo.maxFlow</span> re-run with nodes excluded.</li>
          </ul>
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-100">Data mode</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {IS_MOCK ? (
              <>
                Running on frozen demo fixtures{" "}
                <span className="font-mono text-xs text-slate-300">(NEXT_PUBLIC_API_BASE_URL=mock)</span> — the app is
                fully explorable without a backend. Point the env var at the FastAPI service to go live.
              </>
            ) : (
              <>
                Connected to the backend at <span className="font-mono text-xs text-slate-300">{API_BASE}</span>. The
                status pill in the header reflects <span className="font-mono text-xs text-slate-300">/api/health</span>.
              </>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}
