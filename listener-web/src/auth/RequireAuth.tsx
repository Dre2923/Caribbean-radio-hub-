import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";

export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "checking") {
    return <p className="text-ocean-600">Checking your session…</p>;
  }

  if (status === "signed-out") {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
