import { expect, it } from "vitest";
import { assertWpsPreviewResult } from "../src/client/chat/wps-result";

it("检查 WPS 返回的加载项结果，不能将中继成功当作导出成功", () => {
  expect(() => assertWpsPreviewResult({ status: 0, response: JSON.stringify({ ok: true, first: 1, last: 3 }) }, 1, 3)).not.toThrow();
  expect(() => assertWpsPreviewResult({ status: 0, response: JSON.stringify({ ok: false, stage: "打开 PPT", message: "无法打开" }) }, 1, 3)).toThrow(/打开 PPT失败：无法打开/);
  expect(() => assertWpsPreviewResult({ status: 0, response: "" }, 1, 3)).toThrow(/未确认逐页导出/);
});
