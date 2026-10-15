import Link from "next/link";
import type { ReactNode } from "react";
import { mockCases } from "@/lib/mocks";
import { API_BASE, IS_MOCK } from "@/lib/api";

// Presentation-only tags describing the nature of each scripted alert
// (plan.md §5) — not risk scores. The two suspicious scenarios carry the
// alert dot; the deliberate honest-false-alarm cases stay quiet.
const CASE_TAGS: Record<string, { label: string; dotClass: string; labelClass: string }> = {
  "case-001": { label: "Burst pattern", dotClass: "bg-graph-ring", labelClass: "text-muted" },
  "case-002": { label: "Reported fraud", dotClass: "bg-graph-ring", labelClass: "text-muted" },
  "case-003": { label: "Anomaly flag", dotClass: "bg-faint", labelClass: "text-faint" },
  "case-004": { label: "Shared device", dotClass: "bg-faint", labelClass: "text-faint" },
};

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      className="h-4 w-4"
    >
      {children}
    </svg>
  );
}

const CAPABILITIES = [
  {
    title: "Ring detection",
    description: "Accounts tied together by shared devices and IPs, then measured for pass-through behaviour",
    algorithm: "algo.WCC",
    icon: (
      <Icon>
        <circle cx="12" cy="12" r="8.4" />
        <circle cx="12" cy="12" r="3.1" />
      </Icon>
    ),
  },
  {
    title: "Money trails",
    description: "Shortest routes between accounts, kept only when real transfers follow them in time order",
    algorithm: "algo.SPpaths",
    icon: (
      <Icon>
        <path d="M6.9 17.4C9.5 17.4 9.2 13 12 13s2.5-4.4 5.1-4.4" />
        <circle cx="4.9" cy="17.4" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="19.1" cy="8.6" r="1.6" fill="currentColor" stroke="none" />
      </Icon>
    ),
  },
  {
    title: "Shared entities",
    description: "Multi-hop pivots that link accounts through one device or IP",
    algorithm: "Cypher patterns",
    icon: (
      <Icon>
        <circle cx="5.2" cy="12" r="2.4" />
        <circle cx="18.8" cy="12" r="2.4" />
        <path d="M7.8 12h2.9M13.3 12h2.9" />
        <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      </Icon>
    ),
  },
  {
    title: "Minimum freeze, proven",
    description: "The smallest set of accounts that cuts every route — verified on a copy of the graph",
    algorithm: "algo.maxFlow + minimum cut",
    icon: (
      <Icon>
        <path d="M12 3.6v16.8M4.7 7.8l14.6 8.4M19.3 7.8 4.7 16.2" />
      </Icon>
    ),
  },
];

export default function Home() {
  return (
    <main className="app-container flex-1 py-10 lg:py-12">
      {/* Intro */}
      <section className="max-w-3xl">
        <p className="eyebrow">Graph Hacks · Track 1 — Agents that act on connected data</p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
          Investigate money movement on the graph
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          An agent investigates AML alerts on a transaction graph in FalkorDB — detecting mule rings, tracing money
          trails, and simulating the effect of freezing accounts. Every finding ties back to graph evidence.
        </p>
      </section>

      {/* Case board */}
      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="eyebrow">Case board</h2>
          <p className="text-[11px] text-faint">Four scripted cases — two suspicious, two honest false alarms</p>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {mockCases.map((c) => {
            const tag = CASE_TAGS[c.id];
            return (
              <Link
                key={c.id}
                href={`/case/${c.id}`}
                className="card group flex flex-col transition hover:border-accent-line"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-[11px] font-medium tracking-wide text-faint">{c.id}</span>
                  {tag && (
                    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${tag.labelClass}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${tag.dotClass}`} />
                      {tag.label}
                    </span>
                  )}
                </div>
                <h3 className="mt-2.5 text-[16px] font-semibold tracking-tight text-ink transition-colors group-hover:text-accent">
                  {c.title}
                </h3>
                <p className="mt-1.5 pb-5 text-[13px] leading-relaxed text-muted">{c.alert}</p>
                <span className="mt-auto flex items-center gap-1.5 border-t border-line pt-3.5 text-[12px] font-medium text-accent">
                  Open investigation
                  <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Capabilities — why the graph is load-bearing */}
      <section className="mt-10 border-t border-line pt-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Why the graph is load-bearing</h2>
          <p className="text-[12px] text-faint">Every step the agent takes is a native graph operation.</p>
        </div>
        <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4">
          {CAPABILITIES.map((cap) => (
            <div key={cap.title} className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-accent">{cap.icon}</span>
              <div className="min-w-0">
                <h3 className="text-[13px] font-medium text-ink">{cap.title}</h3>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  {cap.description} — <span className="font-mono text-[11px]">{cap.algorithm}</span>
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Data mode — stated once, compactly */}
      <footer className="mt-10 border-t border-line pb-2 pt-5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[12px] text-faint">
          {IS_MOCK ? (
            <>
              <span>Demo data — frozen fixtures</span>
              <span className="mono-tag">NEXT_PUBLIC_API_BASE_URL=mock</span>
              <span>no live backend connected</span>
            </>
          ) : (
            <>
              <span>Connected to the backend at</span>
              <span className="mono-tag">{API_BASE}</span>
            </>
          )}
        </div>
      </footer>
    </main>
  );
}
