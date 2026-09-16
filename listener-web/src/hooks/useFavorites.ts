import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  favoriteEvent,
  favoriteStation,
  listFavoriteEvents,
  listFavoriteStations,
  unfavoriteEvent,
  unfavoriteStation,
} from "../api/favorites";
import { useAuth } from "../auth/useAuth";

// Shared by every screen that shows a favorite toggle (StationCard,
// StationDetailPage, EventCard, EventDetailPage, FavoritesPage) so
// there's exactly one place that knows "is this favorited" and one place
// that invalidates the list after a real PUT/DELETE round trip - real
// server state via react-query's cache, not a client-guessed toggle.
export function useFavoriteStations() {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const enabled = status === "signed-in";

  const query = useQuery({
    queryKey: ["favorites", "stations"],
    queryFn: listFavoriteStations,
    enabled,
  });

  const favoritedIds = useMemo(
    () => new Set((query.data?.favorites ?? []).map((favorite) => favorite.station.id)),
    [query.data],
  );

  const toggle = useMutation({
    mutationFn: async (stationId: number) => {
      if (favoritedIds.has(stationId)) {
        await unfavoriteStation(stationId);
      } else {
        await favoriteStation(stationId);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["favorites", "stations"] }),
  });

  return {
    enabled,
    favorites: query.data?.favorites ?? [],
    favoritedIds,
    isLoading: query.isLoading,
    toggle: (stationId: number) => toggle.mutate(stationId),
  };
}

export function useFavoriteEvents() {
  const { status } = useAuth();
  const queryClient = useQueryClient();
  const enabled = status === "signed-in";

  const query = useQuery({
    queryKey: ["favorites", "events"],
    queryFn: listFavoriteEvents,
    enabled,
  });

  const favoritedIds = useMemo(
    () => new Set((query.data?.favorites ?? []).map((favorite) => favorite.event.id)),
    [query.data],
  );

  const toggle = useMutation({
    mutationFn: async (eventId: number) => {
      if (favoritedIds.has(eventId)) {
        await unfavoriteEvent(eventId);
      } else {
        await favoriteEvent(eventId);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["favorites", "events"] }),
  });

  return {
    enabled,
    favorites: query.data?.favorites ?? [],
    favoritedIds,
    isLoading: query.isLoading,
    toggle: (eventId: number) => toggle.mutate(eventId),
  };
}
