import { useEffect, useState } from "react";

// The browser's own connectivity signal (navigator.onLine + the
// online/offline window events) - the mechanism
// docs/FLUTTER_CLIENT_SPEC.md Section 9.4 assumes a real client has
// (Flutter's connectivity_plus package does the equivalent). This is the
// single source of truth every offline-aware component in this app reads
// from, rather than each guessing connectivity from its own failed
// fetches.
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}
