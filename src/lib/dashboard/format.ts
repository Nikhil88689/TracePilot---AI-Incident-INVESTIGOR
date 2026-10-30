const numberFormat = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
  return numberFormat.format(value);
}

export function formatPercent(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Signed percentage change, e.g. "+8.2%" / "-3.0%". */
export function formatChange(percent: number): string {
  const sign = percent > 0 ? "+" : percent < 0 ? "-" : "";
  return `${sign}${Math.abs(percent).toFixed(1)}%`;
}

/**
 * Relative time computed against a caller-supplied "now" (not Date.now()), so server and
 * client render identical text and there is no hydration mismatch.
 */
export function formatRelative(iso: string, nowIso: string): string {
  const diffSec = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(iso)) / 1000));
  if (diffSec < 45) return "just now";
  const minutes = Math.round(diffSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return (letters || "?").toUpperCase();
}
