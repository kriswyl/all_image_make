// @vitest-environment jsdom
/**
 * 创作记录（视频页下半部分）的交互底线。
 *
 * 设计稿要求这一页就是「创作框 + 记录网格」：记录不占一个常驻的大播放器，
 * 状态筛选、网格/列表切换、排序、卡片菜单、点开播放器都得能用。
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// vi.mock 的工厂会被提升到文件顶部，这里用 hoisted 保证变量先初始化
const { downloadAsset } = vi.hoisted(() => ({ downloadAsset: vi.fn(async (..._args: unknown[]) => true) }));

vi.mock("../src/client/api", () => ({
  isTauriRuntime: () => false,
  api: {
    assetUrl: (url: string) => url,
    downloadAsset,
    cancel: vi.fn(),
    retry: vi.fn(),
    continueTaskQuery: vi.fn(),
  },
}));
vi.mock("../src/client/generation-confirm", () => ({ confirmGeneration: () => true }));

import { VideoResultPanel } from "../src/client/video/VideoResultPanel";
import type { Asset, Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function asset(id: string, seconds: number): Asset {
  return {
    id, taskId: id, fileName: `${id}.mp4`, mimeType: "video/mp4", byteSize: 2 * 1024 * 1024,
    url: `https://cdn.example.com/${id}.mp4`, duration: seconds, createdAt: "2026-11-10T02:00:00.000Z",
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    channelId: "wan",
    channelName: "通义万相-视频",
    model: "wan2.5-i2v",
    prompt: "古风武士战斗场景",
    status: "succeeded",
    progress: null,
    effectiveParameters: null,
    attemptCount: 1,
    errorCode: null,
    errorMessage: null,
    assets: [],
    createdAt: "2026-11-10T02:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

const done = task({
  id: "done-1", prompt: "城市夜景镜头推进", createdAt: "2026-11-10T02:10:00.000Z",
  assets: [asset("done-1", 5)],
  inputParameters: { prompt: "城市夜景镜头推进", imageCount: 0, media: [], resolution: "720P", duration: 5 },
});
const doneOld = task({
  id: "done-2", prompt: "山间云海日出", createdAt: "2026-11-10T01:00:00.000Z",
  assets: [asset("done-2", 8)],
  inputParameters: { prompt: "山间云海日出", imageCount: 0, media: [], resolution: "1080P", duration: 8 },
});
const running = task({
  id: "run-1", prompt: "古风武士战斗场景", status: "running", progress: 40,
  createdAt: "2026-11-10T03:10:00.000Z", assets: [],
});
const failed = task({
  id: "bad-1", prompt: "太空探索航行", status: "failed", errorCode: "UPSTREAM_ERROR",
  errorMessage: "上游拒绝了这次请求", createdAt: "2026-11-10T00:10:00.000Z", assets: [],
});

let root: Root | null = null;
let container: HTMLDivElement;
let reused: Task[] = [];
let deleted: Task[] = [];

async function mount(tasks: Task[], active: Task | null = null) {
  reused = [];
  deleted = [];
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <VideoResultPanel
        task={active}
        tasks={tasks}
        onDiagnostics={() => undefined}
        onTask={() => undefined}
        onSelectTask={() => undefined}
        onReuse={(item) => reused.push(item)}
        onDelete={(item) => deleted.push(item)}
        onToast={() => undefined}
      />,
    );
    await Promise.resolve();
  });
}

function cardTitles(): string[] {
  return [...container.querySelectorAll(".record-title-row h3")].map((node) => node.textContent ?? "");
}

function tab(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll(".record-tabs button")]
    .find((node) => node.textContent?.startsWith(label)) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`没有这个筛选：${label}`);
  return found;
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  document.querySelectorAll(".record-menu").forEach((node) => node.remove());
});

it("标题带总条数，筛选页签按状态计数", async () => {
  await mount([running, done, doneOld, failed]);
  expect(container.querySelector(".record-count")?.textContent).toBe("共 4 条");
  expect([...container.querySelectorAll(".record-tabs button")].map((node) => node.textContent))
    .toEqual(["全部4", "进行中1", "已完成2", "失败1"]);
  // 尺寸量不到（jsdom 没有布局）时退回一页 3 条，4 条剩下 1 条在第二页
  expect(container.querySelectorAll(".record-card").length).toBe(3);
});

it("翻页条钉在筛选页签右上角，翻过去能看到剩下的；换筛选回到第一页", async () => {
  await mount([running, done, doneOld, failed]);
  expect(cardTitles()).toEqual(["古风武士战斗场景", "城市夜景镜头推进", "山间云海日出"]);
  const pager = container.querySelector(".record-pager") as HTMLElement;
  expect(pager.textContent).toContain("第 1–3 条 / 共 4 条");
  expect(pager.textContent).toContain("1 / 2");
  // 和筛选页签同一行、在它右边，不再挂在卡片网格下面
  const controls = container.querySelector(".record-controls") as HTMLElement;
  expect(controls.contains(pager)).toBe(true);
  expect(controls.firstElementChild?.classList.contains("record-tabs")).toBe(true);
  expect(controls.lastElementChild).toBe(pager);
  expect(container.querySelector(".record-scroll .record-pager")).toBeNull();

  await act(async () => {
    (pager.querySelector("button[aria-label='下一页']") as HTMLButtonElement).click();
  });
  expect(cardTitles()).toEqual(["太空探索航行"]);
  expect(container.querySelector(".record-pager")?.textContent).toContain("2 / 2");

  // 换筛选从第一页看起，不会停在空白页；放得下就不显示翻页条
  await act(async () => { tab("已完成").click(); });
  expect(cardTitles()).toEqual(["城市夜景镜头推进", "山间云海日出"]);
  expect(container.querySelector(".record-pager")).toBeNull();
});

it("点筛选只留下对应状态的记录", async () => {
  await mount([running, done, doneOld, failed]);
  await act(async () => { tab("已完成").click(); });
  expect(cardTitles()).toEqual(["城市夜景镜头推进", "山间云海日出"]);

  await act(async () => { tab("失败").click(); });
  expect(cardTitles()).toEqual(["太空探索航行"]);

  await act(async () => { tab("进行中").click(); });
  expect(cardTitles()).toEqual(["古风武士战斗场景"]);
});

it("选中的是一条已完成时，点「失败」不会被弹回「全部」", async () => {
  // 之前 filter 也在重置 effect 的依赖里：当前任务不匹配新筛选就立刻改回「全部」，
  // 表现就是筛选页签点了没反应
  await mount([running, done, doneOld, failed], done);
  await act(async () => { tab("失败").click(); });
  expect(tab("失败").getAttribute("aria-selected")).toBe("true");
  expect(tab("全部").getAttribute("aria-selected")).toBe("false");
  expect(cardTitles()).toEqual(["太空探索航行"]);

  await act(async () => { tab("进行中").click(); });
  expect(cardTitles()).toEqual(["古风武士战斗场景"]);
});

it("已完成卡片有播放角标、时长与分辨率；生成中有进度；失败写错误码", async () => {
  await mount([running, done, failed]);
  const cards = [...container.querySelectorAll(".record-card")];
  const doneCard = cards.find((node) => node.textContent?.includes("城市夜景镜头推进"))!;
  expect(doneCard.querySelector(".record-play")).toBeTruthy();
  expect(doneCard.querySelector(".record-duration")?.textContent).toBe("00:05");
  expect(doneCard.textContent).toContain("720P");
  expect(doneCard.querySelector(".record-dot")?.className).toContain("is-done");

  const runCard = cards.find((node) => node.textContent?.includes("古风武士战斗场景"))!;
  expect(runCard.querySelector(".record-overlay")?.textContent).toContain("40%");
  expect(runCard.querySelector(".record-dot")?.className).toContain("is-running");

  const badCard = cards.find((node) => node.textContent?.includes("太空探索航行"))!;
  expect(badCard.querySelector(".record-overlay.is-error")?.textContent).toContain("UPSTREAM_ERROR");
  expect(badCard.querySelector(".record-dot")?.className).toContain("is-failed");
});

it("排序是自绘浮层：切成最早在前，页面上没有原生 select", async () => {
  await mount([running, done, doneOld, failed]);
  expect(cardTitles()[0]).toBe("古风武士战斗场景");
  // 原生 select 的弹出层是系统灰底，和这一页的控件不是一套
  expect(container.querySelector("select")).toBeNull();

  const button = container.querySelector("button.record-sort") as HTMLButtonElement;
  expect(button.textContent).toContain("最近在前");
  await act(async () => { button.click(); });

  const menu = document.querySelector(".record-sort-menu") as HTMLElement;
  expect(menu).toBeTruthy();
  expect([...menu.querySelectorAll("button")].map((node) => node.textContent))
    .toEqual(["最近在前", "最早在前"]);

  const oldest = [...menu.querySelectorAll("button")].find((node) => node.textContent === "最早在前") as HTMLButtonElement;
  await act(async () => { oldest.click(); });
  expect(cardTitles()[0]).toBe("太空探索航行");
  expect(button.textContent).toContain("最早在前");
  expect(document.querySelector(".record-sort-menu")).toBeNull();
});

it("记录区只有网格一种视角：没有网格/列表切换，列数按可用宽度算", async () => {
  await mount([done, doneOld]);
  expect(container.querySelectorAll(".record-card").length).toBe(2);
  expect(container.querySelector(".record-view-switch")).toBeNull();
  expect(container.querySelector("button[aria-label='网格视图']")).toBeNull();
  expect(container.querySelector("button[aria-label='列表视图']")).toBeNull();
  expect(container.querySelectorAll(".record-row").length).toBe(0);
  // 列数由 JS 算出来后写进内联样式，不再由 CSS 写死三列
  expect((container.querySelector(".record-grid") as HTMLElement).style.gridTemplateColumns)
    .toMatch(/^repeat\(\d+, minmax\(0, 1fr\)\)$/);
});

it("卡片菜单给出播放/下载/重生成/复用参数/诊断/删除，点复用参数回到创作框", async () => {
  await mount([done]);
  await act(async () => {
    (container.querySelector(".record-more") as HTMLButtonElement).click();
  });
  const menu = document.querySelector(".record-menu") as HTMLElement;
  expect(menu).toBeTruthy();
  expect([...menu.querySelectorAll("button")].map((node) => node.textContent))
    .toEqual(["播放", "下载", "重生成", "复用参数", "查看诊断", "删除历史"]);

  const reuse = [...menu.querySelectorAll("button")].find((node) => node.textContent === "复用参数") as HTMLButtonElement;
  await act(async () => { reuse.click(); });
  expect(reused.map((item) => item.id)).toEqual(["done-1"]);
  expect(document.querySelector(".record-menu")).toBeNull();
});

it("菜单里的删除历史交给上层确认，不在这一层直接删", async () => {
  await mount([done]);
  await act(async () => {
    (container.querySelector(".record-more") as HTMLButtonElement).click();
  });
  const menu = document.querySelector(".record-menu") as HTMLElement;
  const remove = [...menu.querySelectorAll("button")].find((node) => node.textContent === "删除历史") as HTMLButtonElement;
  expect(remove.classList.contains("is-danger")).toBe(true);
  await act(async () => { remove.click(); });
  expect(deleted.map((item) => item.id)).toEqual(["done-1"]);
  expect(document.querySelector(".record-menu")).toBeNull();
});

it("下载走服务的保存流程", async () => {
  downloadAsset.mockClear();
  await mount([done]);
  await act(async () => {
    (container.querySelector(".record-more") as HTMLButtonElement).click();
  });
  const menu = document.querySelector(".record-menu") as HTMLElement;
  const download = [...menu.querySelectorAll("button")].find((node) => node.textContent === "下载") as HTMLButtonElement;
  await act(async () => { download.click(); await Promise.resolve(); });
  expect(downloadAsset).toHaveBeenCalledTimes(1);
});

it("点卡片打开大播放器，能关掉；生成中的卡片打开是进度而不是空播放器", async () => {
  await mount([done, running]);
  const doneCard = [...container.querySelectorAll(".record-card")]
    .find((node) => node.textContent?.includes("城市夜景镜头推进"))!;
  await act(async () => { (doneCard.querySelector(".record-thumb") as HTMLButtonElement).click(); });
  const dialog = document.querySelector(".record-dialog") as HTMLElement;
  expect(dialog).toBeTruthy();
  expect(dialog.querySelector("video")?.getAttribute("src")).toContain("done-1.mp4");
  expect(dialog.textContent).toContain("复用参数");
  await act(async () => { (dialog.querySelector(".record-dialog-close") as HTMLButtonElement).click(); });
  expect(document.querySelector(".record-dialog")).toBeNull();

  const runCard = [...container.querySelectorAll(".record-card")]
    .find((node) => node.textContent?.includes("古风武士战斗场景"))!;
  await act(async () => { (runCard.querySelector(".record-thumb") as HTMLButtonElement).click(); });
  const pending = document.querySelector(".record-dialog") as HTMLElement;
  expect(pending.querySelector(".task-progress")).toBeTruthy();
  expect((pending.querySelector(".progress-track span") as HTMLElement).style.width).toBe("40%");
});

it("没有记录时给空状态，而不是一片空白", async () => {
  await mount([]);
  expect(container.querySelector(".record-empty")?.textContent).toContain("还没有创作记录");
  expect(container.querySelector(".record-count")?.textContent).toBe("还没有记录");
});
