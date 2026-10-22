# 新模型接入与代码结构优化 · 开发计划

> 版本：v1 · 2026-10-21
> 范围：接入 Kling 视频、Suno 音乐；同时把「加一个新模型要改十几处」的结构问题收敛掉。
> 状态：Suno 已落地；Kling 按用户要求延后。

## 实施进度（2026-10-21）

| 阶段 | 状态 | 备注 |
|---|---|---|
| 0 基线 | 完成 | 257 个用例、`tsc` 0 错误 |
| 1 品类统一 | 完成 | `src/shared/kinds.ts`；图片/视频/音乐/对话 |
| 2 异步描述 | 完成 | `src/server/async-providers.ts`；三个视频已迁移 |
| 3 Kling | 完成 | `kling-video`，kling-3.0 / omni；真实联调待 `kling专属` 分组的 Key |
| 4 UI 去重 | 完成 | `src/client/task-ui.tsx` |
| 5 多产物/音频 | 完成 | 视频多结果全存；音频 + 封面落盘 |
| 6 Suno 工作台 | 完成 | `MusicGenerateView` + 历史筛选 + 全部 7 种模式 |
| 7 agent.ts 拆分 | 完成 | 计划 / 确认 / 批量 / 看图 / 任务事件 / 提示词 / 错误分类已拆出 |
| 8 generate_music | 完成 | 确认策略 `auto_only`，支持 cover/mashup/sound/playlist/sample |
| 9 ChatView/App 拆分 | 完成 | `GenerateView`、`HistoryView`、`ModelPanel`、`ConversationSidebar`、`AssetLightbox` 等 |
| 10 文档 | 进行中 | README / CHANGELOG / SUNO_HANDOFF 已更新 |

---

## 0. 目标

### 要达成的事

1. **Kling 视频**可用：文生、首帧、首尾帧、参考图；进入现有「生视频」工作台和对话 `generate_video`。
2. **Suno 音乐**可用：灵感/自定义歌词、纯音乐、标题与曲风；独立「音乐」工作台；对话新增 `generate_music`。
3. 把扩展成本从「改 N 处 switch」降为：
   **1 个适配器 + 1 份异步描述 + 1 个渠道预设 + 1 套测试**。
4. 结构优化以「不改行为」为前提，用现有 232 个测试做护栏。

### 明确不做

- Vidu、Midjourney、其他新视频模型本轮不接（但异步描述要留出位置）。
- 音频剪辑、歌单、音乐库管理、歌词生成独立入口。
- 数据库大重构、UI 视觉改版、Tauri/Rust 层改动。
- 不引入新的音频播放依赖，使用 HTML `<audio>` + 现有本地文件接口。

---

## 1. 基线

| 项目 | 现状 |
|---|---|
| TypeScript | `npx tsc --noEmit` 0 错误 |
| 测试 | 16 个文件、232 个用例全部通过 |
| 适配器 | 4 个图片、3 个视频、1 个对话 |
| 当前痛点 | `agent.ts` 1454 行上帝类；`ChatView` 单组件约 1090 行；图片/视频二元判断散布十几处；异步任务管线是视频专用；端点映射写在 3 个文件 |

### 关键约束

- 中转站请求体实测上限 1–2 MB，Kling 参考图必须继续走 1280 长边 JPEG 压缩。
- Suno 的 `audio_url` / `image_url` 会过期，成功后必须立即下载落盘。
- 桌面版与 Web 版共用同一套前端；新增媒体类型必须同时照顾 Tauri CSP（现有 `media-src` 已允许本地 API）。
- 一切重构必须先有测试，再动结构。

---

## 2. 总体策略

两条轨道并行推进，但每个 PR 只做一类事：

- **轨道 A（结构）**：统一品类 → 异步描述 → 多产物 → 拆上帝模块。
- **轨道 B（功能）**：Kling → Suno 工作台 → `generate_music`。

原则：

1. **先统一真相，再加模型**：`ChannelKind / TaskKind` 是唯一分类入口。
2. **一个异步轮询器**：不允许为 Suno 复制 `pollVideoTask`。
3. **先存全，再展示**：结果落盘保存全部强候选，展示层再决定怎么排。
4. **重构与功能分开提交**：每个 PR 要么只改结构，要么只加功能。
5. **每一步都能单独发版**：Kling 可以先上，Suno 可以后上。

---

## 3. 目标结构

### 3.1 品类模型

```ts
// src/shared/kinds.ts
export type ChannelKind = "image" | "video" | "audio" | "chat";
export type TaskKind = "image" | "video" | "audio";

export function channelKindOf(adapterType: AdapterType): ChannelKind;
export function isChannelKind(adapterType: AdapterType, kind: ChannelKind): boolean;
export function taskKindOf(task: Task, channels: Channel[]): TaskKind;
```

- 技术类型用 `audio`，界面文案用「音乐」。
- `isImageAdapter` 从「不是视频也不是对话」改成显式 `channelKindOf(...) === "image"`。
- 服务端的 `isVideoTaskRow` 改为共享 `taskKindOf`，删除 `endsWith("-video")`。
- `ClearScope` 扩展为 `"image" | "video" | "audio" | "all"`。

### 3.2 异步任务描述

```ts
// src/server/async-providers.ts
export interface AsyncProviderSpec {
  pollPath(taskId: string): string;
  extractTaskId(payload: unknown): string | null;
  extractStatus(payload: unknown): { status: string; progress: number | null; error?: string };
  extractResults(payload: unknown): ResultCandidate[];
  successStatuses: string[];
  failureStatuses: string[];
  pollIntervalMs?: number;
  maxPolls?: number;
}
```

- `TaskRunner.run()`：有 spec 且拿到远端 id → `pollAsyncTask()`；否则走同步图片路径。
- `resume()`：所有带 `remote_task_id` 且仍有 spec 的任务都恢复轮询。
- `pollAsyncTask()` 统一处理诊断、404、超时、取消、重启。
- 现有万相 / Grok / Seedance 先迁移到 spec，验证「行为不变」；Kling / Suno 只填表。

### 3.3 产物模型

```ts
type ResultCandidate = {
  kind: "image" | "video" | "audio";
  url?: string;
  base64?: string;
  mimeType?: string;
  duration?: number;
  coverUrl?: string;
  title?: string;
};
```

- `saveResults()` 按 kind 分派大小限制、扩展名、缩略图策略。
- **删除 `slice(0, 1)`**：视频 `n > 1`、音乐一次 2 首都必须全部保存。
- 音频封面复用 `assets.thumb_path`：下载 `image_url` 后走现有 `writeThumbnail()`，不新增表列。
- 音频 MIME 只用于播放与下载，不进入画布、不参与 `view_images`。

### 3.4 厂商参数

新厂商不再往 `GenerationInput` 顶部堆字段。新增：

```ts
providerOptions?: Record<string, unknown>;
```

Kling 的 `image_tail`、Suno 的 `title/tags/instrumental` 都放这里；旧字段保留，避免破坏老任务重试。

---

## 4. 里程碑

| 阶段 | 内容 | 可交付 | 人日 | 依赖 |
|---|---|---|---|---|
| 0 | 基线守护与测试夹具 | 现有行为可回归 | 0.5 | — |
| 1 | 统一 `ChannelKind / TaskKind` | 分类只有一处真相 | 1 | 0 |
| 2 | 异步描述 + 迁移 3 个视频适配器 | 一个轮询器，行为不变 | 2 | 1 |
| 3 | **Kling 视频** | 可用的第 4 个视频渠道 | 2–3 | 2 |
| 4 | 任务 UI 基础件去重 | 不再复制状态/格式化代码 | 0.5–1 | 1 |
| 5 | 多产物 + 音频落盘 | 视频多结果不丢、音频能存 | 1–2 | 3 |
| 6 | **Suno 工作台** | 不依赖对话的音乐生成 | 2–3 | 5 |
| 7 | `agent.ts` 按职责拆分 | 上帝类回到可维护规模 | 1–2 | 2 |
| 8 | **`generate_music` 工具** | 对话里能创作音乐 | 1.5–2.5 | 6、7 |
| 9 | `ChatView` / `App` 拆分与最终去重 | 前端结构收敛 | 1–2 | 8 |
| 10 | 文档、交接、发版 | 可维护、可发布 | 0.5–1 | 全部 |

合计约 **12–18 人日**（开发 + 自测，不含真实生成等待）。  
建议发布检查点：**A = 阶段 3 后（只有 Kling）**、**B = 阶段 6 后（Suno 工作台）**、**C = 阶段 8 后（对话音乐）**、**D = 阶段 10（结构整理完成）**。

---

## 5. 详细阶段

### 阶段 0：基线守护（0.5 人日）

**目标**：后面所有重构都有回归证据。

- 跑一遍 `npm test` 与 `npx tsc --noEmit`，记录基线。
- 新增测试夹具：
  - `tests/fixtures/kling/submit.json`、`poll-processing.json`、`poll-succeeded.json`、`poll-failed.json`
  - `tests/fixtures/suno/submit.json`、`poll-in-progress.json`、`poll-success-two-songs.json`、`poll-fail.json`
- 复用现有假上游方式（`tests/app.test.ts` / `video-selection.test.ts` 里的本地服务）。
- 不写生产代码。

**验收**：基线可重复；夹具不含真实密钥、真实 URL。

---

### 阶段 1：统一品类（1 人日）

**改动文件**

- `src/shared/kinds.ts`（新增）
- `src/shared/types.ts`
- `src/shared/agent-types.ts`
- `src/server/capabilities.ts`
- `src/server/db.ts`
- `src/server/app.ts`
- `src/client/App.tsx`
- `src/client/ChatView.tsx`
- `src/client/api.ts`
- `src/client/chat/ModelLogo.tsx`
- `src/client/channels/AddChannelWizard.tsx`
- `src/client/channels/ChannelsView.tsx`
- `src/client/onboarding/ImmersiveOnboarding.tsx`

**做法**

1. 新增 `ChannelKind / TaskKind` 与 `channelKindOf()`、`taskKindOf()`。
2. `isVideoAdapter` 保留为兼容别名；`isImageAdapter` 改为显式判断。
3. `CapabilityKind` 改为复用 `TaskKind`；`buildCapabilityAliases` 用 `channelKindOf`。
4. `ClearScope` 加 `audio`；后端清空接口按 `taskKindOf` 过滤。
5. 默认模型 alias 从 `{image, video}` 改为 `Partial<Record<TaskKind, string>>`，存储键仍沿用旧名，新增 `agentDefaultAudioAlias`。
6. 前端所有 `"image" | "video"` 内联联合类型改为引用共享类型。
7. `ModelLogo`、引导章节、渠道向导按 `ChannelKind` 渲染；本轮先不加音乐入口，只保证类型正确。

**测试**

- 表驱动：每个 `AdapterType` → 期望 `ChannelKind`。
- `taskKindOf`：有渠道 / 渠道已删 / 失败任务有产物 / 无产物。
- 断言仓库中不再出现 `adapterType.endsWith("-video")`。

**验收**

- 232 个测试全过，`tsc` 0 错误。
- 图片、视频工作台行为与改动前一致。
- 在测试里临时注册一个 `audio` 适配器，它能被正确归类，且不会出现在生图渠道列表。

---

### 阶段 2：异步描述与现有视频迁移（2 人日）

**改动文件**

- `src/server/async-providers.ts`（新增）
- `src/server/tasks.ts`
- `src/server/adapters.ts`（只保留提交请求构造）
- `src/shared/provider-presets.ts`（默认端点引用统一表）
- `src/server/agent.ts`（完成事件只做最小适配）

**做法**

1. 为万相、Grok、Seedance 各写一份 `AsyncProviderSpec`：
   - 提交端点仍由适配器构造；
   - 轮询路径、状态词表、结果提取、任务 id 提取进 spec。
2. `pollVideoTask` 改名为 `pollAsyncTask`，内部只依赖 spec。
3. `extractAsyncTaskId` 支持 `{ data: "task_id" }`（为 Suno 铺路）。
4. 失败状态补 `fail`；成功状态补 `SUCCESS` 的小写形式。
5. `resume()` 按 spec 判断，不再写死 `isVideoAdapterType`。
6. 端点默认值收进 `src/shared/adapter-endpoints.ts`，`adapters.ts`、`provider-presets.ts`、`tasks.ts` 共用。

**测试**

- 三家视频的提交 → 轮询 → 成功/失败/404/超时。
- 重启恢复：有 `remote_task_id` 的任务继续轮询。
- 诊断记录仍保持「首尾完整 + 中间精简」。

**验收**

- 行为与改动前一致，测试全过。
- 全仓库只有一个异步轮询实现。
- 新增异步厂商只需实现 spec，不改 `TaskRunner`。

---

### 阶段 3：Kling 视频（2–3 人日）

**改动文件**

- `src/server/async-providers.ts`（新增 Kling spec）
- `src/server/adapters.ts`（新增 `kling-video` 请求构造）
- `src/shared/types.ts`（`AdapterType`、`VIDEO_ADAPTER_TYPES`）
- `src/shared/video-capabilities.ts`
- `src/shared/provider-presets.ts`
- `src/shared/model-catalog.ts`
- `src/server/capabilities.ts`（alias 前缀 `kling`、能力摘要）
- `src/client/VideoGenerateView.tsx`（复用现有模式选择器）
- 测试文件

**协议（以实际联调为准）**

- 提交：`POST /v1/video/generations`
- 轮询：`GET /v1/video/generations/{task_id}`
- 请求：`model / prompt / duration / width / height / image / metadata { image_tail, negative_prompt, seed } / response_format`
- 状态：`processing / succeeded / failed`，结果在顶层 `url`

**模型与能力**

| 模型 | 本轮支持 |
|---|---|
| `kling-3.0` | 文生、首帧、首尾帧、参考图；3–15s；720P/1080P/4K；原生音频 |
| `kling-3.0-turbo` | 同上，保守档先只开 720P/1080P |
| `kling-3.0-omni` | 本轮按基础三模式接；视频/主体参考只走高级 JSON |

- 在 `video-capabilities.ts` 增加「按模型覆盖」的小函数；不要为三个模型复制三张适配器表。
- Key 独立：`TIANTOKEN_KLING_VIDEO_API_KEY`；联调前确认 Key 组。

**测试**

- 请求体快照：首帧、首尾帧、参考图、无图。
- 轮询夹具：processing → succeeded / failed。
- 图片内联体积：超过 1.4M 字符时提前报错。
- 真实冒烟：5 秒 720P 文生视频一条。

**验收**

- 视频工作台可选 Kling 三个模型。
- 任务提交、轮询、落盘、历史、诊断、重启恢复全部可用。
- 对话 `generate_video` 可直接选到 Kling，无需新工具。

---

### 阶段 4：任务 UI 基础件去重（0.5–1 人日）

**改动文件**

- `src/client/task-ui.tsx`（新增：`StatusBadge`、`statusLabels`、`terminalStatuses`、`formatTime`、`optionalNumber`、`usePersistentState`）
- `src/client/App.tsx`
- `src/client/VideoGenerateView.tsx`

**做法**

- 把两份完全相同的常量与小组件搬到共享文件。
- `usePersistentState` 接受 storage prefix 参数，图片/视频各用自己的前缀。
- 不改任何视觉与交互。

**验收**

- 两个工作台视觉无变化。
- 仓库中这些符号只剩一份定义。

---

### 阶段 5：多产物与音频落盘（1–2 人日）

**改动文件**

- `src/server/async-providers.ts`
- `src/server/tasks.ts`
- `src/server/vision.ts`（新增 `writeCoverThumbnail`）
- `src/server/app.ts`（缩略图接口允许音频封面）
- `src/client/api.ts`（下载扩展名支持 mp3/wav/m4a）
- `src/client/App.tsx`（历史卡片支持音频）

**做法**

1. `ResultCandidate` 统一图片/视频/音频。
2. `saveResults()`：
   - 图片沿用现有逻辑；
   - 视频保存全部强候选，不再 `slice(0, 1)`；
   - 音频保存全部歌曲，下载封面并写入 `thumb_path`；
   - 音频时长写入现有 `assets.duration`。
3. `/api/assets/:id/thumb`：音频有封面时返回封面；没有则 404。
4. `/api/assets/:id/file` 已支持 Range，不改。
5. 历史卡片：音频显示封面 + 标题/时长 + 播放器；不参与双击放大。

**测试**

- Suno 夹具一次两首：落两条 asset，两个封面。
- 视频 `n=2` 夹具：落两条视频。
- 重复 URL 去重。
- 音频 Range 请求返回 206。
- 音频不进画布：`set_canvas` 拒绝，`view_images` 忽略。

**验收**

- 不再有「只保存第一个结果」的路径。
- 音频可播放、可下载、可删除、可清空。

---

### 阶段 6：Suno 工作台（2–3 人日）

**改动文件**

- `src/server/async-providers.ts`（Suno spec）
- `src/server/adapters.ts`（`suno-music` 请求构造）
- `src/shared/types.ts`
- `src/shared/provider-presets.ts`
- `src/shared/model-catalog.ts`
- `src/shared/kinds.ts`（`audio` 能力）
- `src/client/MusicGenerateView.tsx`（新增）
- `src/client/App.tsx`（导航、历史筛选、清空范围）
- `src/client/styles.css`

**协议**

- 提交：`POST /suno/submit/music`
- 轮询：`GET /suno/fetch/{task_id}`
- 状态：`IN_PROGRESS / SUCCESS / FAIL`
- 结果：`data[]`，每首含 `audio_url`、`image_url`、`metadata.duration`、`title`

**模型**

- `suno_damobi_music`

**输入**

- 模式：灵感描述 / 自定义歌词
- 字段：`prompt`、`title`、`tags`、`make_instrumental`
- 高级 JSON 透传，保留 `mv`、`continue_*` 等逃生口

**界面**

- 侧栏新增「音乐」
- 参数面板：模式切换、歌词/描述、标题、曲风、纯音乐
- 结果：歌曲列表（封面、标题、时长、播放、下载）
- 历史新增「音乐」筛选；清空范围新增音乐
- 失败文案直接显示 `fail_reason`

**测试**

- 提交体：灵感 / 自定义 / 纯音乐。
- 轮询：进行中 → 两首成功 / 失败。
- URL 过期场景：下载失败时给出明确错误，不把任务误判为成功。
- 真实冒烟：一次生成（确认费用后手动执行）。

**验收**

- 不进对话也能完整创作、试听、下载、管理历史。
- 音乐渠道不出现在生图/生视频渠道下拉里。

---

### 阶段 7：`agent.ts` 拆分（1–2 人日）

**目标**：行为不变，把 1454 行类降到 900 行以内。

**拆分边界**

| 新模块 | 从 `agent.ts` 迁出 |
|---|---|
| `agent-plan.ts` | `normalizePlan`、`normalizeCalls`、`normalizeConsistency`、`proseOutsidePlan`、`resolveBatch` |
| `agent-confirm.ts` | `shouldConfirm`、`buildConfirmPreview`、`mergeConfirmArgs`、`CONFIRM_OVERRIDABLE_ARGS` |
| `agent-batch.ts` | `executeBatch`、`executeParallel`、`executeConsistent`、`beginBatch`、`finishBatch` |
| `agent-vision.ts` | `observeImages`、`degradeVision`、`visionBlocked`、`buildBrainMessages` 中的视觉部分 |
| `agent-task-events.ts` | `handleTaskEvent`、`settleFinishedTasks` |

**做法**

- 一次只迁一个模块，纯搬移，不改逻辑。
- `AgentService` 保留：公开入口、会话状态、SSE、主循环、依赖持有。
- 每迁一块，原有端到端测试必须全过；再给迁出的纯函数补直接单测。

**验收**

- 232+ 测试全过。
- `agent.ts` 文件 < 900 行；`AgentService` < 800 行。
- 没有循环依赖；`tsc` 0 错误。

---

### 阶段 8：`generate_music`（1.5–2.5 人日）

**改动文件**

- `src/shared/agent-types.ts`
- `src/server/agent-tools.ts`
- `src/server/agent-confirm.ts`
- `src/server/agent-task-events.ts`
- `src/server/capabilities.ts`
- `src/client/chat/ToolCard.tsx`
- `src/client/chat/ConfirmCard.tsx`（或新增 `MusicConfirmCard.tsx`）
- `src/server/app.ts`（默认音频模型设置）

**工具参数**

```ts
interface GenerateMusicArgs {
  prompt: string;          // 灵感描述或歌词
  mode?: "inspiration" | "custom";
  title?: string;
  tags?: string;
  instrumental?: boolean;
  modelHint?: string;
}
```

**规则**

- 加入 `GENERATION_TOOLS`，计入会话任务额度。
- 与视频一样**不可并行**；不进 `BATCHABLE_TOOLS`。
- 默认确认：音乐按次计费且一次两首，建议默认「每次都问」。
- `ToolResult` 增加 `assetIds?: string[]`，保留 `assetId` 兼容旧卡片。
- 完成事件按 `TaskKind` 生成摘要：
  - 音频：「生成了 2 首歌：标题 A / 标题 B」
  - 视频：「视频生成完成」
- 音频不移动画布；`IMAGE_PRODUCING_TOOLS` 不变。
- `optimize_prompt` 的 `target` 增加 `music`，或明确音乐不支持优化。

**测试**

- 工具 schema 与参数归一。
- 确认闸门：音乐默认必须确认；「直接生成」策略下也受额度限制。
- 异步等待：提交 → 完成事件 → 消息回写 → 大脑续跑。
- 结果卡片：两首音频都能播放、下载。
- 批量：`generate_music + generate_image` 只执行第一个并说明原因。

**验收**

- 对话里「写一首关于…的歌」能完成规划、确认、生成、试听。
- 不会绕过确认直接扣费。

---

### 阶段 9：前端结构收尾（1–2 人日）

**目标**：避免下一个品类再复制一份。

- `ChatView.tsx` 拆为：
  - `useConversationStream`（SSE、状态、消息合并）
  - `useConversationList`
  - `ConversationSidebar`
  - `MessageThread`
  - `ModelPanel`
  - `ChatView` 只保留组合与布局
- `App.tsx` 拆出：
  - `views/GenerateView.tsx`
  - `views/HistoryView.tsx`
  - `dialogs/ClearHistoryDialog.tsx`、`SettingsDialog.tsx`、`DiagnosticDialog.tsx`
- 目标（不作为硬门禁）：单文件 < 800 行，单组件 < 500 行。

**验收**

- 视觉与交互无变化。
- 新增一个工作台的改动面从「改 App + 复制一套 helpers」变成「新增一个 view 文件 + 一个导航项」。

---

### 阶段 10：文档与发版（0.5–1 人日）

- 更新 `README.md`：音乐能力、Kling 渠道、Key 说明。
- 更新 `DEVELOPMENT_HANDOFF.md`：新模块图、扩展步骤。
- 新增 `PROVIDER_GUIDE.md`：
  - 如何新增一个同步图片渠道
  - 如何新增一个异步视频/音频渠道
  - 需要改哪些文件、跑哪些测试
- 更新 `CHANGELOG.md`，按现有流程升版本、打包。
- 明确交接：`async-providers.ts` 是新增异步厂商的唯一入口；`kinds.ts` 是分类的唯一入口。

---

## 6. 文件改动地图

| 文件 | 阶段 | 说明 |
|---|---|---|
| `src/shared/kinds.ts` | 1 | 新增，分类唯一真相 |
| `src/shared/types.ts` | 1、3、6 | 适配器集合、`providerOptions`、音频类型 |
| `src/shared/agent-types.ts` | 1、8 | `CapabilityKind`、`GenerateMusicArgs`、`assetIds` |
| `src/shared/adapter-endpoints.ts` | 2 | 新增，端点唯一真相 |
| `src/server/async-providers.ts` | 2、3、6 | 新增，异步描述与轮询 |
| `src/server/tasks.ts` | 2、5 | 通用轮询、多产物落盘 |
| `src/server/adapters.ts` | 2、3、6 | 提交请求构造 |
| `src/server/agent.ts` | 2、7 | 完成事件、拆分 |
| `src/server/agent-tools.ts` | 5、8 | 工具与音频参数 |
| `src/server/capabilities.ts` | 1、3、6、8 | 分类、alias、能力清单 |
| `src/server/db.ts` | 1、5 | 任务分类、音频封面（优先不改表） |
| `src/server/vision.ts` | 5 | `writeCoverThumbnail` |
| `src/server/app.ts` | 1、5、8 | 清空范围、缩略图、默认模型设置 |
| `src/client/task-ui.tsx` | 4 | 新增，共享 UI 基础件 |
| `src/client/MusicGenerateView.tsx` | 6 | 新增 |
| `src/client/App.tsx` | 1、6、9 | 导航、历史、拆分 |
| `src/client/ChatView.tsx` | 1、8、9 | 类型、上下文、拆分 |
| `src/client/chat/ToolCard.tsx` | 8 | 音频结果卡 |
| `src/client/chat/ConfirmCard.tsx` | 8 | 音乐确认卡 |
| `src/client/VideoGenerateView.tsx` | 3、4 | Kling 能力、去重 |
| `src/shared/provider-presets.ts` | 2、3、6 | 渠道预设 |
| `src/shared/model-catalog.ts` | 3、6 | 模型分组与推荐 |

---

## 7. 测试计划

### 单元测试

- `kinds.test.ts`：所有适配器 → `ChannelKind`；所有任务场景 → `TaskKind`。
- `async-providers.test.ts`：三家视频 + Kling + Suno 的提交 id、状态、结果提取。
- `music-request.test.ts`：Suno 灵感 / 自定义 / 纯音乐请求体。
- `agent-confirm.test.ts`：音乐确认、视频确认、额度确认。
- `results.test.ts`：多视频、两首歌、重复 URL、封面。

### 集成测试

- 假上游完整流程：提交 → 轮询 → 落盘 → 历史 → 删除 / 清空。
- 重启恢复：进程重启后带 `remote_task_id` 的音乐和视频继续轮询。
- 诊断：首尾完整、中间精简；不含密钥、不含内联 base64 原文。
- 媒体：音频 Range、下载扩展名、封面缩略图。

### 真实冒烟（手动、控制费用）

| 项目 | 请求 | 通过标准 |
|---|---|---|
| Kling | 文生视频，5s，720P | 提交成功、轮询完成、本地可播放 |
| Kling | 首尾帧，各 1 张图 | media 位置正确、落盘 |
| Suno | 灵感模式一首 | 返回 2 首、封面与音频都能播放 |
| Suno | 自定义歌词 + 纯音乐 | 参数被上游接受 |

真实 Key、真实响应不写入仓库；诊断里只留脱敏后的样本。

---

## 8. 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 中转站实际端点/字段与 new-api 文档不一致 | Kling/Suno 提交失败 | 阶段 3/6 开始前各做一次最小真实请求；所有新厂商先支持高级 JSON 逃生口 |
| Key 分组不同 | 渠道测试通过但生成 401 | 预设里使用独立 env；联调确认 `TIANTOKEN_*` 实际可用组 |
| Suno 一次返回两首，费用翻倍 | 用户意外消费 | 默认每次确认；确认卡写明「一次 2 首」；会话额度照常计数 |
| 音频/封面 URL 过期 | 历史打不开 | 成功后立即下载；不依赖远端 URL |
| Kling 图片内联超 1–2MB | 网关 502 / fetch failed | 复用 1280 JPEG 压缩 + 1.4M 字符预算 |
| 重构引入回归 | 现有图片/视频功能坏 | 每阶段测试门禁；重构与功能分开 PR；阶段 2 先迁移再扩展 |
| `agent.ts` 拆分冲突 | 合并困难 | 阶段 7 单独 PR，纯搬移；不与功能混提 |
| 表结构改动 | 老数据风险 | 本轮优先不改表；封面复用 `thumb_path`，时长复用 `duration` |

回滚策略：

- 新渠道以「新增适配器 + 预设」方式接入，不改老渠道默认值；出问题可停用渠道。
- 阶段 2 的异步描述保留旧函数名作为薄包装，便于快速切回。
- 阶段 1 的 `isImageAdapter` 先保留兼容导出，稳定后再删。

---

## 9. 完成标准（DoD）

1. `npx tsc --noEmit` 0 错误；`npm test` 全部通过。
2. 全仓库只有一个异步轮询实现、一个 `channelKindOf/taskKindOf`、一份端点默认值。
3. Kling 与 Suno 都能完成：提交 → 轮询 → 全部产物落盘 → 历史可看/可播/可下载/可删除。
4. 对话里音乐生成必须经过确认；不能与图片批量并行。
5. 重启后未完成的异步任务能继续轮询。
6. 没有「只保存第一个产物」的代码路径。
7. `agent.ts` < 900 行；新增模块职责单一；`AgentService` 仍是唯一对外门面。
8. 文档里能按 `PROVIDER_GUIDE.md` 在一天内新增一个同构异步渠道。

---

## 10. 待拍板

1. **Kling 范围**：三个模型都上，还是先上 `kling-3.0`？4K 是否本轮开放？
2. **音乐确认**：默认「每次都问」还是「自动续跑时才问」？建议每次问。
3. **音乐工作台**：确认独立入口，不并入生视频。
4. **新厂商参数**：是否接受 `providerOptions` 作为新字段入口（推荐），还是继续平铺可选字段？
5. **前端拆分时机**：阶段 9 放在 Suno 之后（推荐，先交付功能），还是在阶段 6 之前先拆 `ChatView`？
6. **是否顺带抽象 Vidu**：本轮只设计 spec 不实现，还是把 Vidu 也一起接？

---

## 11. 建议 PR 顺序

| PR | 内容 | 是否可单独合并 |
|---|---|---|
| PR1 | 阶段 1：品类统一 + 测试 | 是 |
| PR2 | 阶段 2：异步描述 + 迁移现有视频 | 是 |
| PR3 | 阶段 3：Kling 适配器 + 预设 + 能力 | 是（发布检查点 A） |
| PR4 | 阶段 4：任务 UI 去重 | 是 |
| PR5 | 阶段 5：多产物 + 音频落盘 | 是 |
| PR6 | 阶段 6：Suno 适配器 + 工作台 | 是（发布检查点 B） |
| PR7 | 阶段 7：`agent.ts` 拆分（纯搬移） | 是 |
| PR8 | 阶段 8：`generate_music` + 确认 + 结果卡 | 是（发布检查点 C） |
| PR9 | 阶段 9：`ChatView` / `App` 拆分 | 是 |
| PR10 | 阶段 10：文档 + 发版 | 是（发布检查点 D） |

每个 PR 的提交说明固定写清：

- 改了什么行为 / 没改什么行为
- 跑了哪些测试
- 真实冒烟用了哪条请求
- 回滚方式
