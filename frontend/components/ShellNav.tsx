"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Contextual navigation for the shell: on a case page it renders the
// breadcrumb back to the case board; everywhere else it renders nothing, so
// the header stays free of unused navigation items.
export default function ShellNav() {
  const pathname = usePathname();
  const match = pathname?.match(/^\/case\/([^/]+)/);
  if (!match) return null;
  const caseId = decodeURIComponent(match[1]);

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-line" />
      <Link
        href="/"
        aria-label="Back to case board"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M19 12H5" />
          <path d="m11 18-6-6 6-6" />
        </svg>
        <span className="hidden sm:inline">Case board</span>
      </Link>
      <span aria-hidden="true" className="hidden shrink-0 text-[11px] text-faint sm:inline">
        /
      </span>
      <span className="hidden truncate font-mono text-[11px] text-faint sm:inline">{caseId}</span>
    </nav>
  );
}
