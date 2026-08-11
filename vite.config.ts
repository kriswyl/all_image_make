import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve("src/client"),
  plugins: [react()],
  server: {
    proxy: {
      "/api/": "http://127.0.0.1:17891",
    },
  },
  build: {
    outDir: path.resolve("dist/client"),
    emptyOutDir: true,
  },
});
