import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DiscoverPage } from "./pages/DiscoverPage";
import { StationsPage } from "./pages/StationsPage";
import { StationDetailPage } from "./pages/StationDetailPage";
import { EventsPage } from "./pages/EventsPage";
import { EventDetailPage } from "./pages/EventDetailPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DiscoverPage />} />
        <Route path="/stations" element={<StationsPage />} />
        <Route path="/stations/:id" element={<StationDetailPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
      </Route>
    </Routes>
  );
}
