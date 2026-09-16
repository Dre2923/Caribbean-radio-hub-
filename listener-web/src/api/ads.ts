import { apiFetch } from "./client";
import type { AdPlacement } from "./types";

// GET /v1/ads/config - public. Returns only currently-active placements
// visible to this country (backend/src/routes/ads.ts). This backend never
// serves or hosts ad creative itself (docs/ARCHITECTURE_PLAN.md's scoped
// "configuration only" role) - a real deployment would hand these ad unit
// ids to a real mobile mediation SDK, which has no browser equivalent
// here. See PROTOTYPE_PLAN.md Phase 2's ad surfaces row for the full
// reasoning behind this client's honest placeholder-slot approach.
export async function getAdsConfig(countryId: number): Promise<AdPlacement[]> {
  const { placements } = await apiFetch<{ placements: AdPlacement[] }>(
    `/v1/ads/config?countryId=${countryId}`,
  );
  return placements;
}

// POST /v1/ads/events - public, rate-limited 60/min. Records a real
// first-party impression/click for a placement this client actually
// rendered - never fabricated, never fired for a slot that wasn't shown.
export function recordAdEvent(
  placementId: number,
  eventType: "impression" | "click",
  countryId?: number,
): Promise<void> {
  return apiFetch("/v1/ads/events", {
    method: "POST",
    body: { placementId, eventType, countryId },
  });
}
