import { expect, it } from "vitest";
import { waitForWpsFiles } from "../src/client/chat/wps-wait";

it("WPS 回调丢失时根据完整页面文件完成等待", async () => {
  let calls = 0; const seen: number[] = [];
  await waitForWpsFiles(async () => ({ ready: ++calls, total: 3 }), new AbortController().signal, (ready) => seen.push(ready), 1, 5);
  expect(seen).toEqual([1, 2, 3]);
});

it("用户关闭时立即终止等待", async () => {
  const controller = new AbortController();
  const waiting = waitForWpsFiles(async () => ({ ready: 0, total: 3 }), controller.signal, () => {}, 10000, 5);
  controller.abort();
  await expect(waiting).rejects.toThrow(/关闭预览/);
});
