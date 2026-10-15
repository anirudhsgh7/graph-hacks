import { Suspense } from "react";
import Link from "next/link";
import ShellNav from "@/components/ShellNav";
import StatusPill from "@/components/StatusPill";
import ThemeToggle from "@/components/ThemeToggle";

// Brand mark: two feeder accounts converging into one hub — the product's
// core story (mule accounts → cash-out hub), drawn as a compact funnel.
function BrandMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-[19px] w-[19px] shrink-0 text-accent">
      <path
        d="M5.9 9 10.1 14.3M18.1 9 13.9 14.3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="4.6" cy="7.3" r="2.1" fill="currentColor" />
      <circle cx="19.4" cy="7.3" r="2.1" fill="currentColor" />
      <circle cx="12" cy="16.7" r="2.5" fill="currentColor" />
    </svg>
  );
}

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="app-container flex h-14 items-center gap-3 sm:gap-4">
        <Link href="/" className="flex min-w-0 shrink-0 items-center gap-2.5">
          <BrandMark />
          <span className="flex min-w-0 flex-col leading-none">
            <span className="truncate text-[14px] font-semibold tracking-tight text-ink">Follow the Money</span>
            <span className="mt-[3px] truncate text-[10.5px] font-medium text-faint">
              AML investigation console
            </span>
          </span>
        </Link>
        {/* Next 16 (cacheComponents): URL data in a Client Component must stream
            inside a <Suspense> boundary so the static shell can prerender. */}
        <Suspense fallback={null}>
          <ShellNav />
        </Suspense>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <StatusPill />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
