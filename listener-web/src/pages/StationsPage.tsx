import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listStations, listRankedStations } from "../api/stations";
import { listGenres, listLanguages } from "../api/lookups";
import type { Station } from "../api/types";
import { useCachedQuery } from "../hooks/useCachedQuery";
import { useNowPlaying } from "../player/useNowPlaying";
import { StationCard } from "../components/StationCard";
import { CacheStatusNote } from "../components/CacheStatusNote";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import type { LayoutContext } from "../components/Layout";

const PAGE_SIZE = 20;

// docs/FLUTTER_CLIENT_SPEC.md Section 6.2: two structurally distinct
// requests (a filtered browse vs. a whole-country ranking) presented as
// two modes on one screen, never pretended to be the same request with an
// extra flag - the ranked mode has no genre/language/search filters, per
// that section's own explicit note.
export function StationsPage() {
  const { countryId } = useOutletContext<LayoutContext>();
  const { playRanked, playSingle } = useNowPlaying();
  const [mode, setMode] = useState<"browse" | "ranked">("browse");
  const [genreId, setGenreId] = useState<number | undefined>();
  const [languageId, setLanguageId] = useState<number | undefined>();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data: genresData } = useQuery({ queryKey: ["genres"], queryFn: listGenres });
  const { data: languagesData } = useQuery({ queryKey: ["languages"], queryFn: listLanguages });

  const browse = useCachedQuery(
    ["stations-browse", countryId, genreId, languageId, debouncedSearch, offset],
    () =>
      listStations({
        countryId: countryId ?? undefined,
        genreId,
        languageId,
        q: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    { enabled: mode === "browse" },
  );
  const ranked = useCachedQuery(
    ["stations-ranked-browser", countryId],
    () => listRankedStations({ countryId: countryId as number, limit: 50 }),
    { enabled: mode === "ranked" && countryId !== null },
  );

  const active = mode === "browse" ? browse : ranked;
  const total = mode === "browse" ? browse.data?.pagination.total ?? 0 : ranked.data?.stations.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-ocean-900">Stations</h1>
        <div className="flex gap-1 rounded-full bg-ocean-100 p-1">
          <button
            type="button"
            onClick={() => setMode("browse")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              mode === "browse" ? "bg-white text-ocean-700 shadow-sm" : "text-ocean-600"
            }`}
          >
            Browse
          </button>
          <button
            type="button"
            onClick={() => setMode("ranked")}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              mode === "ranked" ? "bg-white text-ocean-700 shadow-sm" : "text-ocean-600"
            }`}
          >
            Ranked for my country
          </button>
        </div>
      </div>

      {mode === "browse" && (
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setOffset(0);
              setSearch(event.target.value);
            }}
            placeholder="Search stations…"
            className="min-w-48 flex-1 rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500"
          />
          <select
            value={genreId ?? ""}
            onChange={(event) => {
              setOffset(0);
              setGenreId(event.target.value ? Number(event.target.value) : undefined);
            }}
            className="rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All genres</option>
            {genresData?.genres.map((genre) => (
              <option key={genre.id} value={genre.id}>
                {genre.name}
              </option>
            ))}
          </select>
          <select
            value={languageId ?? ""}
            onChange={(event) => {
              setOffset(0);
              setLanguageId(event.target.value ? Number(event.target.value) : undefined);
            }}
            className="rounded-lg border border-ocean-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All languages</option>
            {languagesData?.languages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <CacheStatusNote cacheState={active.cacheState} cachedAt={active.cachedAt} />

      {mode === "browse" ? (
        <StationList
          stations={browse.data?.stations ?? []}
          onPlay={(station) => playSingle(station)}
          empty="No stations match these filters."
        />
      ) : ranked.data && ranked.data.stations.length > 0 ? (
        <div className="space-y-3">
          {ranked.data.stations.map((entry, index) => (
            <StationCard
              key={entry.station.id}
              station={entry.station}
              reliability={entry.reliability}
              onPlay={() => playRanked(ranked.data!.stations.slice(index))}
            />
          ))}
        </div>
      ) : ranked.cacheState !== "failed-no-cache" ? (
        <p className="text-ocean-600">No active stations for this country yet.</p>
      ) : null}

      {mode === "browse" && total > PAGE_SIZE && (
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

function StationList({
  stations,
  onPlay,
  empty,
}: {
  stations: Station[];
  onPlay: (station: Station) => void;
  empty: string;
}) {
  if (stations.length === 0) {
    return <p className="text-ocean-600">{empty}</p>;
  }
  return (
    <div className="space-y-3">
      {stations.map((station) => (
        <StationCard key={station.id} station={station} onPlay={() => onPlay(station)} />
      ))}
    </div>
  );
}
