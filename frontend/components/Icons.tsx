// Line icons for agent steps and findings (same stroke style as the landing page).
import type { IconKey } from "@/lib/agentRun";

const PATHS: Record<IconKey, React.ReactNode> = {
  profile: (
    <>
      <circle cx="12" cy="8.5" r="3.4" />
      <path d="M5.5 19.2c1.2-3.3 3.6-4.9 6.5-4.9s5.3 1.6 6.5 4.9" />
    </>
  ),
  link: (
    <>
      <rect x="8.6" y="3.6" width="6.8" height="11" rx="1.6" />
      <path d="M12 12.4h.01M6 19.6c1.4-1.8 3.4-2.7 6-2.7s4.6.9 6 2.7" />
    </>
  ),
  ring: (
    <>
      <circle cx="12" cy="5.6" r="2" />
      <circle cx="5.8" cy="16.6" r="2" />
      <circle cx="18.2" cy="16.6" r="2" />
      <path d="M10.9 7.3 6.9 14.9M13.1 7.3l4 7.6M7.8 16.6h8.4" />
    </>
  ),
  layers: (
    <>
      <path d="m12 4 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
    </>
  ),
  trail: (
    <>
      <circle cx="5" cy="17.5" r="1.8" />
      <circle cx="19" cy="6.5" r="1.8" />
      <path d="M6.8 17.5c3.4 0 2.6-5.5 5.2-5.5s1.8-5.5 5.2-5.5" />
    </>
  ),
  flow: (
    <>
      <path d="M3.5 8h11M3.5 12h14M3.5 16h11" />
      <path d="m16.5 5.5 3 2.5-3 2.5M18.5 13.5l2 2.5-2 2.5" />
    </>
  ),
  cut: (
    <>
      <circle cx="6.5" cy="7" r="2.4" />
      <circle cx="6.5" cy="17" r="2.4" />
      <path d="M8.6 8.3 19.5 17M8.6 15.7 19.5 7" />
    </>
  ),
  flask: (
    <>
      <path d="M9.5 3.8h5M10.4 3.8v5.6L5.6 18a1.5 1.5 0 0 0 1.3 2.2h10.2a1.5 1.5 0 0 0 1.3-2.2l-4.8-8.6V3.8" />
      <path d="M8 14.6h8" />
    </>
  ),
  rank: <path d="M5 19.5v-6M10 19.5v-10M15 19.5v-14M20 19.5v-8" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.8" />
      <path d="m15 15 5 5" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.4 6.4 17.6 17.6" />
    </>
  ),
};

export function StepIcon({ name, className = "h-4 w-4" }: { name: IconKey; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}

export function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </svg>
  );
}
