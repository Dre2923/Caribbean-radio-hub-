import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deleteEvent, listAdminEvents, moderateEvent } from "../api/events";
import { listCountries, listEventCategories } from "../api/lookups";
import { ApiError } from "../api/client";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { EventStatusBadge } from "../components/EventStatusBadge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import type { Event, EventStatus } from "../api/types";

const PAGE_SIZE = 20;
const REFERENCE_DATA_STALE_TIME = 5 * 60_000;

type StatusFilter = "all" | EventStatus;

type PendingAction =
  | { type: "approve"; event: Event }
  | { type: "reject"; event: Event }
  | { type: "delete"; event: Event };

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function EventsPage() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [countryId, setCountryId] = useState<number | "">("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [upcomingOnly, setUpcomingOnly] = useState(false);
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
  const { data: categories } = useQuery({
    queryKey: ["event-categories"],
    queryFn: listEventCategories,
    staleTime: REFERENCE_DATA_STALE_TIME,
  });

  const queryParams = useMemo(
    () => ({
      q: search.trim() || undefined,
      countryId: countryId === "" ? undefined : countryId,
      categoryId: categoryId === "" ? undefined : categoryId,
      status: statusFilter === "all" ? undefined : statusFilter,
      upcomingOnly: upcomingOnly || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [search, countryId, categoryId, statusFilter, upcomingOnly, offset],
  );

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin-events", queryParams],
    queryFn: () => listAdminEvents(queryParams),
    placeholderData: (previous) => previous,
  });

  const moderateMutation = useMutation({
    mutationFn: moderateEvent,
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-events"] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to update event.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteEvent,
    onSuccess: () => {
      setPending(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-events"] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof ApiError ? err.message : "Failed to delete event.");
    },
  });

  const isMutating = moderateMutation.isPending || deleteMutation.isPending;

  function openAction(action: PendingAction) {
    setActionError(null);
    setReasonInput("");
    setPending(action);
  }

  function resetOffset() {
    setOffset(0);
  }

  function confirmPending() {
    if (!pending) return;
    if (pending.type === "approve") {
      moderateMutation.mutate({ id: pending.event.id, status: "approved" });
    } else if (pending.type === "reject") {
      moderateMutation.mutate({
        id: pending.event.id,
        status: "rejected",
        moderationReason: reasonInput.trim() || undefined,
      });
    } else {
      deleteMutation.mutate(pending.event.id);
    }
  }

  const total = data?.pagination.total ?? 0;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Events</h1>
        <p className="mt-1 text-sm text-slate-500">
          Moderate submitted events. A regular user's submission starts pending and is hidden
          from the public listing until approved.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchInput}
          onChange={(event) => {
            setSearchInput(event.target.value);
            resetOffset();
          }}
          placeholder="Search by title…"
          className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <select
          value={countryId}
          onChange={(event) => {
            setCountryId(event.target.value === "" ? "" : Number(event.target.value));
            resetOffset();
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
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value === "" ? "" : Number(event.target.value));
            resetOffset();
          }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">All categories</option>
          {categories?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <div className="flex gap-1 rounded-md bg-slate-100 p-1">
          {(["all", "pending", "approved", "rejected"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setStatusFilter(option);
                resetOffset();
              }}
              className={
                "rounded px-3 py-1 text-sm font-medium capitalize transition-colors " +
                (statusFilter === option
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700")
              }
            >
              {option}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={upcomingOnly}
            onChange={(event) => {
              setUpcomingOnly(event.target.checked);
              resetOffset();
            }}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Upcoming only
        </label>
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
                Event
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-left font-medium text-slate-500">
                Categories
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
                  Loading events…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-red-600">
                  {error instanceof ApiError ? error.message : "Failed to load events."}
                </td>
              </tr>
            )}
            {!isLoading && !isError && data?.events.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400">
                  No events match this filter.
                </td>
              </tr>
            )}
            {data?.events.map((event) => (
              <tr key={event.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{event.title}</div>
                  <div className="text-slate-500">
                    {event.venue ? `${event.venue} · ` : ""}
                    {formatDateTime(event.startsAt)}
                  </div>
                  {event.status === "rejected" && event.moderationReason && (
                    <div className="mt-1 text-xs text-slate-400">
                      Rejected {formatDateTime(event.moderatedAt)}: {event.moderationReason}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <EventStatusBadge status={event.status} />
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {event.categories.map((c) => c.name).join(", ") || "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    {event.status !== "approved" && (
                      <button
                        type="button"
                        onClick={() => openAction({ type: "approve", event })}
                        className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Approve
                      </button>
                    )}
                    {event.status !== "rejected" && (
                      <button
                        type="button"
                        onClick={() => openAction({ type: "reject", event })}
                        className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Reject
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openAction({ type: "delete", event })}
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
          pending?.type === "approve"
            ? "Approve event?"
            : pending?.type === "reject"
              ? "Reject event?"
              : "Permanently delete event?"
        }
        description={
          pending && (
            <>
              {pending.type === "approve" && (
                <>
                  <strong>{pending.event.title}</strong> will become publicly visible.
                </>
              )}
              {pending.type === "reject" && (
                <>
                  <strong>{pending.event.title}</strong> will be hidden from the public listing.
                  Its history is kept - this can be reversed at any time.
                </>
              )}
              {pending.type === "delete" && (
                <>
                  <strong>{pending.event.title}</strong> and its full history will be permanently
                  deleted. This cannot be undone - consider Reject instead for routine moderation.
                </>
              )}
            </>
          )
        }
        confirmLabel={pending?.type === "approve" ? "Approve" : pending?.type === "reject" ? "Reject" : "Delete"}
        danger={pending?.type !== "approve"}
        pending={isMutating}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      >
        {pending?.type === "reject" && (
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Reason (optional)</span>
            <textarea
              value={reasonInput}
              onChange={(event) => setReasonInput(event.target.value)}
              rows={2}
              placeholder="e.g. Duplicate submission"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}
