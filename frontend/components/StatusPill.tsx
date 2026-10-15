"use client";

import { useEffect, useState } from "react";
import { health, type HealthMode, type HealthState } from "@/lib/api";

const LABEL: Record<HealthMode, string> = {
  checking: "checking status…",
  mock: "mock data",
  ok: "backend ok",
  degraded: "backend degraded",
  down: "backend unavailable",
};

// Narrow screens: same states, labels shortened just enough to fit.
const SHORT_LABEL: Record<HealthMode, string> = {
  checking: "checking…",
  mock: "mock data",
  ok: "backend ok",
  degraded: "degraded",
  down: "unavailable",
};

const ICON_TONE: Record<HealthMode, string> = {
  checking: "text-faint",
  mock: "text-info",
  ok: "text-ok",
  degraded: "text-accent",
  down: "text-danger",
};

function StatusIcon({ mode, className }: { mode: HealthMode; className: string }) {
  const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "aria-hidden": true } as const;
  const cls = `h-3.5 w-3.5 shrink-0 ${className}`;

  if (mode === "checking") {
    return (
      <svg {...base} className={`${cls} animate-spin`} strokeWidth="2" strokeLinecap="round">
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    );
  }
  if (mode === "mock") {
    // Flask — local fixtures, no live backend connected.
    return (
      <svg {...base} className={cls} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 2.5h5" />
        <path d="M10.5 2.5v6l-4.6 8.7a2.3 2.3 0 0 0 2 3.4h8.2a2.3 2.3 0 0 0 2-3.4L13.5 8.5v-6" />
        <path d="M7.2 15.5h9.6" />
      </svg>
    );
  }
  if (mode === "ok") {
    // Check in a circle — live backend healthy.
    return (
      <svg {...base} className={cls} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.4 12.3 2.4 2.4 4.8-5" />
      </svg>
    );
  }
  // Alert in a circle — degraded or unreachable.
  return (
    <svg {...base} className={cls} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.8v5.2" />
      <path d="M12 16.4h.01" />
    </svg>
  );
}

function describe(h: HealthState): string {
  if (h.mode === "ok") {
    const parts = ["db: ok"];
    if (h.accounts != null) parts.push(`${h.accounts} accounts · ${h.transfers ?? "?"} transfers`);
    parts.push(`llm: ${h.llm ?? "?"}`);
    if (h.version) parts.push(`v${h.version}`);
    return parts.join(" · ");
  }
  if (h.mode === "degraded") {
    return `db: ${h.db ?? "?"} · llm: ${h.llm ?? "?"} — the demo graph may need a reseed`;
  }
  if (h.mode === "mock") {
    return "NEXT_PUBLIC_API_BASE_URL=mock — frozen fixtures, no live backend connected";
  }
  return "free hosting may be waking up; retrying every 15s";
}

export default function StatusPill() {
  const [mode, setMode] = useState<HealthMode>("checking");
  const [detail, setDetail] = useState<string>("probing /api/health");

  useEffect(() => {
    let stop = false;
    async function poll() {
      const h = await health();
      if (stop) return;
      setMode(h.mode);
      setDetail(describe(h));
    }
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <span className="group relative inline-flex shrink-0">
      <span
        role="status"
        aria-label={`Backend status: ${LABEL[mode]}. ${detail}`}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted transition-colors group-hover:bg-raised"
      >
        <StatusIcon mode={mode} className={ICON_TONE[mode]} />
        <span className="sm:hidden">{SHORT_LABEL[mode]}</span>
        <span className="hidden sm:inline">{LABEL[mode]}</span>
      </span>
      {/* Themed tooltip — replaces the native `title` so it follows the app theme. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-30 mt-2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11px] leading-4 text-muted opacity-0 shadow-float transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {detail}
      </span>
    </span>
  );
}
