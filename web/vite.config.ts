import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  // The station's config lives in <repo>/.env, one level up from this package,
  // so Vite's own env loading (rooted at web/) would never see STATION_HOST.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const stationHost = loadEnv(mode, repoRoot, "STATION_HOST").STATION_HOST?.trim();

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      // Explicit IPv4: Vite's default `localhost` resolves to ::1 on macOS, and
      // the pf redirect that fronts STATION_HOST targets 127.0.0.1 — bound to
      // IPv6 only, port 80 rewrites to an address with nothing listening on it.
      host: "127.0.0.1",
      port: 5173,
      // Vite refuses a Host header it doesn't know (DNS-rebinding guard), so the
      // /etc/hosts alias from scripts/setup-host.sh has to be named here.
      allowedHosts: stationHost ? [stationHost] : [],
      proxy: {
        "/api": { target: "http://127.0.0.1:3789", changeOrigin: true },
        "/ws": { target: "ws://127.0.0.1:3789", ws: true },
      },
    },
  };
});
