import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import { App } from "./App";
import { PlayerProvider } from "./player/PlayerProvider";
import { AuthProvider } from "./auth/AuthProvider";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Public reference/catalog data doesn't need real-time freshness -
      // and retrying a failed request while offline (useCachedQuery's own
      // job, not react-query's default backoff) is more noise than value.
      retry: false,
      staleTime: 10_000,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// Registered only in a production build (npm run build && npm run
// preview), never in `npm run dev` - Vite's dev server serves unbundled,
// frequently-changing modules that a service worker's own cache would
// fight with (stale-module confusion), and the shell this worker exists
// to cache is exactly the real, hashed production bundle. See
// public/sw.js's own header comment for what it does and doesn't cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Best-effort - a registration failure must never break the app
      // itself, only the offline-app-shell enhancement it provides.
    });
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <PlayerProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </PlayerProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
