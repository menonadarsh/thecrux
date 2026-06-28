/** URI-encode each segment of a slash path, preserving separators. */
export function encodePath(p: string): string {
  return (p || "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

/** Human-readable byte size, e.g. 2048 -> "2 KB". */
export function humanSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** Compact relative time, e.g. "3 days ago". */
export function relativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  // [divisor in seconds, unit label], largest first.
  const units: [number, string][] = [
    [31557600, "year"],
    [2629800, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [divisor, label] of units) {
    if (seconds >= divisor) {
      const value = Math.floor(seconds / divisor);
      return `${value} ${label}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
