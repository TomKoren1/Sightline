import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** The repo root, where the single shared .env lives. */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  /**
   * Vite looks for .env beside the app, and only exposes VITE_-prefixed keys.
   * This project keeps one .env at the repo root shared with the backend, so
   * it is loaded explicitly with an empty prefix.
   *
   * Nothing from here reaches the browser: these values are used only to
   * configure the dev server itself.
   */
  const env = loadEnv(mode, repoRoot, "");

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env["FRONTEND_PORT"] ?? 5173),
      /**
       * Bind address. Defaults to loopback; set FRONTEND_HOST=0.0.0.0 to reach
       * the dev server from another machine (a tailnet, a LAN).
       *
       * Only this port needs exposing. The API is reached through the proxy
       * below, which runs server-side, so the backend can stay on loopback and
       * there is one open port rather than two.
       */
      host: env["FRONTEND_HOST"] || "127.0.0.1",
      /**
       * Vite rejects requests carrying a Host header it does not recognise, as
       * DNS-rebinding protection. Bare IPs are always accepted; MagicDNS names
       * are not, so tailnet hostnames are allowed explicitly.
       */
      allowedHosts: [".ts.net", "localhost"],
      // Proxying keeps the frontend origin-relative, so there is no CORS config
      // to get wrong and no API base URL to bake into the build.
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${env["BACKEND_PORT"] ?? 3000}`,
          changeOrigin: true,
          // Scans and agent answers are server-sent event streams. Without
          // this the proxy buffers them and delivers everything at the end,
          // which defeats the progress reporting entirely.
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes) => {
              if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
                delete proxyRes.headers["content-length"];
                proxyRes.headers["cache-control"] = "no-cache, no-transform";
              }
            });
          },
        },
      },
    },
  };
});
