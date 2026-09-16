import { NavLink, Outlet } from "react-router-dom";
import { CountrySelect } from "./CountrySelect";
import { OfflineBanner } from "./OfflineBanner";
import { MiniPlayer } from "./MiniPlayer";
import { useNowPlaying } from "../player/useNowPlaying";
import { useSelectedCountry } from "../hooks/useSelectedCountry";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${
    isActive ? "bg-ocean-700 text-white" : "text-ocean-700 hover:bg-ocean-100"
  }`;

export function Layout() {
  const [countryId, setCountryId] = useSelectedCountry();
  const { source } = useNowPlaying();

  return (
    <div className="min-h-screen bg-ocean-50">
      <OfflineBanner />
      <header className="border-b border-ocean-100 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold text-ocean-700">🎧 Caribbean Radio Hub</span>
          </div>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Discover
            </NavLink>
            <NavLink to="/stations" className={navLinkClass}>
              Stations
            </NavLink>
            <NavLink to="/events" className={navLinkClass}>
              Events
            </NavLink>
          </nav>
          <CountrySelect countryId={countryId} onChange={setCountryId} />
        </div>
      </header>
      <main className={`mx-auto max-w-5xl px-4 py-6 ${source ? "pb-24" : ""}`}>
        <Outlet context={{ countryId, setCountryId } satisfies LayoutContext} />
      </main>
      <MiniPlayer />
    </div>
  );
}

export interface LayoutContext {
  countryId: number | null;
  setCountryId: (id: number | null) => void;
}
