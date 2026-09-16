// Powers the "last updated [time]" label docs/FLUTTER_CLIENT_SPEC.md
// Section 9.4 requires on cached list views, so a long-offline user isn't
// misled into thinking a stale list is current.
export function formatRelativeTime(isoTimestamp: string): string {
  const deltaMs = Date.now() - new Date(isoTimestamp).getTime();
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
