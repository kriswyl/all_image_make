import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/*
 * 浏览器预览（非 Tauri）时，客户端的 apiBase 是空串，请求走同源 /api，
 * 再由 Vite 代理到本地后端。后端端口允许用 VITE_API_PROXY 覆盖——
 * 热重载常常把 API 起在 17892，写死 17891 会让预览里所有请求 404。
 */
const apiProxy = process.env.VITE_API_PROXY || "http://127.0.0.1:17891";

export default defineConfig({
  root: path.resolve("src/client"),
  plugins: [react()],
  server: {
    proxy: {
      "/api/": apiProxy,
    },
  },
  build: {
    outDir: path.resolve("dist/client"),
    emptyOutDir: true,
  },
});
