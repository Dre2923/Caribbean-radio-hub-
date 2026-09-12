import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fetchCurrentUser, login as loginRequest } from "../api/auth";
import { ApiError, getToken, setToken } from "../api/client";
import type { AdminUser } from "../api/types";
import { AuthContext, type AuthStatus } from "./authContext";

export function AuthProvider({ children }: { children: ReactNode }) {
  // Derived synchronously from whether a token is already present, rather
  // than always starting at "checking" and setting state from inside the
  // effect below - a stored token is only ever *provisionally* trusted
  // (see the effect's own comment), but its mere presence/absence is known
  // up front, so there's no need to render a "checking" flash for a
  // visitor who was never signed in at all.
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? "checking" : "signed-out"));
  const [user, setUser] = useState<AdminUser | null>(null);

  // A stored token is only ever *provisionally* trusted - it might be
  // expired, or the account might have since been demoted or deleted by
  // another admin. GET /v1/me is the real source of truth (see
  // app.ts's requireAdmin, which likewise never trusts a cached role): a
  // failure clears the stale token instead of ever assuming it's still
  // good.
  useEffect(() => {
    if (status !== "checking") return;
    fetchCurrentUser()
      .then((currentUser) => {
        setUser(currentUser);
        setStatus("signed-in");
      })
      .catch(() => {
        setToken(null);
        setStatus("signed-out");
      });
  }, [status]);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedInUser } = await loginRequest(email, password);
    // The dashboard is admin-only. A non-admin can authenticate (the
    // credentials are real) but is deliberately kept out of the shell
    // entirely - this is a UX courtesy, never the actual security
    // boundary, which is (and can only correctly be) every admin route's
    // own server-side app.requireAdmin check.
    if (loggedInUser.role !== "admin") {
      throw new ApiError(403, "This account does not have admin access.");
    }
    setToken(token);
    setUser(loggedInUser);
    setStatus("signed-in");
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setStatus("signed-out");
  }, []);

  const value = useMemo(() => ({ status, user, login, logout }), [status, user, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
