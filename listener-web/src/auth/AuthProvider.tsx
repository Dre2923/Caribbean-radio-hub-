import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { fetchCurrentUser, login as loginRequest } from "../api/auth";
import { getToken, setToken, setUnauthorizedHandler } from "../api/client";
import type { User } from "../api/types";
import { AuthContext, type AuthStatus } from "./authContext";

// Mirrors admin-dashboard/src/auth/AuthProvider.tsx's own pattern
// (derive initial status from whether a token is already stored, then
// verify it against the real GET /v1/me rather than ever trusting it
// blindly) - see api/client.ts's own comment for the one deliberate
// difference (localStorage here, not sessionStorage).
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? "checking" : "signed-out"));
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (status !== "checking") return;
    fetchCurrentUser()
      .then((currentUser) => {
        setUser(currentUser);
        setStatus("signed-in");
      })
      .catch(() => {
        // A stored token that no longer works (expired, invalidated by a
        // password change, or the account is gone) - per docs/
        // FLUTTER_CLIENT_SPEC.md Section 9.2, the only correct handling
        // for any 401 anywhere is: clear the token, go to signed-out.
        setToken(null);
        setStatus("signed-out");
      });
  }, [status]);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: loggedInUser } = await loginRequest(email, password);
    setToken(token);
    setUser(loggedInUser);
    setStatus("signed-in");
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setStatus("signed-out");
  }, []);

  // Registered once, globally - see api/client.ts's own comment on why
  // this exists instead of a per-screen 401 check.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
      setStatus("signed-out");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Used after a profile edit (PATCH /v1/me) so the in-memory user object
  // reflects the change immediately, without a full re-check round trip.
  const refreshUser = useCallback(async () => {
    const currentUser = await fetchCurrentUser();
    setUser(currentUser);
  }, []);

  const value = useMemo(
    () => ({ status, user, login, logout, refreshUser }),
    [status, user, login, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
