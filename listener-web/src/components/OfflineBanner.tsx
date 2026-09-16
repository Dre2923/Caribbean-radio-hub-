import { useOnlineStatus } from "../hooks/useOnlineStatus";

// docs/FLUTTER_CLIENT_SPEC.md Section 9.4: "A persistent, dismissible
// banner while offline states plainly that browsing is from cached data
// and a connection is needed to listen live, with a manual retry/
// reconnect action; the client never auto-hides this banner without
// confirming connectivity has actually returned." useOnlineStatus is that
// confirmation - the banner unmounts itself only when the browser's own
// online event fires, never on a timer or an optimistic guess.
export function OfflineBanner() {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-3 bg-sunset-600 px-4 py-2 text-center text-sm font-medium text-white"
    >
      <span>
        You&apos;re offline — showing cached data. An internet connection is required to listen live.
      </span>
    </div>
  );
}
