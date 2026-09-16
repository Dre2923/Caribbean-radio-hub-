import { useEffect, useState } from "react";

const STORAGE_KEY = "crh-selected-country-id";

// docs/FLUTTER_CLIENT_SPEC.md Section 6.1's Home screen sources its
// country from the signed-in user's own profile (GET /v1/me); this slice
// has no authentication (see PROTOTYPE_PLAN.md's "Features excluded"), so
// the visitor picks a country instead, remembered across visits the same
// way a returning user's own preference would be - this is a deliberate,
// documented adaptation of that section, not a deviation from it.
export function useSelectedCountry(): [number | null, (id: number | null) => void] {
  const [countryId, setCountryIdState] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? Number(raw) : null;
    } catch {
      return null;
    }
  });

  const setCountryId = (id: number | null) => {
    setCountryIdState(id);
    try {
      if (id === null) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, String(id));
      }
    } catch {
      // Best-effort only - losing the remembered preference is never
      // worth crashing over.
    }
  };

  return [countryId, setCountryId];
}

// A tiny convenience so a page can react once real countries load and
// none is yet selected - default to the first, rather than leaving every
// list empty until the visitor manually picks one.
export function useDefaultCountry(
  countryId: number | null,
  setCountryId: (id: number | null) => void,
  firstAvailableId: number | undefined,
): void {
  useEffect(() => {
    if (countryId === null && firstAvailableId !== undefined) {
      setCountryId(firstAvailableId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setCountryId is stable enough for this one-shot default; re-running on it would fight the visitor's own selection
  }, [countryId, firstAvailableId]);
}
