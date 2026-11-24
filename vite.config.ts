import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { BRAND } from "./src/shared/brand.generated";
import { brandedWpsFiles, escapeMarkup, renderWpsBrand } from "./src/shared/brand-markup";

/*
 * 浏览器预览（非 Tauri）时，客户端的 apiBase 是空串，请求走同源 /api，
 * 再由 Vite 代理到本地后端。后端端口允许用 VITE_API_PROXY 覆盖——
 * 热重载常常把 API 起在 17892，写死 17891 会让预览里所有请求 404。
 */
const apiProxy = process.env.VITE_API_PROXY || "http://127.0.0.1:17891";
const brandAssets = path.resolve("brands", BRAND.id, "public");
const wpsTemplates = path.resolve("src/client/public/wps-addon");
const outDir = path.resolve("dist/client");

export default defineConfig({
  root: path.resolve("src/client"),
  plugins: [react(), {
    name: "chatcanvas-brand",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replaceAll("__BRAND_TITLE__", () => escapeMarkup(BRAND.productName))
          .replaceAll("__BRAND_THEME_COLOR__", () => BRAND.web.themeColor)
          .replaceAll("__BRAND_LIGHT_COLOR__", () => BRAND.web.lightThemeColor)
          .replaceAll("__BRAND_DARK_COLOR__", () => BRAND.web.darkThemeColor)
          .replaceAll("__BRAND_FAVICON__", () => BRAND.web.favicon);
      },
    },
    configureServer(server) {
      server.middlewares.use("/branding", (req, res, next) => {
        const asset = req.url?.split("?")[0]?.slice(1);
        if (!asset || !/^[\w./@-]+$/.test(asset) || asset.split("/").includes("..")) return next();
        const full = path.join(brandAssets, asset);
        if (!fs.statSync(full, { throwIfNoEntry: false })?.isFile()) return next();
        const ext = path.extname(full).toLowerCase();
        const mime: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
        res.setHeader("Content-Type", mime[ext] ?? "application/octet-stream");
        fs.createReadStream(full).on("error", next).pipe(res);
      });
    },
    writeBundle() {
      if (fs.existsSync(brandAssets)) fs.cpSync(brandAssets, path.join(outDir, "branding"), { recursive: true });
      for (const file of brandedWpsFiles) {
        const template = fs.readFileSync(path.join(wpsTemplates, file), "utf8");
        fs.writeFileSync(path.join(outDir, "wps-addon", file), renderWpsBrand(template, file));
      }
    },
  }, {
    name: "wps-sdk-dev",
    configureServer(server) {
      server.middlewares.use("/wps-addon/wpsjsrpcsdk.js", (_req, res) => {
        res.setHeader("Content-Type", "application/javascript");
        res.end(fs.readFileSync(path.resolve("node_modules/wpsjs-rpc-sdk-new/wpsjsrpcsdk.js")));
      });
    },
  }],
  optimizeDeps: {
    // These ESM wrappers can load directly. Native file actions should not depend on a cached optimizer URL.
    exclude: ["@tauri-apps/plugin-dialog", "@tauri-apps/plugin-fs"],
  },
  server: {
    proxy: {
      "/api/": apiProxy,
      "^/wps-addon/(?:index\\.html|setup\\.html|setup\\.js|runner\\.js|manifest\\.xml)(?:\\?|$)": apiProxy,
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
});
