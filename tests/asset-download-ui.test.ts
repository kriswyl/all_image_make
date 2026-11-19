// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import type { Asset } from "../src/shared/types";

const native = vi.hoisted(() => ({ save: vi.fn(), writeFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: native.writeFile }));

const asset: Asset = {
  id: "image-1", taskId: "task-1", fileName: "result.m4a", mimeType: "image/webp",
  url: "/api/assets/image-1/file?version=1", byteSize: 3, createdAt: "2026-11-19T00:00:00.000Z",
};

beforeEach(() => {
  native.save.mockReset();
  native.writeFile.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.unstubAllGlobals();
});

it("桌面端选择保存位置后下载原始字节，并按素材类型修正默认扩展名", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const fetchAsset = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetchAsset);
  native.save.mockResolvedValue("C:/Downloads/image.webp");

  expect(await api.downloadAsset(asset)).toBe(true);
  expect(native.save).toHaveBeenCalledWith({
    title: "保存图片", defaultPath: "result.webp", filters: [{ name: "图片", extensions: ["webp"] }],
  });
  expect(fetchAsset).toHaveBeenCalledWith(expect.stringContaining("/api/assets/image-1/file?version=1&download=1"));
  expect(native.writeFile).toHaveBeenCalledWith("C:/Downloads/image.webp", bytes);
});

it("取消桌面保存对话框时无需读取或写入文件", async () => {
  const fetchAsset = vi.fn();
  vi.stubGlobal("fetch", fetchAsset);
  native.save.mockResolvedValue(null);

  expect(await api.downloadAsset(asset)).toBe(false);
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(native.writeFile).not.toHaveBeenCalled();
});
