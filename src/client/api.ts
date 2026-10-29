import type { ApiResponse, Asset, BootstrapData, Channel, ChannelInput, ClearScope, Diagnostic, GenerationInput, ImageSizeValue, Settings, Task, TaskKind } from "../shared/types";
import type {
  AgentStreamEvent, ConversationInput, ConversationPatch, ConversationSummary, ConversationView,
} from "../shared/agent-types";
import type {
  BoardAudioKind, BoardDoc, BoardSummary, BoardUiState, BoardView, BoardViewport, BoardVideoMode,
} from "../shared/board";
import type { CanvasTemplate, CanvasTemplateSummary } from "../shared/canvas-template";

const apiBase = import.meta.env.VITE_API_BASE_URL
  || (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost")
    ? "http://127.0.0.1:17892"
    : "");

function apiUrl(url: string) {
  return `${apiBase}${url}`;
}

/** 桌面版才有原生对话框、原生保存等能力，Web 开发模式要单独降级处理 */
export function isTauriRuntime() {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window
      || window.location.protocol === "tauri:"
      || window.location.hostname === "tauri.localhost");
}

function assetExtension(asset: Asset) {
  const fileExtension = asset.fileName.split(".").pop()?.toLowerCase();
  /*
   * 文件名只有和 mimeType 对得上才能信。
   * 旧版本把 Gemini 的图片 inlineData 当音频存过，磁盘上真的会出现
   * `xxx.m4a` + `image/png` 的组合；照着文件名下载会得到一个打不开的图片。
   */
  const compatible = asset.mimeType.startsWith("image/")
    ? ["png", "jpg", "jpeg", "webp", "gif"]
    : asset.mimeType.startsWith("video/")
      ? ["mp4", "webm", "mov", "m4v", "mkv"]
      : asset.mimeType.startsWith("audio/")
        ? ["wav", "mp3", "m4a", "aac", "ogg", "flac"]
        : [];
  if (fileExtension && compatible.includes(fileExtension)) return fileExtension;
  if (asset.mimeType === "image/jpeg") return "jpg";
  if (asset.mimeType === "image/webp") return "webp";
  if (asset.mimeType.startsWith("video/")) {
    if (asset.mimeType === "video/mp4") return "mp4";
    if (asset.mimeType === "video/webm") return "webm";
    if (asset.mimeType === "video/quicktime") return "mov";
    return "mp4";
  }
  if (asset.mimeType.startsWith("audio/")) {
    if (asset.mimeType.includes("mpeg")) return "mp3";
    if (asset.mimeType.includes("wav")) return "wav";
    if (asset.mimeType.includes("ogg")) return "ogg";
    if (asset.mimeType.includes("flac")) return "flac";
    return "m4a";
  }
  return "png";
}

/**
 * 带状态码和错误码的接口错误。
 *
 * 调用方有时候必须区分「这条数据没了」和「这次请求失败了」——比如会话在别处被删掉时，
 * 继续拿着那个 id 刷新只会一直报「会话不存在」，正确的反应是把指针放掉。
 * 只保留 message 的话这个判断就做不了。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    /** 服务端附带的上下文，例如版本冲突时的当前无限画布 */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(apiUrl(url), {
    ...init,
    headers: isFormData ? { ...(init?.headers ?? {}) } : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new ApiError(
      payload.error?.message ?? `请求失败：HTTP ${response.status}`,
      response.status,
      payload.error?.code ?? "",
      payload.error?.details,
    );
  }
  return payload.data;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  saveChannel: (input: ChannelInput, id?: string) => request<Channel>(id ? `/api/channels/${id}` : "/api/channels", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(input),
  }),
  deleteChannel: (id: string) => request<{ deleted: true }>(`/api/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: string) => request<{ reachable: boolean; httpStatus: number; durationMs?: number; message?: string }>(`/api/channels/${id}/test`, { method: "POST" }),
  /**
   * `maskFile` 是局部重绘蒙版（PNG）。有蒙版时必须走 multipart，哪怕参考图数组为空——
   * 服务端会明确拒绝「只有蒙版没有底图」，但不该在这之前把蒙版悄悄丢掉。
   */
  generate: (input: GenerationInput, referenceFiles: File[] = [], maskFile?: File | null) => {
    if (!referenceFiles.length && !maskFile) return request<Task>("/api/generations", { method: "POST", body: JSON.stringify(input) });
    const formData = new FormData();
    const payload = { ...input, referenceImages: undefined, referenceImage: undefined, maskImage: undefined };
    formData.append("payload", JSON.stringify(payload));
    referenceFiles.forEach((file) => formData.append("referenceImages", file, file.name));
    if (maskFile) formData.append("mask", maskFile, maskFile.name);
    return request<Task>("/api/generations", { method: "POST", body: formData });
  },
  task: (id: string) => request<Task>(`/api/generations/${id}`),
  tasks: () => request<Task[]>("/api/generations"),
  library: () => request<Task[]>("/api/library"),
  libraryPage: (options: { offset?: number; query?: string; kind?: string; mode?: string }) => {
    const params = new URLSearchParams({ limit: "60", offset: String(options.offset ?? 0), q: options.query ?? "", kind: options.kind ?? "all", mode: options.mode ?? "all" });
    return request<{ items: Task[]; hasMore: boolean }>(`/api/library?${params}`);
  },
  cancel: (id: string) => request<Task>(`/api/generations/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<Task>(`/api/generations/${id}/retry`, { method: "POST" }),
  midjourneyAction: (id: string, customId: string, label?: string) =>
    request<Task>(`/api/generations/${id}/action`, {
      method: "POST",
      body: JSON.stringify({ customId, ...(label ? { label } : {}) }),
    }),
  /** keepFiles：只删记录，磁盘上的图片视频留着 */
  deleteTask: (id: string, keepFiles = false) => request<{ deleted: true }>(`/api/generations/${id}${keepFiles ? "?keepFiles=1" : ""}`, { method: "DELETE" }),
  /** 一次请求清空一批记录，避免前端逐条 DELETE 排队 */
  clearTasks: (scope: ClearScope, keepFiles = false) => request<{ deleted: number; keepFiles: boolean }>(
    `/api/generations?scope=${scope}&keepFiles=${keepFiles ? "1" : "0"}`,
    { method: "DELETE" },
  ),
  /** 只删勾选的那些记录：和清空历史同一个接口，用 ids 指定范围 */
  deleteTasks: (ids: string[], keepFiles = false) => request<{ deleted: number; keepFiles: boolean }>(
    "/api/generations/batch-delete",
    { method: "POST", body: JSON.stringify({ ids, keepFiles }) },
  ),
  diagnostics: (id: string) => request<Diagnostic[]>(`/api/generations/${id}/diagnostics`),
  settings: () => request<Settings>("/api/settings"),
  /** assetsDir 传空串表示恢复默认目录；默认模型 alias 传空串表示「不指定，用类目第一个」 */
  updateSettings: (input: {
    assetsDir?: string;
    geminiImageSize?: ImageSizeValue;
    agentDefaultImageAlias?: string;
    agentDefaultVideoAlias?: string;
    agentDefaultMusicAlias?: string;
    agentDefaultSpeechAlias?: string;
    /** @deprecated 旧版合并的音频默认值，新代码用上面两个 */
    agentDefaultAudioAlias?: string;
  }) => request<Settings>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(input),
  }),
  revealMedia: (kind: "assets" | "inputs" | "data" = "assets") => request<{ opened: string }>("/api/system/reveal-media", {
    method: "POST",
    body: JSON.stringify({ kind }),
  }),
  /**
   * 原生文件夹选择器。桌面版之外返回 null，调用方据此提示用户
   * （Web 开发模式没有原生对话框，也不该让后端去弹一个）。
   */
  pickDirectory: async (title = "选择素材目录"): Promise<string | null> => {
    if (!isTauriRuntime()) return null;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  },
  // ── 对话式 Agent ──────────────────────────────────────────────────────────

  /** 能当大脑的渠道（只有对话适配器） */
  brains: () => request<Array<{ id: string; name: string; models: string[] }>>("/api/agent/brains"),
  /** §6 能力清单原文：和喂给大脑的是同一份，展示给用户看不会「说的和做的不一样」 */
  capabilities: () => request<{
    manifest: string;
    aliases: Array<{
      alias: string;
      kind: TaskKind;
      model: string;
      channelName: string;
      channelId: string;
      /** 音乐（suno-music）和语音（gemini-tts）同属 audio，靠它区分 */
      adapterType: string;
    }>;
  }>("/api/agent/capabilities"),
  /** 工作台的提示词润色：调用对话模型，只返回改写后的文本 */
  optimizePrompt: (prompt: string, target: "image" | "video" | "dialogue" | "sound") => request<{
    prompt: string;
    channelName: string;
    model: string;
  }>("/api/prompt/optimize", {
    method: "POST",
    body: JSON.stringify({ prompt, target }),
  }),
  conversations: () => request<Array<ConversationSummary & { running: boolean }>>("/api/conversations"),
  conversation: (id: string) => request<ConversationView & { running: boolean }>(`/api/conversations/${id}`),
  createConversation: (input: ConversationInput = {}) => request<ConversationView>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  deleteConversationAsset: (id: string, assetId: string) =>
    request<ConversationView>(`/api/conversations/${id}/assets/${assetId}`, { method: "DELETE" }),
  updateConversation: (id: string, patch: ConversationPatch) => request<ConversationView>(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }),
  deleteConversation: (id: string) => request<{ deleted: true }>(`/api/conversations/${id}`, { method: "DELETE" }),
  /**
   * 发一条消息。**立即返回**，模型输出走 `openConversationStream`。
   * 卡在这里等会撞上前端自己的超时——一趟生图几十秒，连接等不起。
   */
  sendMessage: (id: string, text: string, assetRefs: string[] = []) => request<{ accepted: true }>(`/api/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify(assetRefs.length ? { text, assetRefs } : { text }),
  }),
  interruptConversation: (id: string) => request<{ interrupted: boolean }>(`/api/conversations/${id}/interrupt`, { method: "POST" }),
  /**
   * 往对话里传图（需求.md 问题 4）。
   *
   * 走 multipart：图片本来就该按字节传，base64 塞进 JSON 只会让请求体再膨大三分之一。
   * 返回的是传完之后的整份会话视图——服务端顺手把新图设成了当前画布，
   * 前端直接拿它刷新即可，不用自己再补一次请求。
   */
  uploadConversationImages: (id: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append("images", file, file.name);
    return request<ConversationView>(`/api/conversations/${id}/uploads`, { method: "POST", body: form });
  },
  /** 脚本文档：内容本来就已经在内存里，直接走 JSON，不必再编一次 multipart */
  uploadConversationDocuments: (id: string, documents: Array<{ name: string; content: string }>) =>
    request<ConversationView>(`/api/conversations/${id}/documents`, {
      method: "POST",
      body: JSON.stringify({ documents }),
    }),
  // ── 无限画布（FREE_CANVAS_PLAN.md） ───────────────────────────────────────
  boards: () => request<BoardSummary[]>("/api/boards"),
  board: (id: string) => request<BoardView>(`/api/boards/${id}`),
  createBoard: (input: { title?: string } = {}) => request<BoardView>("/api/boards", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  importBoard: (file: unknown) => request<{ board: BoardView; missingAssets: string[] }>("/api/boards/import", {
    method: "POST",
    body: JSON.stringify({ file }),
  }),
  templates: () => request<CanvasTemplateSummary[]>("/api/templates"),
  template: (id: string) => request<CanvasTemplate>(`/api/templates/${id}`),
  updateTemplate: (id: string, patch: { name?: string; description?: string }) =>
    request<CanvasTemplate>(`/api/templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteTemplate: (id: string) =>
    request<{ deleted: true }>(`/api/templates/${id}`, { method: "DELETE" }),
  migrateStoryboards: (input: { replaceExisting?: boolean } = {}) => request<{
    migrated: Array<{
      conversationId: string; title: string; boardId: string; templateId: string; nodeCount: number; version: number;
    }>;
    skipped: number;
    failed: Array<{ conversationId: string; message: string }>;
  }>("/api/templates/migrate-storyboards", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  cleanupStoryboards: () => request<{ cleaned: string[]; skipped: number }>(
    "/api/templates/cleanup-storyboards",
    { method: "POST" },
  ),
  createBoardFromTemplate: (templateId: string, title?: string) =>
    request<BoardView>("/api/boards/from-template", {
      method: "POST",
      body: JSON.stringify({ templateId, ...(title ? { title } : {}) }),
    }),
  importTemplateToBoard: (boardId: string, templateId: string) =>
    request<{ board: BoardView; addedNodes: number }>(`/api/boards/${boardId}/templates`, {
      method: "POST",
      body: JSON.stringify({ templateId }),
    }),
  renameBoard: (id: string, title: string) => request<BoardView>(`/api/boards/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  }),
  saveBoard: (id: string, input: {
    doc: BoardDoc;
    viewport?: BoardViewport;
    baseVersion: number;
    reason?: string;
  }) => request<BoardView>(`/api/boards/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  }),
  saveBoardSelection: (id: string, selection: string[]) => request<{ saved: true }>(`/api/boards/${id}/selection`, {
    method: "PUT",
    body: JSON.stringify({ selection }),
  }),
  saveBoardUiState: (id: string, uiState: BoardUiState) => request<{ saved: true }>(`/api/boards/${id}/ui-state`, {
    method: "PUT",
    body: JSON.stringify({ uiState }),
  }),
  saveBoardViewport: (id: string, viewport: BoardViewport) => request<BoardView>(`/api/boards/${id}/viewport`, {
    method: "PUT",
    body: JSON.stringify({ viewport }),
  }),
  undoBoard: (id: string, baseVersion: number) => request<BoardView>(`/api/boards/${id}/undo`, {
    method: "POST",
    body: JSON.stringify({ baseVersion }),
  }),
  redoBoard: (id: string, baseVersion: number) => request<BoardView>(`/api/boards/${id}/redo`, {
    method: "POST",
    body: JSON.stringify({ baseVersion }),
  }),
  boardHistory: (id: string) => request<{
    currentVersion: number;
    entries: Array<{ version: number; reason: string; createdAt: string; current: boolean }>;
  }>(`/api/boards/${id}/history`),
  restoreBoardVersion: (id: string, version: number, baseVersion: number) =>
    request<BoardView>(`/api/boards/${id}/history/${version}/restore`, {
      method: "POST",
      body: JSON.stringify({ baseVersion }),
    }),
  generateBoardNode: (id: string, input: {
    nodeId: string;
    overrides?: {
      prompt?: string;
      model?: string;
      size?: string;
      imageSize?: string;
      quality?: string;
      count?: number;
      videoMode?: BoardVideoMode;
      durationSeconds?: number;
      resolution?: string;
      audio?: boolean;
      audioKind?: BoardAudioKind;
      voice?: string;
      ttsStyle?: string;
      instrumental?: boolean;
    };
  }) => request<{
    board: BoardView;
    task: Task | null;
    kind: "image" | "video" | "text" | "audio";
    resultNodeIds: string[];
    configNodeId: string;
    prompt: string;
    referenceCount: number;
    modelAlias: string;
  }>(`/api/boards/${id}/generate`, {
    method: "POST",
    body: JSON.stringify(input),
  }),
  cancelBoardTask: (id: string, taskId: string) =>
    request<Task>(`/api/boards/${id}/tasks/${taskId}/cancel`, { method: "POST" }),
  retryBoardTask: (id: string, taskId: string) =>
    request<{ task: Task; resultNodeIds: string[]; configNodeId: string }>(
      `/api/boards/${id}/tasks/${taskId}/retry`,
      { method: "POST" },
    ),
  boardAssets: (id: string) => request<Asset[]>(`/api/boards/${id}/assets`),
  linkBoardAsset: (id: string, assetId: string) => request<Asset>(`/api/boards/${id}/assets/${assetId}/link`, { method: "POST" }),
  addAssetsToBoard: (id: string, items: Array<{ assetId: string; title?: string; prompt?: string }>) =>
    request<{
      board: BoardView;
      added: Array<{ assetId: string; nodeRef: string }>;
      skipped: number;
    }>(`/api/boards/${id}/bridge/assets`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  appendConversationCanvas: (id: string, assetIds: string[]) =>
    request<{
      conversationId: string;
      canvasAssetIds: string[];
      added: string[];
      skipped: number;
    }>(`/api/conversations/${id}/canvas/append`, {
      method: "POST",
      body: JSON.stringify({ assetIds }),
    }),
  uploadBoardAsset: (id: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<Asset>(`/api/boards/${id}/assets`, { method: "POST", body: form });
  },
  deleteBoardAsset: (id: string, assetId: string) =>
    request<BoardView>(`/api/boards/${id}/assets/${assetId}`, { method: "DELETE" }),
  deleteBoard: (id: string) => request<{ threadId: string }>(`/api/boards/${id}`, { method: "DELETE" }),
  /**
   * §13.5 视频确认卡片 / 会话额度提醒的两个出口。
   *
   * `args` 是卡片上改过的视频参数。服务端执行的是落库的那份 `tool_args_json`，
   * 所以改动必须跟着这次确认一起提交——单独开个保存接口的话，
   * 用户改完直接点确认就会用上旧值。
   */
  confirmMessage: (id: string, messageId: string, decision: "approve" | "reject", args?: Record<string, unknown>) =>
    request<{ decision: string }>(`/api/conversations/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ messageId, decision, args }),
    }),

  /**
   * 会话事件流（§14）。
   *
   * 用 EventSource 而不是 fetch + ReadableStream：它是 GET、自带断线重连，
   * 而「发消息」和「收事件」分成两个请求之后，重连时不需要重放任何东西——
   * 重连成功会触发一次 `open`，调用方在那里重新拉一遍会话即可补齐错过的消息。
   */
  openConversationStream(
    id: string,
    handlers: {
      onEvent: (event: AgentStreamEvent) => void;
      onOpen?: () => void;
      onError?: () => void;
    },
  ): () => void {
    const source = new EventSource(apiUrl(`/api/conversations/${id}/events`));
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handlers.onEvent(JSON.parse(event.data) as AgentStreamEvent);
      } catch {
        // 单个坏掉的事件不该掐断整条流
      }
    };
    source.onopen = () => handlers.onOpen?.();
    source.onerror = () => handlers.onError?.();
    return () => source.close();
  },

  assetUrl: (url: string) => apiUrl(url),
  assetAsFile: async (asset: Asset) => {
    const response = await fetch(apiUrl(asset.url));
    if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const type = blob.type || asset.mimeType || "image/png";
    return new File([blob], asset.fileName, { type });
  },
  downloadAsset: async (asset: Asset) => {
    const separator = asset.url.includes("?") ? "&" : "?";
    const isVideo = asset.mimeType.startsWith("video/");
    const isAudio = asset.mimeType.startsWith("audio/");
    const fileType = isVideo ? "视频" : isAudio ? "音频" : "图片";

    if (isTauriRuntime()) {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const extension = assetExtension(asset);
      // 用修正后的扩展名拼默认文件名；旧记录里的 .m4a 图片也能存成 .png
      const stem = asset.fileName.replace(/\.[^.]+$/, "") || "asset";
      const defaultPath = `${stem}.${extension}`;
      const destination = await save({
        title: `保存${fileType}`,
        defaultPath,
        filters: [{ name: fileType, extensions: [extension] }],
      });
      if (!destination) return false;

      const response = await fetch(apiUrl(`${asset.url}${separator}download=1`));
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
      return true;
    }

    const response = await fetch(apiUrl(`${asset.url}${separator}download=1`));
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = `${asset.fileName.replace(/\.[^.]+$/, "") || "asset"}.${assetExtension(asset)}`;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    return true;
  },
};
