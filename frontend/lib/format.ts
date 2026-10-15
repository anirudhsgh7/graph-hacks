export function formatMoney(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function truncate(s: string, n = 72): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
