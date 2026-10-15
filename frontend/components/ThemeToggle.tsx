"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "@/components/ThemeProvider";

// `false` during SSR and the hydration pass, `true` once running on the client.
// Lets the label become specific without a server/client hydration mismatch.
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const next = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={hydrated ? `Switch to ${next} theme` : "Toggle light or dark theme"}
      onClick={() => setTheme(next)}
    >
      {/* Sun — visible while the dark theme is active (click switches to light). */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="hidden h-4 w-4 dark:block"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2m0 15v2M2.5 12h2m15 0h2M5.3 5.3l1.4 1.4m10.6 10.6 1.4 1.4M18.7 5.3l-1.4 1.4M6.7 18.7l-1.4 1.4" />
      </svg>
      {/* Moon — visible while the light theme is active (click switches to dark). */}
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-4 w-4 dark:hidden"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8Z" />
      </svg>
    </button>
  );
}
