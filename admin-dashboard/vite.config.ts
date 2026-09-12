import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Proxies the dashboard's own API calls to the backend during `vite
      // dev`, so the dashboard's fetch code always calls same-origin `/v1/...`
      // (no CORS configuration needed on the backend, no hardcoded
      // localhost:3000 baked into the client bundle) in both dev and the
      // production static build - see `caddy`/nginx-equivalent reverse-proxy
      // config for how the built assets get the same treatment in
      // production, documented in README.md.
      proxy: {
        "/v1": env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
      },
    },
  };
});
