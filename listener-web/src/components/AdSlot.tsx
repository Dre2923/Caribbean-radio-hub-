import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAdsConfig, recordAdEvent } from "../api/ads";

// GET /v1/ads/config returns real, currently-active placements for this
// country (backend/src/routes/ads.ts) - this backend never serves or
// hosts ad creative itself (its scoped "configuration only" role, per
// docs/ARCHITECTURE_PLAN.md), so there is no real ad image/copy to show.
// This renders one honestly-labeled placeholder per active placement
// this call actually returned - nothing shown if none exist for this
// country - and fires real POST /v1/ads/events impression/click calls
// against it. See PROTOTYPE_PLAN.md Phase 2's ad-surfaces row for the
// full reasoning.
export function AdSlot({ countryId, placementKey }: { countryId: number | null; placementKey: string }) {
  const { data: placements } = useQuery({
    queryKey: ["ads-config", countryId],
    queryFn: () => getAdsConfig(countryId as number),
    enabled: countryId !== null,
    staleTime: 60_000,
  });

  const placement = placements?.find((p) => p.placementKey === placementKey) ?? null;
  const recordedImpressionForRef = useRef<number | null>(null);

  useEffect(() => {
    if (placement && recordedImpressionForRef.current !== placement.id) {
      recordedImpressionForRef.current = placement.id;
      // Fire-and-forget - a failed impression record must never affect
      // the page it's on.
      void recordAdEvent(placement.id, "impression", countryId ?? undefined).catch(() => {});
    }
  }, [placement, countryId]);

  if (!placement) return null;

  return (
    <button
      type="button"
      onClick={() => void recordAdEvent(placement.id, "click", countryId ?? undefined).catch(() => {})}
      className="block w-full rounded-xl border border-dashed border-ocean-200 bg-ocean-50 p-4 text-left transition hover:border-ocean-400"
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ocean-400">Sponsored</p>
      <p className="mt-1 text-sm text-ocean-600">
        This is a placeholder ad slot — this prototype has no ad-creative backend or mediation SDK to render a
        real ad, but this click and its impression above are recorded against the real{" "}
        <code className="text-xs">{placement.placementKey}</code> placement via the real API.
      </p>
    </button>
  );
}
