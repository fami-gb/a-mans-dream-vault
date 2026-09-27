import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In dev, the Go server runs on :8080 and Vite proxies API/media to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: false },
      "/media": { target: "http://localhost:8080" },
    },
  },
  build: { outDir: "dist", assetsDir: "assets" },
});
