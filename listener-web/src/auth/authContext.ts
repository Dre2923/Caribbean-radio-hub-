import { createContext } from "react";
import type { User } from "../api/types";

export type AuthStatus = "checking" | "signed-out" | "signed-in";

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

// Split into its own non-component module, the same reason
// admin-dashboard/src/auth/authContext.ts already documents:
// react-refresh/only-export-components flags a file mixing a component
// export with a non-component one.
export const AuthContext = createContext<AuthContextValue | null>(null);
