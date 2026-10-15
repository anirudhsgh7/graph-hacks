"use client";

import { useEffect, useState } from "react";
import { health, type HealthMode } from "@/lib/api";

const DOT: Record<HealthMode, string> = {
  checking: "bg-slate-600",
  mock: "bg-sky-400",
  ok: "bg-emerald-400",
  down: "bg-rose-500",
};

const LABEL: Record<HealthMode, string> = {
  checking: "checking…",
  mock: "mock data",
  ok: "backend ok",
  down: "backend unreachable",
};

export default function StatusPill() {
  const [mode, setMode] = useState<HealthMode>("checking");
  const [detail, setDetail] = useState<string>("probing /api/health");

  useEffect(() => {
    let stop = false;
    async function poll() {
      const h = await health();
      if (stop) return;
      setMode(h.mode);
      setDetail(
        h.mode === "ok"
          ? `db: ${h.db ?? "?"} · llm: ${h.llm ?? "?"}`
          : h.mode === "mock"
            ? "NEXT_PUBLIC_API_BASE_URL=mock — frozen fixtures"
            : "free hosting may be waking up; retrying every 15s",
      );
    }
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <span
      title={detail}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-300"
    >
      <span className={`h-2 w-2 rounded-full ${DOT[mode]}`} />
      {LABEL[mode]}
    </span>
  );
}
