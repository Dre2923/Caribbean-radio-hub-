import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { CountrySelect } from "./CountrySelect";
import { OfflineBanner } from "./OfflineBanner";
import { MiniPlayer } from "./MiniPlayer";
import { useNowPlaying } from "../player/useNowPlaying";
import { useSelectedCountry } from "../hooks/useSelectedCountry";
import { useAuth } from "../auth/useAuth";

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-full px-4 py-2 text-sm font-semibold transition ${
    isActive ? "bg-ocean-700 text-white" : "text-ocean-700 hover:bg-ocean-100"
  }`;

export function Layout() {
  const [countryId, setCountryId] = useSelectedCountry();
  const { source } = useNowPlaying();
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-ocean-50">
      <OfflineBanner />
      <header className="border-b border-ocean-100 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="text-lg font-bold text-ocean-700">🎧 Caribbean Radio Hub</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Discover
            </NavLink>
            <NavLink to="/stations" className={navLinkClass}>
              Stations
            </NavLink>
            <NavLink to="/events" className={navLinkClass}>
              Events
            </NavLink>
            <NavLink to="/voice" className={navLinkClass}>
              Voice
            </NavLink>
            {status === "signed-in" && (
              <>
                <NavLink to="/favorites" className={navLinkClass}>
                  Favorites
                </NavLink>
                <NavLink to="/history" className={navLinkClass}>
                  History
                </NavLink>
              </>
            )}
          </nav>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CountrySelect countryId={countryId} onChange={setCountryId} />
            {status === "signed-in" ? (
              <div className="flex items-center gap-2">
                <NavLink to="/profile" className={navLinkClass}>
                  {user?.displayName ?? "Account"}
                </NavLink>
                <button
                  type="button"
                  onClick={() => {
                    logout();
                    navigate("/");
                  }}
                  className="rounded-full px-3 py-2 text-sm font-semibold text-ocean-500 hover:bg-ocean-100"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <NavLink to="/login" className={navLinkClass}>
                  Sign in
                </NavLink>
                <NavLink
                  to="/register"
                  className="rounded-full bg-ocean-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-600"
                >
                  Sign up
                </NavLink>
              </div>
            )}
          </div>
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
