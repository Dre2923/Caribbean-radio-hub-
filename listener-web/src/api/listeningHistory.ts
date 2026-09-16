import { apiFetch } from "./client";
import type { ListeningHistoryEntry, Pagination } from "./types";

export async function recordListen(stationId: number): Promise<ListeningHistoryEntry> {
  const { entry } = await apiFetch<{ entry: ListeningHistoryEntry }>("/v1/me/listening-history", {
    method: "POST",
    body: { stationId },
  });
  return entry;
}

export function listListeningHistory(): Promise<{ entries: ListeningHistoryEntry[]; pagination: Pagination }> {
  return apiFetch("/v1/me/listening-history");
}

export function clearListeningHistory(): Promise<void> {
  return apiFetch("/v1/me/listening-history", { method: "DELETE" });
}
