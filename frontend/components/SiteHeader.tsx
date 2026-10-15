import Link from "next/link";
import StatusPill from "@/components/StatusPill";

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-3 lg:px-6">
        <Link href="/" className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tracking-tight text-slate-100">Follow the Money</span>
          <span className="hidden text-xs text-slate-400 sm:inline">
            AML investigation console · FalkorDB + agent
          </span>
        </Link>
        <StatusPill />
      </div>
    </header>
  );
}
