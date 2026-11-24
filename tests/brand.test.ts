import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/shared/brand.generated";
import { brandedWpsFiles, renderWpsBrand } from "../src/shared/brand-markup";
import { ONE_KEY_PRESET } from "../src/shared/provider-presets";
import { supportsVideoReferenceImageUpload } from "../src/shared/video-reference-image-policy";

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe.runIf(BRAND.id === "chatcanvas")("ChatCanvas 主版品牌配置", () => {
  it("保留原安装标识、监听端口、窗口配置和更新信任链", () => {
    const base = readJson("src-tauri/tauri.conf.json");
    const overlay = readJson("src-tauri/tauri.brand.generated.json");
    expect(overlay.productName).toBe("ChatCanvas");
    expect(overlay.identifier).toBe("com.imagerelay.studio");
    expect(BRAND.backendPort).toBe(17892);
    expect(overlay.app).toEqual(base.app);
    expect(overlay.bundle.icon).toEqual(base.bundle.icon);
    expect(overlay.plugins.updater).toEqual({
      pubkey: base.plugins.updater.pubkey,
      endpoints: ["https://github.com/kriswyl/all_image_make/releases/download/updater/latest.json"],
    });
  });

  it("保留渠道模板和已验证的参考图上传范围", () => {
    expect(ONE_KEY_PRESET.baseUrl).toBe("https://api.tiantoken.com");
    expect(ONE_KEY_PRESET.keyUrl).toBeUndefined();
    const uploadEndpoint = "https://imageproxy.zhongzhuan.chat/api/upload";
    const channel = { adapterType: "minimax-video" as const, baseUrl: ONE_KEY_PRESET.baseUrl, uploadEndpoint };
    expect(ONE_KEY_PRESET.units.some((unit) => unit.uploadEndpoint === uploadEndpoint)).toBe(true);
    expect(supportsVideoReferenceImageUpload(channel, "MiniMax-H3")).toBe(true);
    expect(supportsVideoReferenceImageUpload({ ...channel, baseUrl: "https://other.example" }, "MiniMax-H3")).toBe(false);
  });

  it("保留 WPS 加载项注册名并替换所有受品牌控制的模板变量", () => {
    const addons = Object.fromEntries(brandedWpsFiles.map((file) => {
      const template = fs.readFileSync(`src/client/public/wps-addon/${file}`, "utf8");
      return [file, renderWpsBrand(template, file)];
    }));
    expect(addons["manifest.xml"]).toContain("<Name>ChatCanvasPreview</Name>");
    expect(addons["runner.js"]).toContain('InvokeAsHttp("ChatCanvasPreview"');
    expect(addons["setup.html"]).toContain("启用 ChatCanvas WPS 预览");
    expect(Object.values(addons).join("")).not.toMatch(/__(?:BRAND_TITLE|WPS_ADDON_ID)__/);
  });
});
