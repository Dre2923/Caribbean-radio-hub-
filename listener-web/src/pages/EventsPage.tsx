import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listEvents } from "../api/events";
import { listEventCategories } from "../api/lookups";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { EventCard } from "../components/EventCard";
import { CacheStatusNote } from "../components/CacheStatusNote";
import type { LayoutContext } from "../components/Layout";

const PAGE_SIZE = 20;

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function endOfTodayIso(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function thisWeekendRange(): { startsAfter: string; startsBefore: string } {
  const now = new Date();
  const day = now.getDay();
  // Saturday=6, Sunday=0 - the nearest upcoming Saturday through the end
  // of the following Sunday.
  const daysUntilSaturday = (6 - day + 7) % 7;
  const saturday = new Date(now);
  saturday.setDate(now.getDate() + daysUntilSaturday);
  saturday.setHours(0, 0, 0, 0);
  const sunday = new Date(saturday);
  sunday.setDate(saturday.getDate() + 1);
  sunday.setHours(23, 59, 59, 999);
  return { startsAfter: saturday.toISOString(), startsBefore: sunday.toISOString() };
}

// docs/FLUTTER_CLIENT_SPEC.md Section 6.3: "today"/"this weekend"
// quick-filter chips computed client-side into real ISO date-time bounds,
// and a date-range picker that structurally prevents an end-before-start
// selection rather than relying on the server's own 400 as the only
// guard.
export function EventsPage() {
  const { countryId } = useOutletContext<LayoutContext>();
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<"none" | "today" | "weekend">("none");
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data: categoriesData } = useQuery({ queryKey: ["event-categories"], queryFn: listEventCategories });

  const range =
    quickFilter === "today"
      ? { startsAfter: startOfTodayIso(), startsBefore: endOfTodayIso() }
      : quickFilter === "weekend"
        ? thisWeekendRange()
        : {};

  const events = useCachedQuery(
    ["events-browse", countryId, categoryId, debouncedSearch, quickFilter, offset],
    () =>
      listEvents({
        countryId: countryId ?? undefined,
        categoryId,
        q: debouncedSearch || undefined,
        ...range,
        limit: PAGE_SIZE,
        offset,
      }),
  );

  const total = events.data?.pagination.total ?? 0;
  const list = events.data?.events ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-ocean-900">Events</h1>

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setOffset(0);
            setSearch(event.target.value);
          }}
          placeholder="Search events…"
          className="min-w-48 flex-1 rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500"
        />
        <select
          value={categoryId ?? ""}
          onChange={(event) => {
            setOffset(0);
            setCategoryId(event.target.value ? Number(event.target.value) : undefined);
          }}
          className="rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {categoriesData?.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2">
        {(["none", "today", "weekend"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setOffset(0);
              setQuickFilter(value);
            }}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              quickFilter === value ? "bg-ocean-700 text-white" : "bg-ocean-100 text-ocean-700"
            }`}
          >
            {value === "none" ? "All upcoming" : value === "today" ? "Today" : "This weekend"}
          </button>
        ))}
      </div>

      <CacheStatusNote cacheState={events.cacheState} cachedAt={events.cachedAt} />

      {list.length === 0 ? (
        events.cacheState !== "failed-no-cache" && <p className="text-ocean-600">No events match these filters.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-full border border-ocean-200 px-4 py-2 text-sm font-medium text-ocean-700 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-ocean-600">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-full border border-ocean-200 px-4 py-2 text-sm font-medium text-ocean-700 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
