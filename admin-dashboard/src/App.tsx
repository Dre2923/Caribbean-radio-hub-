import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { DashboardLayout } from "./components/DashboardLayout";
import { LoginPage } from "./pages/LoginPage";
import { UsersPage } from "./pages/UsersPage";
import { StationsPage } from "./pages/StationsPage";

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<DashboardLayout />}>
            <Route path="/users" element={<UsersPage />} />
            <Route path="/stations" element={<StationsPage />} />
            {/* Event moderation (Step 33) adds its own route here as it's
                built. */}
            <Route path="/" element={<Navigate to="/users" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/users" replace />} />
      </Routes>
    </AuthProvider>
  );
}
