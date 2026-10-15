// Theme preference plumbing — shared by the pre-hydration inline script in
// app/layout.tsx and the ThemeProvider client component. Keep this module
// dependency-free and safe to import from both server and client code.

export const THEME_STORAGE_KEY = "ftm-theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

// Runs synchronously in <head> before the first paint (pattern from the Next.js
// guide "How to prevent flash before hydration"). Toggles the `dark` class and
// sets `color-scheme` on <html> so the server-rendered shell never flashes the
// wrong theme. Matches the logic in ThemeProvider exactly.
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
