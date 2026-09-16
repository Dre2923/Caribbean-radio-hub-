import { existsSync, readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

// Mirrors admin-dashboard/vite.config.ts's own same-origin proxy pattern
// exactly, for the identical reason: this client's fetch code always
// calls same-origin /v1/... in both dev and the production static build,
// so the backend never needs CORS configured and no backend host is ever
// baked into the client bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Optional local HTTPS, off unless .certs/ exists - never required for
  // normal development. Backend/src/schemas/stations.ts's own
  // HTTPS_URL_SCHEMA rejects a plain-http streamUrl (the real, correct
  // rule for a real deployment - see backend/README.md), which only
  // matters here because PROTOTYPE_PLAN.md's demo data points a real
  // station's streamUrl at this dev server's own locally-served demo
  // audio file (real external streams aren't reachable from this
  // sandboxed session - see that file's "Known limitations"). Generate
  // with: openssl req -x509 -newkey rsa:2048 -keyout .certs/key.pem -out
  // .certs/cert.pem -days 365 -nodes -subj "/CN=127.0.0.1"
  const certPath = ".certs/cert.pem";
  const keyPath = ".certs/key.pem";
  const https = existsSync(certPath) && existsSync(keyPath)
    ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
    : undefined;

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5174,
      https,
      proxy: {
        "/v1": env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
      },
    },
  };
});
