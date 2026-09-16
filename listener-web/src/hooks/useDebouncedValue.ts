import { useEffect, useState } from "react";

// Identical to admin-dashboard/src/hooks/useDebouncedValue.ts - reused
// as its own copy rather than a cross-project import, since the two are
// genuinely separate deployable apps sharing a convention, not a shared
// package (see PROTOTYPE_PLAN.md's "Files / components used").
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
