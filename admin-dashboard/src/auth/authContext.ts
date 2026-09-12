import { createContext } from "react";
import type { AdminUser } from "../api/types";

export type AuthStatus = "checking" | "signed-out" | "signed-in";

export interface AuthContextValue {
  status: AuthStatus;
  user: AdminUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

// Split into its own non-component module (rather than colocated with
// AuthProvider/useAuth) purely so each of those files exports exactly one
// thing Vite's Fast Refresh can hot-reload as a unit -
// react-refresh/only-export-components flags a file mixing a component
// export with a non-component one, which this three-way split avoids
// entirely instead of silencing the warning.
export const AuthContext = createContext<AuthContextValue | null>(null);
