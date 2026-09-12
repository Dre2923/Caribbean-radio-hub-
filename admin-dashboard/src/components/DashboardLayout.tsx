import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/useAuth";

// Only "Users" exists as of Step 31 - Station moderation (Step 32) and
// Event moderation (Step 33) add their own entries here as they're built,
// the same incremental-bucket shape as every other multi-step bucket in
// docs/BUILD_MANIFEST.md.
const NAV_ITEMS = [{ to: "/users", label: "Users" }];

export function DashboardLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-8">
            <span className="text-sm font-semibold tracking-tight text-slate-900">
              Caribbean Radio Hub <span className="font-normal text-slate-400">/ Admin</span>
            </span>
            <nav className="flex gap-1">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
                    (isActive
                      ? "bg-brand-50 text-brand-700"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden text-sm text-slate-500 sm:inline">{user?.email}</span>
            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
