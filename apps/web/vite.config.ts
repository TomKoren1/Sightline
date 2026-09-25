import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env["FRONTEND_PORT"] ?? 5173),
    // Proxying keeps the frontend origin-relative, so there is no CORS config
    // to get wrong and no API base URL to bake into the build.
    proxy: {
      "/api": {
        target: `http://localhost:${process.env["BACKEND_PORT"] ?? 3000}`,
        changeOrigin: true,
      },
    },
  },
});
