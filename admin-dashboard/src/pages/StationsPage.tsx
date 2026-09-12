import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteStation, listAdminStations, setStationActive } from "../api/stations";
import { listCountries, listGenres, listLanguages } from "../api/lookups";
import { ApiError } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { StatusBadge } from "../components/StatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Station } from "../api/types";

const PAGE_SIZE = 20;
// Reference data (countries/genres/languages) changes rarely if ever at
// runtime - a long staleTime avoids refetching it on every filter change
// within the same session, unlike the stations list itself.
const REFERENCE_DATA_STALE_TIME = 5 * 60_000;

type ActiveFilter = "all" | "active" | "inactive";

type PendingAction =
  | { type: "deactivate"; station: Station }
  | { type: "reactivate"; station: Station }
  | { type: "delete"; station: Station };

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function StationsPage() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [countryId, setCountryId] = useState<number | "">("");
  const [genreId, setGenreId] = useState<number | "">("");
  const [languageId, setLanguageId] = useState<number | "">("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("all");
  const [offset, setOffset] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const search = useDebouncedValue(searchInput, 300);

  const { data: countries } = useQuery({
    queryKey: ["countries"],
    queryFn: listCountries,
    staleTime: REFERENCE_DATA_STALE_TIME,
  });
  const { data: genres } = useQuery({
    queryKey: ["genres"],
    queryFn: listGenres,
    staleTime: REFERENCE_DATA_STALE_TIME,
  });
  const { data: languages } = useQuery({
    queryKey: ["languages"],
    queryFn: listLanguages,
    staleTime: REFERENCE_DATA_STALE_TIME,
  });

  const queryParams = useMemo(
    () => ({
      q: search.trim() || undefined,
      countryId: countryId === "" ? undefined : countryId,
      genreId: genreId === "" ? undefined : genreId,
      languageId: languageId === "" ? undefined : languageId,
      isActive: activeFilter === "all" ? undefined : activeFilter === "active",
      limit: PAGE_SIZE,
      offset,
    }),
    [search, countryId, genreId, languageId, activeFilter, offset],
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-stations", queryParams],
    queryFn: () => listAdminStations(queryParams),
    placeholderData: (previous) => previous,
  });

  const setActiveMutation = useMutation({
    mutationFn: setStationActive,
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-stations"] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to update station.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStation,
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-stations"] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete station.");
    },
  });

  const isMutating = setActiveMutation.isPending || deleteMutation.isPending;

  function openAction(action: PendingAction) {
    setActionError(null);
    setReasonInput("");
    setPending(action);
  }

  function resetFiltersOffset() {
    setOffset(0);
  }

  function confirmPending() {
    if (!pending) return;
    if (pending.type === "deactivate") {
      setActiveMutation.mutate({
        id: pending.station.id,
        isActive: false,
        deactivationReason: reasonInput.trim() || undefined,
      });
    } else if (pending.type === "reactivate") {
      setActiveMutation.mutate({ id: pending.station.id, isActive: true });
    } else {
      deleteMutation.mutate(pending.station.id);
    }
  }

  const total = data?.pagination.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Stations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Search and curate the radio station catalog. Deactivating pulls a station from the
          public catalog without losing its history - prefer it over deleting for routine
          curation.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
            resetFiltersOffset();
          }}
          placeholder="Search by name…"
          className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <select
          value={countryId}
          onChange={(event) => {
            setCountryId(event.target.value === "" ? "" : Number(event.target.value));
            resetFiltersOffset();
          }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All countries</option>
          {countries?.map((country) => (
            <option key={country.id} value={country.id}>
              {country.name}
            </option>
          ))}
        </select>
        <select
          value={genreId}
          onChange={(event) => {
            setGenreId(event.target.value === "" ? "" : Number(event.target.value));
            resetFiltersOffset();
          }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All genres</option>
          {genres?.map((genre) => (
            <option key={genre.id} value={genre.id}>
              {genre.name}
            </option>
          ))}
        </select>
        <select
          value={languageId}
          onChange={(event) => {
            setLanguageId(event.target.value === "" ? "" : Number(event.target.value));
            resetFiltersOffset();
          }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All languages</option>
          {languages?.map((language) => (
            <option key={language.id} value={language.id}>
              {language.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {(["all", "active", "inactive"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setActiveFilter(option);
                resetFiltersOffset();
              }}
              className={
                "rounded px-3 py-1 text-sm font-medium capitalize transition-colors " +
                (activeFilter === option
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Station
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Genres / Languages
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-slate-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  Loading stations…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-red-600">
                  {error instanceof ApiError ? error.message : "Failed to load stations."}
                </td>
              </tr>
            )}
            {!isLoading && !isError && data?.stations.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No stations match this filter.
                </td>
              </tr>
            )}
            {data?.stations.map((station) => (
              <tr key={station.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{station.name}</div>
                  <div className="text-slate-500">{station.streamUrl}</div>
                  {!station.isActive && station.deactivationReason && (
                    <div className="mt-1 text-xs text-slate-400">
                      Deactivated {formatDate(station.deactivatedAt)}: {station.deactivationReason}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge isActive={station.isActive} />
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {[...station.genres.map((g) => g.name), ...station.languages.map((l) => l.name)].join(", ") ||
                    "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    {station.isActive ? (
                      <button
                        type="button"
                        onClick={() => openAction({ type: "deactivate", station })}
                        className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openAction({ type: "reactivate", station })}
                        className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Reactivate
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openAction({ type: "delete", station })}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
        <span>{total === 0 ? "No results" : `Showing ${rangeStart}-${rangeEnd} of ${total}`}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            disabled={offset === 0}
            className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setOffset((current) => current + PAGE_SIZE)}
            disabled={rangeEnd >= total}
            className="rounded-md border border-slate-200 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.type === "deactivate"
            ? "Deactivate station?"
            : pending?.type === "reactivate"
              ? "Reactivate station?"
              : "Permanently delete station?"
        }
        description={
          pending && (
            <>
              {pending.type === "deactivate" && (
                <>
                  <strong>{pending.station.name}</strong> will be pulled from the public catalog.
                  Its history is kept - this can be reversed at any time.
                </>
              )}
              {pending.type === "reactivate" && (
                <>
                  <strong>{pending.station.name}</strong> will reappear in the public catalog, and
                  its deactivation record will be cleared.
                </>
              )}
              {pending.type === "delete" && (
                <>
                  <strong>{pending.station.name}</strong> and its full history will be permanently
                  deleted. This cannot be undone - consider Deactivate instead for routine
                  curation.
                </>
              )}
            </>
          )
        }
        confirmLabel={
          pending?.type === "deactivate" ? "Deactivate" : pending?.type === "reactivate" ? "Reactivate" : "Delete"
        }
        danger={pending?.type !== "reactivate"}
        pending={isMutating}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      >
        {pending?.type === "deactivate" && (
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Reason (optional)</span>
            <textarea
              value={reasonInput}
              onChange={(event) => setReasonInput(event.target.value)}
              rows={2}
              placeholder="e.g. Duplicate of another listed station"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}
