import { BRAND } from "./brand.generated.js";

export function escapeMarkup(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export const brandedWpsFiles = ["index.html", "setup.html", "setup.js", "runner.js", "manifest.xml"];

export function renderWpsBrand(template: string, filename: string): string {
  const name = filename.endsWith(".js") ? JSON.stringify(BRAND.productName).slice(1, -1) : escapeMarkup(BRAND.productName);
  return template
    .replaceAll("__BRAND_TITLE__", () => name)
    .replaceAll("__WPS_ADDON_ID__", () => BRAND.wpsAddonId);
}
