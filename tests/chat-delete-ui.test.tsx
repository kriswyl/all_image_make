// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChatView } from "../src/client/ChatView";
import { api } from "../src/client/api";
import type { CanvasAsset, ChatMessage, ConversationSummary, ConversationView } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mountChat(messages: ChatMessage[] = [], mediaAssets: CanvasAsset[] = []) {
  // jsdom 没有实现对象 URL，图片附件预览需要一个可用的桩
  if (!URL.createObjectURL) Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:preview" });
  if (!URL.revokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  const selected: ConversationSummary & { running: boolean } = {
    id: "selected", title: "广告分镜", kind: "chat", boardId: null, brainChannelId: "", brainModel: "",
    canvasAssetIds: [], status: "idle", videoConfirmPolicy: "always", visionEnabled: true, verbatimPrompt: false,
    taskCount: 0, autoContinueCount: 0, createdAt: "", updatedAt: "", lastMessage: "", messageCount: 1, running: false,
  };
  const other = { ...selected, id: "other", title: "保留的对话" };
  const conversation = (summary: ConversationSummary): ConversationView & { running: boolean } => ({
    ...summary, running: false, contextSummary: null, messages, canvasImages: [], sessionImages: [], mediaAssets, storyboardCount: 0,
    usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, calls: 0 },
  });
  const list = vi.spyOn(api, "conversations").mockResolvedValue([selected, other]);
  vi.spyOn(api, "conversation").mockImplementation(async (id) => conversation(id === selected.id ? selected : other));
  vi.spyOn(api, "capabilities").mockResolvedValue({ manifest: "", aliases: [] });
  vi.spyOn(api, "settings").mockRejectedValue(new Error("fixture settings unavailable"));
  vi.spyOn(api, "openConversationStream").mockReturnValue(() => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });

  const host = document.createElement("div");
  const sidebar = document.createElement("div");
  document.body.append(host, sidebar);
  const root = createRoot(host);
  const toast = vi.fn();
  await act(async () => root.render(<ChatView channels={[]} sidebarHost={sidebar} onToast={toast} />));
  return { selected, other, list, sidebar, toast, unmount: () => { act(() => root.unmount()); host.remove(); sidebar.remove(); } };
}

function button(container: ParentNode, text: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text || item.getAttribute("aria-label") === text);
  expect(found, text).toBeDefined();
  return found!;
}

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');

it.each(["侧栏按钮", "右键菜单"])("从%s删除时，先核对会话，取消或按 Esc 都不发送请求", async (entry) => {
  const { selected, other, list, sidebar, toast, unmount } = await mountChat();
  const remove = vi.spyOn(api, "deleteConversation").mockImplementation(async () => {
    list.mockResolvedValue([other]);
    return { deleted: true };
  });
  const restore = vi.spyOn(api, "restoreConversation").mockImplementation(async () => {
    list.mockResolvedValue([selected, other]);
    return { restored: true };
  });
  async function open() {
    const row = sidebar.querySelector(".sidebar-conv")!;
    if (entry === "侧栏按钮") await act(async () => button(row, "删除会话").click());
    else {
      await act(async () => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
      await act(async () => button(document.querySelector('[role="menu"]')!, "删除会话").click());
    }
    expect(dialog()?.textContent).toContain(selected.title);
    expect(dialog()?.textContent).toContain("30 天内");
    expect(document.activeElement).toBe(button(dialog()!, "取消"));
    expect(remove).not.toHaveBeenCalled();
  }
  try {
    await open();
    await act(async () => button(dialog()!, "取消").click());
    expect(dialog()).toBeNull();
    await open();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(dialog()).toBeNull();
    await open();
    await act(async () => button(dialog()!, "移到最近删除").click());
    expect(remove).toHaveBeenCalledExactlyOnceWith(selected.id);
    expect(dialog()).toBeNull();
    expect(sidebar.textContent).not.toContain(selected.title);
    expect(sidebar.textContent).toContain(other.title);
    const undo = toast.mock.lastCall?.[2];
    expect(undo?.label).toBe("撤销");
    await act(async () => undo.run());
    expect(restore).toHaveBeenCalledExactlyOnceWith(selected.id);
    expect(sidebar.querySelector(".sidebar-conv.is-active")?.textContent).toContain(selected.title);
  } finally { unmount(); }
});

it("复制一条消息只带正文和附件名，复制整个会话去掉内部字段", async () => {
  const user: ChatMessage = { id: "user-1", conversationId: "selected", seq: 1, role: "user", content: "原始正文\n第二行",
    plan: null, toolName: null, toolArgs: null, toolResult: null, confirm: null, taskId: null, assetId: null,
    assetRefs: ["asset-1"], documents: [{ id: "doc-1", name: "脚本.md", charCount: 16 }],
    status: "ok", errorMessage: null, createdAt: "2026-11-21T05:00:00.000Z" };
  const call: ChatMessage = { ...user, id: "call-1", seq: 2, role: "assistant", content: "", assetRefs: [], documents: [],
    toolName: "generate_image", toolArgs: { prompt: "生成提示词", apiKey: "fixture-secret" } };
  const result: ChatMessage = { ...call, id: "result-1", seq: 3, role: "tool", toolArgs: null, content: "生成失败详情",
    taskId: "task-1", status: "error", errorMessage: "渠道暂不可用", toolResult: { ok: false, summary: "上游错误", error: "UPSTREAM_502" } };
  const media: CanvasAsset = { round: 1, prompt: "", source: "upload", asset: { id: "asset-1", taskId: "upload", fileName: "参考图.png", mimeType: "image/png",
    url: "/api/assets/asset-1/file", byteSize: 64, createdAt: user.createdAt } };
  const clipboard = vi.fn().mockResolvedValue(undefined);
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  const { unmount } = await mountChat([user, call, result], [media]);
  try {
    const rows = [...document.querySelectorAll(".chat-copyable-row")];
    expect(rows).toHaveLength(2);
    await act(async () => button(rows[1]!, "复制").click());
    const card = clipboard.mock.lastCall?.[0];
    expect(card).toContain("生成失败详情");
    expect(card).not.toContain("生成提示词");
    expect(card).not.toContain("UPSTREAM_502");
    expect(card).not.toContain("task-1");
    expect(card).not.toContain("fixture-secret");

    await act(async () => button(document, "复制整个会话").click());
    const conversation = clipboard.mock.lastCall?.[0];
    expect(conversation).toContain("# 广告分镜");
    expect(conversation).toContain(user.content);
    expect(conversation).toContain("脚本.md");
    expect(conversation).toContain("参考图.png");
    expect(conversation).toContain("生成失败详情");
    expect(conversation).not.toContain("task-1");
    expect(conversation).not.toContain("UPSTREAM_502");
    expect(conversation).not.toContain("fixture-secret");
  } finally {
    unmount();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("复制图文消息再粘贴时，图片还原成附件、正文插回输入框", async () => {
  const id = "4a4f0f5e-9a47-4f3f-9f1e-6b6c5d4e3a2b";
  const time = "2026-11-23T01:03:09.196Z";
  const asset = { id, taskId: "upload", title: "参考图.png", fileName: "stored.png", mimeType: "image/png",
    url: `/api/assets/${id}/file`, byteSize: 3, createdAt: time };
  const user: ChatMessage = {
    id: "image-message", conversationId: "selected", seq: 1, role: "user", content: "这是啥？",
    plan: null, toolName: null, toolArgs: null, toolResult: null, confirm: null, taskId: null, assetId: id, assetRefs: [], documents: [],
    status: "ok", errorMessage: null, createdAt: time,
  };
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const file = new File(["png"], "参考图.png", { type: "image/png" });
  const readFile = vi.spyOn(api, "assetAsFile").mockResolvedValue(file);
  const { unmount } = await mountChat([user], [{ round: 1, prompt: "", source: "upload", asset }]);
  try {
    const row = document.querySelector(".chat-copyable-row")!;
    expect(row.querySelectorAll(".chat-message-copy")).toHaveLength(1);
    await act(async () => button(row, "复制").click());
    const copied = writeText.mock.lastCall![0];
    expect(copied).toContain("这是啥？");
    expect(copied).toContain(`chatcanvas://asset/${id}/`);
    expect(copied).not.toContain("附件：参考图.png");

    const input = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => copied } });
    await act(async () => { input.dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe("这是啥？");
    expect(document.querySelector(".composer-attachments img")?.getAttribute("alt")).toBe(asset.title);
    expect(readFile).toHaveBeenCalledExactlyOnceWith({ url: asset.url, fileName: asset.title, mimeType: "" }, expect.any(AbortSignal));
  } finally {
    unmount();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("复制带文档的消息再粘贴时，文档还原成附件、正文插回输入框", async () => {
  const documentId = "e2c1a9f4-6b7d-4c3e-9f10-2a3b4c5d6e7f";
  const time = "2026-11-23T01:03:09.196Z";
  const user: ChatMessage = {
    id: "document-message", conversationId: "selected", seq: 1, role: "user", content: "按这个改",
    plan: null, toolName: null, toolArgs: null, toolResult: null, confirm: null, taskId: null, assetId: null, assetRefs: [],
    documents: [{ id: documentId, name: "剧情.md", charCount: 12 }],
    status: "ok", errorMessage: null, createdAt: time,
  };
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const file = new File(["第一场：公园。"], "剧情.md", { type: "application/octet-stream" });
  const readFile = vi.spyOn(api, "conversationDocumentAsFile").mockResolvedValue(file);
  const { unmount } = await mountChat([user]);
  try {
    const row = document.querySelector(".chat-copyable-row")!;
    await act(async () => button(row, "复制").click());
    const copied = writeText.mock.lastCall![0];
    expect(copied).toContain("按这个改");
    expect(copied).toContain(`chatcanvas://document/selected/${documentId}/`);

    const input = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => copied } });
    await act(async () => { input.dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe("按这个改");
    expect(readFile).toHaveBeenCalledExactlyOnceWith("selected", documentId, "剧情.md", expect.any(AbortSignal));
    expect(document.querySelector(".composer-attachments")?.textContent).toContain("剧情.md");
  } finally {
    unmount();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it.each([
  ["音频", "audio/mpeg", "配音.mp3", "audio-message"],
  ["视频", "video/mp4", "原片.mp4", "video-message"],
] as const)("%s消息也只有一个复制入口，复制内容包含附件名", async (label, mimeType, name, messageId) => {
  const id = label === "音频" ? "7c2d5e18-3f4a-4b6c-8d9e-0f1a2b3c4d5e" : "6d86e2a8-c98b-4be2-9dc1-d9a2eaa437be";
  const time = "2026-11-23T01:03:09.196Z";
  const asset = { id, taskId: "upload", title: name, fileName: `stored-${name}`, mimeType,
    url: `/api/assets/${id}/file`, byteSize: 3, createdAt: time };
  const user: ChatMessage = {
    id: messageId, conversationId: "selected", seq: 1, role: "user", content: `上传了${label} ${name}`,
    plan: null, toolName: null, toolArgs: null, toolResult: null, confirm: null, taskId: null, assetId: id, assetRefs: [], documents: [],
    status: "ok", errorMessage: null, createdAt: time,
  };
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const file = new File(["media"], name, { type: mimeType });
  const readFile = vi.spyOn(api, "assetAsFile").mockResolvedValue(file);
  const { unmount } = await mountChat([user], [{ round: 1, prompt: "", source: "upload", asset }]);
  try {
    const row = document.querySelector(".chat-copyable-row")!;
    expect(row.querySelectorAll(".chat-message-copy")).toHaveLength(1);
    await act(async () => button(row, "复制").click());
    const copied = writeText.mock.lastCall![0];
    expect(copied).toBe(`chatcanvas://asset/${id}/${encodeURIComponent(name)}`);

    const input = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => copied } });
    await act(async () => { input.dispatchEvent(paste); });
    expect(readFile).toHaveBeenCalledExactlyOnceWith({ url: asset.url, fileName: name, mimeType: "" }, expect.any(AbortSignal));
    expect(document.querySelector(".composer-attachments")?.textContent).toContain(name);
  } finally {
    unmount();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("粘贴旧的音视频引用仍会挂成附件，点击发送才上传原文件", async () => {
  const id = "6d86e2a8-c98b-4be2-9dc1-d9a2eaa437be";
  const time = "2026-11-23T01:03:09.196Z";
  const asset = { id, taskId: "upload", title: "原片.mp4", fileName: "stored.mp4", mimeType: "video/mp4",
    url: `/api/assets/${id}/file`, byteSize: 3, createdAt: time };
  const user: ChatMessage = {
    id: "video-message", conversationId: "selected", seq: 1, role: "user", content: "上传了视频 原片.mp4",
    plan: null, toolName: null, toolArgs: null, toolResult: null, confirm: null, taskId: null, assetId: id, assetRefs: [], documents: [],
    status: "ok", errorMessage: null, createdAt: time,
  };
  const { unmount } = await mountChat([user], [{ round: 1, prompt: "", source: "upload", asset }]);
  const file = new File(["mp4"], "原片.mp4", { type: "video/mp4" });
  const readFile = vi.spyOn(api, "assetAsFile").mockResolvedValue(file);
  const upload = vi.spyOn(api, "uploadConversationMedia").mockImplementation((conversationId) => api.conversation(conversationId));
  try {
    const copied = `chatcanvas://video/${id}/${encodeURIComponent(asset.title)}`;
    const input = document.querySelector<HTMLTextAreaElement>(".composer-input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [], getData: () => copied } });
    await act(async () => { input.dispatchEvent(paste); });
    expect(paste.defaultPrevented).toBe(true);
    expect(readFile).toHaveBeenCalledExactlyOnceWith({ url: asset.url, fileName: asset.title, mimeType: "" }, expect.any(AbortSignal));
    expect(document.querySelector(".composer-attachments")?.textContent).toContain(asset.title);
    expect(upload).not.toHaveBeenCalled();

    await act(async () => button(document, "发送").click());
    expect(upload).toHaveBeenCalledExactlyOnceWith("selected", [file]);
  } finally { unmount(); }
});

it("删除请求进行时防止重复提交，失败后保留会话和错误信息", async () => {
  const { selected, sidebar, unmount } = await mountChat();
  let reject!: (error: Error) => void;
  const remove = vi.spyOn(api, "deleteConversation").mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  try {
    await act(async () => button(sidebar, "删除会话").click());
    const confirm = button(dialog()!, "移到最近删除");
    await act(async () => { confirm.click(); confirm.click(); });
    expect(remove).toHaveBeenCalledExactlyOnceWith(selected.id);
    expect(button(dialog()!, "正在删除…").disabled).toBe(true);
    await act(async () => { reject(new Error("删除失败，请稍后重试")); });
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("删除失败，请稍后重试");
    expect(button(dialog()!, "移到最近删除").disabled).toBe(false);
    expect(sidebar.textContent).toContain(selected.title);
  } finally { unmount(); }
});

it("最近删除中的永久删除仍需单独确认", async () => {
  const { selected, sidebar, unmount } = await mountChat();
  vi.spyOn(api, "trashedConversations").mockResolvedValue([{ id: "trashed", title: selected.title, deletedAt: "2026-11-20T00:00:00Z", expiresAt: "2026-12-20T00:00:00Z" }]);
  const purge = vi.spyOn(api, "purgeConversation").mockResolvedValue({ deleted: true });
  try {
    await act(async () => button(sidebar, "最近删除").click());
    const trash = document.querySelector(".conversation-trash-dialog")!;
    await act(async () => button(trash, "永久删除").click());
    expect(dialog()?.textContent).toContain(selected.title);
    expect(purge).not.toHaveBeenCalled();
    await act(async () => button(dialog()!, "永久删除").click());
    expect(purge).toHaveBeenCalledExactlyOnceWith("trashed");
    expect(trash.textContent).toContain("没有已删除的会话");
  } finally { unmount(); }
});
