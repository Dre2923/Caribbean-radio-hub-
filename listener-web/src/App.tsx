import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DiscoverPage } from "./pages/DiscoverPage";
import { StationsPage } from "./pages/StationsPage";
import { StationDetailPage } from "./pages/StationDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { HistoryPage } from "./pages/HistoryPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SubmitEventPage } from "./pages/SubmitEventPage";
import { VoicePage } from "./pages/VoicePage";
import { RequireAuth } from "./auth/RequireAuth";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/stations" element={<StationsPage />} />
        <Route path="/stations/:id" element={<StationDetailPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/voice" element={<VoicePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/favorites" element={<FavoritesPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/events/new" element={<SubmitEventPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
