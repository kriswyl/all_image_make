# 无限画布（独立自由画布 + 浮动 Agent）开发文档

- 状态：设计稿 v2，开发前评审
- 日期：2026-10-26
- 范围：独立无限画布工作区、自由节点画布、配置节点生成、浮动 Agent
- 关联：`AGENT_PLAN.md`、`EXPANSION_PLAN.md`、`DEVELOPMENT_HANDOFF.md`

---

## 0. v2 变更摘要

v1 的设计是「无限画布挂在会话下」。v2 按新思路改成**独立工作区**：

| 项 | v1 | v2 |
|---|---|---|
| 归属 | 每个会话一块无限画布 | 无限画布是独立项目，不跟会话走 |
| 入口 | 会话头部「无限画布」按钮 | 左上角 logo 切换 + 侧栏显式入口 |
| 布局 | 会话内全屏面板 | 全屏画布 + 可拖动 / 缩放的浮动 Agent |
| Agent 线程 | 复用当前会话 | 每个无限画布一条独立的 `kind='board'` 线程 |
| 素材 | 按会话派生 | 按无限画布归属 |
| 会话 | 无限画布依附会话 | 无限画布和会话完全解耦 |

**保留不变的决策**：JSON 文档、配置节点上游聚合、节点引用素材但不拥有素材、快照式撤销重做、三个 `board_*` 工具。

---

## 1. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 画布归属 | **独立无限画布工作区**，不跟会话走 |
| 2 | 数据模型 | 每个无限画布一份 JSON 文档；节点和连线都在文档里 |
| 3 | 生成模型 | 上游文本 / 图片汇总到「配置节点」 |
| 4 | 素材所有权 | 节点只引用 `assetId`；删节点不删素材；删素材时节点标缺失 |
| 5 | 撤销重做 | 整份快照 + 防抖保存 + 最多 50 步，服务端存储 |
| 6 | Agent | 独立线程 + 三个工具：读、批量写、生成 |
| 7 | 入口 | logo 点击切换工作区 + 侧栏可见入口，不能只藏在 logo 里 |

---

## 2. 目标与非目标

### 2.1 目标

1. 提供独立于对话的「无限画布」工作区：全屏画布、自由排布、自由连线。
2. 画布是主角，Agent 是**可移动、可缩放、可收起**的辅助面板。
3. 每个无限画布有自己的 Agent 线程、素材库、撤销历史和生成任务。
4. 用户在无限画布里完成「写提示词 → 接参考图 → 生成 → 继续改」的连续创作。
5. Agent 能读写无限画布，但只做用户明确要求的事。
6. 不破坏现有对话创作、分镜画布、参考图组和生成工作台。

### 2.2 非目标（本期不做）

- 3D 导演台、全景图、工作流市场、模板市场。
- 跨会话 / 跨无限画布共享素材（P2 再做桥接）。
- 文本生成模式、音频节点（先留字段，不实现）。
- 节点分组折叠、复制粘贴、导入导出（P3/P4）。
- 把分镜画布迁移成无限画布；两套继续并存。
- 用原生 function calling 替换现有 JSON 工具协议。

---

## 3. 术语与命名

| 产品名 | 含义 | 代码前缀 | 位置 |
|---|---|---|---|
| **参考图组** | 对话里最多 8 张的有序参考图，原「画布」 | `canvas`（不改） | `conversations.canvas_asset_ids` |
| **分镜画布** | 分镜表投影出来的镜头图 | `storyboard` | `StoryboardCanvas.tsx` |
| **无限画布** | 独立的自由节点画布 | `board` | 新增 |

- 新功能统一叫「无限画布」，代码前缀 `board`。
- 不叫「工作台」：生图 / 视频 / 音乐 / 语音工作台已经占用这个词。
- 不叫「画布」：会和老参考图组、分镜画布混淆。
- 对话里的旧「画布」UI 文案逐步改成「参考图组」，内部字段和 `set_canvas` 工具名保持兼容。
- 无限画布的 Agent 提示词里**不出现**参考图组和分镜，避免上下文串味。

---

## 4. 工作区形态与入口

### 4.1 两个工作区

```text
对话创作（现有）  ←→  无限画布（新）
```

- 左上角 logo 点击：在「对话创作」和「无限画布」之间切换。
- logo 旁边保留一个小的下拉箭头：打开现有菜单（设置 / 打开素材目录 / 版本）。
- 侧栏保留一个显式的「无限画布」入口，不能只靠 logo 发现。
- 进入无限画布时默认打开最近编辑的一块板；没有就自动建一块「未命名无限画布」。
- 无限画布和对话完全解耦：删对话不影响无限画布，删无限画布也不影响对话。

### 4.2 无限画布布局

```text
┌──────────────────────────────────────────────────────────────────┐
│ [logo] 无限画布 · 未命名        [撤销][重做] [适应][缩放]   [关闭] │
├──────────┬───────────────────────────────────────────────────────┤
│ 返回对话 │                                                       │
│          │      ┌────────┐      ┌────────┐      ┌──────────┐    │
│ 无限画布 1 │      │ 文本   │─────▶│ 配置   │─────▶│ 图片结果 │    │
│ 无限画布 2 │      └────────┘      └────────┘      └──────────┘    │
│ + 新建   │                           ▲                          │
│          │                      ┌────┴────┐                     │
│          │                      │ 参考图  │                     │
│          │                      └─────────┘                     │
│          │                                    ┌───────────────┐ │
│          │                                    │ Agent 浮窗    │ │
│          │                                    │ 对话 / 工具卡 │ │
│          │                                    └───────────────┘ │
└──────────┴───────────────────────────────────────────────────────┘
```

- 左侧是无限画布列表（P0 只有一块，P1 支持多块）。
- 画布全屏，不被侧栏和 Agent 固定挤占。
- Agent 浮窗默认右下角，可拖动、缩放、收起成气泡。
- 顶栏只放画布操作，不放对话相关的按钮。

### 4.3 浮动 Agent

- 默认尺寸约 380 × 560，右下角留 24px。
- 顶部拖动条移动；右下角或四边可缩放；最小化成气泡。
- 位置、尺寸、收起状态按无限画布保存（`localStorage` 或 `boards.ui_state_json`）。
- 浮窗内的滚轮、指针、输入不会触发画布平移 / 缩放。
- 窗口变窄时自动变成底部抽屉，不遮挡画布中心。
- 浮窗打开时显示该无限画布自己的 Agent 线程；关闭不中断后台任务，重新打开继续显示。
- 收起时如果有新消息或等待确认，气泡显示未读角标。

### 4.4 无限画布列表

- P0：单块默认无限画布，先验证画布和 Agent 手感。
- P1：侧栏支持新建、重命名、删除、切换；每块板有自己的线程、素材、历史和视口。
- 列表项显示：标题、节点数、最近更新时间。
- 删除无限画布前确认；素材不随板删除（见第 9 节）。

---

## 5. 数据模型

### 5.1 SQLite 表

#### `boards`

```sql
CREATE TABLE IF NOT EXISTS boards (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  doc_json              TEXT NOT NULL,
  viewport_json         TEXT NOT NULL DEFAULT '',
  selection_json        TEXT NOT NULL DEFAULT '[]',
  ui_state_json         TEXT NOT NULL DEFAULT '',
  version               INTEGER NOT NULL DEFAULT 1,
  thread_conversation_id TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_updated_idx ON boards(updated_at DESC);
```

- 一个无限画布一行。
- `doc_json` 只存节点和连线。
- `viewport_json` / `selection_json` / `ui_state_json` 单独存，不产生历史版本。
- `thread_conversation_id` 指向该板的 Agent 线程。

#### `board_history`

```sql
CREATE TABLE IF NOT EXISTS board_history (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  doc_json   TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_history_board_idx
  ON board_history(board_id, version DESC);
```

- 每个版本一份快照，最多 50 份，超出删最旧。
- `reason`：`manual`、`agent: 新增 2 个节点`、`generate: n4`。
- 撤销 / 重做移动当前版本指针，不删除未来快照；下一次新编辑时删除未来快照。

#### `board_assets`

```sql
CREATE TABLE IF NOT EXISTS board_assets (
  board_id  TEXT NOT NULL,
  asset_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  PRIMARY KEY (board_id, node_id)
);
CREATE INDEX IF NOT EXISTS board_assets_asset_idx
  ON board_assets(board_id, asset_id);
```

- 派生索引：每次保存文档时按节点里的 `assetId` 重建。
- 用途：无限画布素材库、删除素材时快速定位引用节点。

#### `board_tasks`

```sql
CREATE TABLE IF NOT EXISTS board_tasks (
  task_id        TEXT PRIMARY KEY,
  board_id       TEXT NOT NULL,
  config_node_id TEXT NOT NULL,
  result_node_id TEXT NOT NULL,
  kind           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_tasks_board_idx
  ON board_tasks(board_id, created_at DESC);
```

- 任务完成事件按 `task_id` 找到无限画布和结果节点。
- 应用重启后任务恢复轮询时也靠这张表回写。

#### `conversations` 扩展

```sql
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE conversations ADD COLUMN board_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_board_thread_idx
  ON conversations(board_id) WHERE kind = 'board' AND board_id IS NOT NULL;
```

- `kind = 'chat' | 'board'`；现有会话默认 `chat`。
- 无限画布的 Agent 线程就是一条 `kind='board'` 的会话，复用 `messages` 表。
- 所有「会话列表 / 最近对话 / 搜索」查询必须加 `kind = 'chat'`，否则无限画布线程会混进对话侧栏。
- 现有 `canvas_asset_ids`、`storyboard_*` 字段对 board 线程不使用。

### 5.2 文档 JSON

```ts
type BoardDoc = {
  version: 1;
  nextRef: number;          // 节点短引用计数器，从 1 开始
  nodes: BoardNode[];
  edges: BoardEdge[];
};

type BoardBase = {
  id: string;               // "b_" + uuid
  ref: string;              // "n1"、"n2"；稳定，不随排序变化
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type TextNode = BoardBase & {
  type: "text";
  text: string;
  fontSize?: number;
};

type ImageNode = BoardBase & {
  type: "image";
  assetId: string | null;
  source: "upload" | "generated" | "library";
  status: "empty" | "loading" | "succeeded" | "failed" | "cancelled";
  taskId?: string | null;
  prompt?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  error?: string;
};

type VideoNode = BoardBase & {
  type: "video";
  assetId: string | null;
  source: "upload" | "generated";
  status: "empty" | "loading" | "succeeded" | "failed" | "cancelled";
  taskId?: string | null;
  prompt?: string;
  duration?: number;
  error?: string;
};

type ConfigNode = BoardBase & {
  type: "config";
  mode: "image" | "video";  // P0 只实现 image，video 在 P3
  prompt: string;
  useUpstreamText: boolean;
  model?: string;
  channelId?: string;
  size?: string;
  quality?: string;
  count: number;            // 1..8
  durationSeconds?: number; // video
  resolution?: string;      // video
  audio?: boolean;          // video
  status: "idle" | "loading" | "succeeded" | "failed" | "cancelled";
  lastTaskId?: string | null;
  error?: string;
};

type BoardNode = TextNode | ImageNode | VideoNode | ConfigNode;

type BoardEdge = {
  id: string;
  source: string;
  target: string;
  kind: "input" | "result";
  role?: "text" | "reference" | "first-frame" | "last-frame";
};
```

### 5.3 连线语义

- `input`：从 `text` / `image` / `video` 指向 `config`。
- `result`：从 `config` 指向 `image` / `video`。
- 同一对节点之间同类型只允许一条边。
- `input` 边必须是有向无环图：
  - 配置节点不能连到配置节点（P0）；
  - 任何会形成环的输入边拒绝。
- 删除节点自动删除相连的边；结果节点保留，素材保留。
- `result` 边只用于展示和追溯，不参与下一次输入聚合。

### 5.4 配置节点输入聚合

**只取直接上游（一跳）**，不做递归。

文本输入：

1. 所有指向配置节点、`kind="input"`、来源为 `text` 的节点；
2. 按 `y` 升序、`y` 相同按 `x` 升序；
3. 去空；内容完全一致的文本去重；
4. 拼接：`[配置节点自己的 prompt, ...上游文本].filter(Boolean).join("\n\n")`；
5. 超过 20000 字符拒绝生成，提示用户删减，不静默截断。

图片输入：

1. 所有指向配置节点、`kind="input"`、来源为 `image` 且 `assetId` 非空的节点；
2. 按 `y` 升序、`y` 相同按 `x` 升序；
3. 最多 `MAX_REFERENCE_IMAGES`（当前 8）张；超出显示「已忽略 N 张」；
4. P0 图片模式：全部作为参考图；
5. P3 视频模式：按 `role` 分配首帧 / 尾帧 / 参考图；缺必需输入时禁用生成。

配置节点显示输入摘要：

```text
上游：3 段文本 · 2 张参考图
提示词：雨夜巷口，霓虹灯反射在积水里……（共 186 字）
```

### 5.5 限制

| 项 | 上限 | 处理 |
|---|---|---|
| 节点数 / 板 | 200 | 拒绝保存 |
| 连线数 / 板 | 400 | 拒绝保存 |
| 文档 JSON | 2 MB | 拒绝保存 |
| 单个文本节点 | 20000 字符 | 拒绝 |
| 标题 | 80 字符 | 截断 |
| 配置节点 count | 1–8 | 校验 |
| 参考图 | 8 张 | 忽略超出并提示 |
| Agent ops / 批 | 20 条 | 拒绝，让模型分两批 |
| 历史快照 | 50 份 | 删最旧 |

---

## 6. 服务端 API

无限画布相关接口独立于会话，前缀 `/api/boards`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/boards` | 无限画布列表（P1） |
| `POST` | `/api/boards` | 新建无限画布 + Agent 线程 |
| `GET` | `/api/boards/:id` | 读取文档、视口、选中、版本、线程 id |
| `PUT` | `/api/boards/:id` | 保存整份文档 |
| `PUT` | `/api/boards/:id/selection` | 保存选中节点（不进历史、不升版本） |
| `PUT` | `/api/boards/:id/ui-state` | 保存浮窗位置 / 尺寸 / 收起状态 |
| `POST` | `/api/boards/:id/undo` | 撤销 |
| `POST` | `/api/boards/:id/redo` | 重做 |
| `POST` | `/api/boards/:id/assets` | 上传素材到无限画布（不写消息） |
| `POST` | `/api/boards/:id/generate` | 在配置节点上生成 |
| `DELETE` | `/api/boards/:id` | 删除无限画布（含线程、历史、映射；素材保留） |

Agent 对话继续复用现有会话接口，线程 id 从 `GET /api/boards/:id` 的 `threadId` 取得：

- `GET /api/conversations/:threadId/messages`
- `POST /api/conversations/:threadId/messages`
- `POST /api/conversations/:threadId/confirm`
- `GET /api/conversations/:threadId/events`（SSE）

### 6.1 读取

```http
GET /api/boards/:id
```

```json
{
  "id": "b_xxx",
  "title": "未命名无限画布",
  "doc": { "version": 1, "nextRef": 5, "nodes": [], "edges": [] },
  "viewport": { "x": 0, "y": 0, "scale": 1 },
  "selection": ["n3"],
  "version": 7,
  "canUndo": true,
  "canRedo": false,
  "threadId": "c_xxx"
}
```

### 6.2 保存

```http
PUT /api/boards/:id
```

```json
{
  "doc": { "...": "..." },
  "viewport": { "x": 0, "y": 0, "scale": 1 },
  "baseVersion": 7,
  "reason": "manual"
}
```

- `baseVersion` 必须等于当前版本，否则返回 `409 BOARD_VERSION_CONFLICT` 和当前文档。
- 内容没变直接返回，不写历史。
- 同一事务内：
  1. zod 校验；
  2. 检查限制、边合法性、环；
  3. 校验素材属于当前无限画布；
  4. 当前版本写入 `board_history`；
  5. 写入新文档，`version + 1`；
  6. 重建 `board_assets`；
  7. 删除版本号大于当前版本的未来快照；
  8. 清理超过 50 条的最旧历史。

### 6.3 撤销 / 重做

- 找到当前版本之前最近的快照，设为当前文档。
- 不删除未来快照，可以重做。
- 新保存删除未来快照。
- 返回完整响应（同 GET）。

### 6.4 上传素材

```http
POST /api/boards/:id/assets
Content-Type: multipart/form-data
file=<图片或视频>
```

- 复用现有 MIME / 大小 / 落盘 / sha256 校验。
- 创建 `origin = 'upload'` 的任务和素材，**不写聊天消息**。
- 写入 `board_assets`；返回 `{ asset }`。
- 客户端把素材插入文档，创建图片节点。

### 6.5 生成

```http
POST /api/boards/:id/generate
{ "nodeId": "b_xxx", "overrides": { "count": 1 } }
```

- 读取文档，找到配置节点，按 5.4 聚合输入。
- 复用现有 `TaskRunner.create()` 和渠道适配器。
- 提交前创建结果节点占位：
  - `x = config.x + config.width + 120`，`y = config.y`；
  - 区域被占用时向下顺延；
  - `count > 1` 时纵向排列，间距 24px。
- 写入 `board_tasks`；保存文档（一个历史版本）。
- 返回 `{ task, resultNodeIds, doc, version }`。
- 失败标记结果节点和配置节点 `failed`；取消沿用现有取消接口。

### 6.6 任务完成回写

`TaskRunner.onTaskEvent` 终态时：

1. 按 `task_id` 查 `board_tasks`；
2. 打开无限画布，更新结果节点 `assetId` / `status` / `duration`；
3. 更新配置节点 `status` / `lastTaskId`；
4. 保存文档（reason `generate:result`）；
5. 广播 `board` 事件到线程 SSE；
6. 清理映射行。

进程内完成和重启后恢复轮询都走同一函数。

### 6.7 SSE 事件

在线程 SSE 上扩展：

```ts
| { type: "board"; boardId: string; version: number; reason: string }
| { type: "board-task"; boardId: string; nodeId: string; status: string; taskId: string }
```

- 无限画布面板订阅线程 SSE；收到 `board` 事件后重新拉取文档。
- 收到 `board-task` 先本地更新节点状态。
- Agent 在后台改板时，浮窗和画布同步。

### 6.8 删除

- `DELETE /api/boards/:id`：
  - 删除 `boards`、`board_history`、`board_assets`、`board_tasks`；
  - 删除 `kind='board'` 的线程和消息；
  - 素材保留（不删文件、不删 `assets` / `tasks`）。
- 删除对话不影响无限画布。
- 删除无限画布不影响对话。

---

## 7. 生成流程

### 7.1 图片生成（P1）

1. 用户点配置节点「生成」。
2. 客户端调用 `POST /api/boards/:id/generate`。
3. 服务端：
   - 校验输入；
   - 解析模型 / 渠道（复用 `resolveAlias`、默认模型、渠道能力）；
   - 组装 `GenerationInput`：prompt、参考图、count、尺寸、质量；
   - `TaskRunner.create()`；
   - 创建结果节点占位；
   - 写文档和历史；
   - 返回。
4. 客户端显示生成中骨架。
5. 任务完成后 6.6 回写。
6. 结果节点可预览、下载、存素材、继续作为别的配置节点输入。

### 7.2 再次生成

- 默认新建结果节点，不覆盖旧结果。
- 配置节点保留 `lastTaskId`，供「重试上一次」。
- P3 增加「覆盖上一次结果」开关；旧产物仍留在素材库。

### 7.3 count > 1

- 创建 N 个结果节点，纵向排列，全部从配置节点拉 `result` 边。
- 每个结果节点独立状态；部分失败只标失败的那几个。
- P3 再考虑折叠成图片组节点。

### 7.4 视频（P3）

- 配置节点 `mode = "video"`，上游图片按 `role` 指定首帧 / 尾帧 / 参考图。
- 复用 `supportedVideoModes` 和现有视频请求构造。
- 视频异步；完成后回写。
- 缺少必需输入时禁用生成，不悄悄退回别的模式。

### 7.5 失败与重试

- 失败信息写在配置节点和结果节点上。
- 重试复用 `/api/generations/:id/retry`；P1 先写回同一个结果节点。
- 取消后节点保留，状态 `cancelled`，可重新生成。

### 7.6 重启恢复

- 打开无限画布时扫描 `status` 为 `loading` / `queued` 且带 `taskId` 的节点；
- 逐个 `GET /api/generations/:id`；
- 已完成更新，失败标失败，任务不存在标 `cancelled`；
- 服务端回写是主路径，客户端对账是兜底。

---

## 8. 前端实现

### 8.1 文件

新增：

```text
src/shared/board.ts                  // 文档、节点、边、zod schema、限制
src/server/board.ts                  // 读取 / 保存 / 撤销 / 生成 / 任务回写
src/server/board-tools.ts            // Agent 三个工具
src/client/board/BoardWorkspace.tsx  // 工作区 shell、侧栏、顶栏
src/client/board/BoardCanvas.tsx     // 画布视口、节点、连线、框选、小地图
src/client/board/BoardNodeView.tsx   // 四类节点渲染
src/client/board/BoardInspector.tsx  // 右侧检查器
src/client/board/BoardAgentPanel.tsx // 浮动 Agent
src/client/board/useBoard.ts         // 文档状态、防抖保存、撤销重做、任务对账
src/client/board/board.css           // 无限画布样式
tests/board-*.test.ts
```

改动：

- `src/client/App.tsx`：`View` 增加 `"board"`；logo 点击切换工作区；侧栏入口。
- `src/client/app-shared.ts`：`View` 类型。
- `src/client/ChatView.tsx`：不受影响；只是不再承载无限画布。
- `src/client/api.ts`：board API。
- `src/server/app.ts`：`/api/boards` 路由。
- `src/server/db.ts`：建表、`conversations.kind` 迁移、查询过滤、素材聚合、删除清理。
- `src/shared/agent-types.ts`：三个工具名、board SSE 事件。
- `src/server/agent-tools.ts`：schema + execute + switch。
- `src/server/agent-prompt.ts`：无限画布专用提示词分支。
- `src/server/agent-context.ts`：无限画布摘要。
- `src/server/agent-confirm.ts`：破坏性操作确认。
- `src/server/agent.ts`：按线程类型注入上下文、确认分支。

### 8.2 工作区切换

- `App.tsx` 的 `view` 增加 `"board"`。
- logo 点击：
  - 当前不是 board → 切到 board，打开最近的板；
  - 当前是 board → 切回 chat。
- logo 旁边的下拉箭头保留现有菜单（设置 / 打开素材目录 / 版本）。
- 侧栏增加「无限画布」入口；board 模式下侧栏切换为无限画布列表。
- board 模式隐藏对话相关的顶栏按钮（分镜 / 素材 / 看图改 / 模型），避免上下文混乱。
- 「返回对话」回到上次的会话。

### 8.3 状态与保存

- `useBoard(boardId)` 持有 `doc`、`version`、`canUndo`、`canRedo`、`viewport`、`selection`。
- 所有修改走 `applyLocal(mutator, reason)`：
  - 修改本地文档并立即更新 UI；
  - 400ms 防抖 `PUT`；
  - 拖动节点只在 `pointerup` 保存一次；
  - 结构操作（新增 / 删除 / 连线）立即保存；
  - 文本输入防抖 400ms。
- 保存冲突（409）：重新拉取文档，提示「无限画布已在别处更新」，不自动重放本地改动。
- 关闭面板 / 窗口失焦 / `visibilitychange` 时 flush。
- 撤销 / 重做由服务端完成，客户端只替换文档。

### 8.4 画布交互

P0 必须有：

- 平移：空格 + 拖动，或中键拖动；空白左键拖动是框选。
- 缩放：滚轮以指针为中心，范围 0.1–2.4。
- 选择：点击、`Shift/Ctrl/Cmd` 追加、框选、`Ctrl/Cmd + A`、`Esc`。
- 节点拖动、四角缩放；多选一起移动。
- 连线：右侧端口拖到配置节点左侧端口。
- 删除：`Delete/Backspace`；有生成结果的节点删除前确认。
- 撤销 / 重做：`Ctrl/Cmd + Z`、`Ctrl/Cmd + Shift + Z`、`Ctrl/Cmd + Y`。
- 适应窗口、100%、小地图开关。

P2 / P3：

- 双击空白快速添加节点。
- 拖入图片文件创建图片节点。
- 粘贴剪贴板图片。
- 复制 / 粘贴节点。
- 自动布局。
- 右键菜单。

### 8.5 节点交互

**文本节点**

- 双击进入 textarea；`Esc` 或失焦结束。
- 标题双击重命名。
- 空文本显示「双击编辑文字」。

**图片节点**

- 空节点：上传、从无限画布素材库选择、拖入。
- 有图：双击看大图；悬停下载、替换、存素材、删除。
- 生成结果：显示状态、来源配置节点、重试 / 取消。
- 素材缺失：显示占位，不崩溃。

**配置节点**

- 显示模式、上游摘要、模型、尺寸、张数。
- 自带 prompt 文本框。
- 「生成」/「停止」。
- 上游超限显示黄色提示。
- 结果状态和错误摘要。

**视频节点（P3）**

- 原生播放器，双击放大，下载，重试。
- 生成中显示进度（如渠道提供）。

### 8.6 浮动 Agent 面板

- 复用现有消息渲染：`MessageBubble`、`ToolCard`、`ConfirmCard`、状态徽标。
- 新写一个轻量 `BoardAgentComposer`：文本输入、模型选择、发送 / 停止；P2 再支持附图。
- 面板通过 `threadId` 订阅现有 SSE；消息、确认、工具卡、任务进度都走原链路。
- 拖动 / 缩放用 pointer events；`stopPropagation` 防止画布同步平移。
- 位置和尺寸按无限画布保存；窗口 resize 时 clamp 到可视区域。
- 最小化成气泡；有新消息或待确认时显示角标。
- 小窗口变成底部抽屉，默认高度 45vh。

### 8.7 性能

- 节点组件 `memo`；拖动只更新当前节点 transform。
- 连线层用单个 `<svg>`。
- 200 节点内可拖动；超过 150 节点关闭阴影 / 模糊。
- 图片走缩略图 URL；文档只存 `assetId`。
- Agent 浮窗的流式消息不触发画布重渲染。

### 8.8 样式

- 跟随现有深浅主题和 Codex 黑白灰风格。
- 使用现有 CSS 变量，不硬编码颜色。
- 无限画布样式独立 `board.css`。

---

## 9. 素材所有权与清理

### 9.1 规则

- 节点只存 `assetId`，不存 URL / base64 / 缩略图。
- 删除节点不删除素材。
- 删除素材时：
  - 引用它的图片 / 视频节点置为「素材已删除」：`assetId = null`，`status = "empty"`；
  - 删除 `board_assets` 对应行；
  - 节点和位置保留。
- 素材按无限画布归属：
  - 上传：`origin='upload'` 的静默任务/素材，写入 `board_assets`；
  - 生成：正常任务，`board_tasks` 映射，保存文档时重建 `board_assets`。
- 无限画布素材库只显示当前板的素材；跨板复用 P2 再做。
- 删除无限画布不删除素材文件；素材留在磁盘和历史里，后续由「清理无引用素材」处理。

### 9.2 清理路径

- 新增 `listBoardAssets(boardId)`。
- 新增 `deleteBoardAsset(boardId, assetId)` 或在现有素材删除流程中检查 `board_assets`。
- 删除无限画布：删表、删线程、删映射；不删 `assets` / `tasks` 文件。
- 生成历史里的任务删除：如果无限画布仍引用该素材，保留文件；否则按现有规则处理。
- 对话素材清理逻辑不受影响。

### 9.3 上传

- 不写聊天消息，不占对话轮次。
- 复用现有图片校验、大小限制、缩略图、sha256。
- 视频上传 P3 再开。

---

## 10. Agent 方案

### 10.1 线程模型

- 每个无限画布一条 `kind='board'` 的 conversation。
- 复用：`messages`、SSE、`brain`、`callBrainWithRecovery`、`agent-plan`、`agent-confirm`、`agent-batch`、`agent-task-events`。
- 不加载：参考图组、分镜表、脚本文档、歌曲列表。
- 系统提示词使用无限画布专用版本；只讲节点、连线、配置节点和生成。
- 现有对话 Agent 不受影响。

### 10.2 工具集

只加三个：

| 工具 | 花钱 | 作用 |
|---|---|---|
| `board_read` | 否 | 读取无限画布摘要或指定节点 |
| `board_apply` | 否 | 一次原子执行多条节点 / 连线操作 |
| `board_generate` | 是 | 在配置节点上触发生成 |

- 只在 `kind='board'` 线程可用；对话线程不加载这三个 schema。
- 命名用 `board_*`，避免和 `set_canvas` 混淆。

### 10.3 `board_read`

```json
{"tool":"board_read","args":{"scope":"selection","depth":1,"limit":60}}
```

- `scope`: `selection` | `viewport` | `all`
- `depth`: `0` 只读选中；`1` 附带一跳上下游；默认 1
- `nodeRefs`: 可选，指定节点
- `limit`: 1–60
- 返回紧凑文本：

```text
无限画布：12 个节点，8 条连线；视口 6 个节点；当前选中 n3、n4
- n1 文本 · 雨夜巷口，霓虹灯…
- n2 图片 · 已生成 · 1024×1024
- n3 配置 · 生图 · 上游 1 段文本 / 1 张图 · 已生成
- n4 图片 · 已生成 · 来自 n3
连线：
- n1 -> n3（文本）
- n2 -> n3（参考图）
- n3 -> n4（结果）
```

- 默认只给提示词前 80 字；需要全文用 `nodeRefs`。
- 不写历史、不升版本。

### 10.4 `board_apply`

```json
{"tool":"board_apply","args":{"ops":[
  {"op":"add_node","tempId":"a","type":"text","x":320,"y":180,"title":"提示词","text":"雨夜巷口，霓虹灯反射在积水里"},
  {"op":"add_node","tempId":"b","type":"config","x":640,"y":180,"mode":"image","count":1},
  {"op":"connect","from":"a","to":"b","kind":"input","role":"text"}
]}}
```

支持的 op：

| op | 字段 | 说明 |
|---|---|---|
| `add_node` | `tempId, type, x, y, title?, text?, assetRef?, config?` | `tempId` 只在本批有效 |
| `update_node` | `nodeRef, patch` | 白名单字段 |
| `connect` | `from, to, kind, role?` | `from/to` 可以是 `nX` 或本批 `tempId` |
| `disconnect` | `from, to, kind?` | 删除匹配边 |
| `move_node` | `nodeRef, x, y` | 单个移动 |
| `delete_node` | `nodeRef` | 连带删边，不删素材 |

规则：

- 一次最多 20 条；超过拒绝，让模型分两批。
- 在文档副本上顺序执行；任意一条失败整批回滚。
- 成功后保存一次，写入一个历史版本，reason `agent: <摘要>`。
- 返回真实 ID / ref 映射；`summary` 必须包含新建 ref：

```text
成功：新增 n7（文本，tempId=a）、n8（配置，tempId=b）；连线 a->b；共 3 条 op。
```

**字段白名单**

- `text`：`title`、`text`、`fontSize`
- `image`：`title`、`assetRef`（P2 换图）
- `config`：`title`、`prompt`、`mode`、`model`、`channelId`、`size`、`quality`、`count`、`durationSeconds`、`resolution`、`audio`、`useUpstreamText`
- 位置 / 尺寸：`x`、`y`、`width`、`height`
- 不允许模型改 `id`、`ref`、`status`、`taskId`、`assetId`。

### 10.5 `board_generate`

```json
{"tool":"board_generate","args":{"nodeRef":"n8","overrides":{"count":1}}}
```

- 只能指向 `config` 节点。
- 内部调用和手动生成同一条服务端函数。
- 返回：

```text
已提交：n8 生成 2 张，结果节点 n9、n10；taskId=xxx。
```

- 视频异步：本轮结束，等任务完成事件续跑。
- 花钱确认：图片默认不确认；视频 / 音乐按现有策略；会话任务超额确认；`board_generate` 不放进 `calls` 批量。

### 10.6 上下文注入

每轮系统提示词加入无限画布摘要，不塞全量节点：

```text
## 无限画布（自由画布）
- 共 12 个节点，8 条连线；当前选中 n3（配置·生图）、n4（图片·已生成）
- 选中节点及一跳上下游：
  - n1 文本：雨夜巷口，霓虹灯反射在积水里……
  - n2 图片：已生成 1024×1024
  - n3 配置：生图，上游 1 段文本 / 1 张图，已生成
  - n4 图片：来自 n3，已生成
- 视口内还有：n5 文本、n6 图片
- 未在上下文里的节点：n7–n12；需要细节时调用 board_read。
```

- 选中状态由 `PUT /api/boards/:id/selection` 保存，服务端读取。
- 视口来自 `viewport_json`，用于挑可见节点。
- 超过 60 个节点只列选中 + 上下游 + 视口，其余按需读。
- 不出现参考图组、分镜、脚本文档。

### 10.7 提示词规则

1. 你是无限画布助手，只处理无限画布；不要提参考图组和分镜。
2. 操作前不确定节点就 `board_read`；不要猜 `nX`。
3. 修改用 `board_apply`，一次把相关操作写齐；不要拆成多轮。
4. 不要擅自整理布局、删除节点、批量生成。
5. 删除、清空、覆盖有内容节点前必须确认。
6. `board_generate` 只在用户明确要生成时调用；不要把「加一个配置节点」自动变成「生成」。
7. 结果节点是产物，不要拿它当输入再连回配置节点。

### 10.8 确认策略

- `board_apply`：
  - 增 / 改 / 连线 / 移动：自动执行，工具卡显示摘要。
  - 删除节点、清空、覆盖已有结果：弹确认卡。
  - 确认卡显示：删除几个节点、其中几个有生成结果、素材不会删除。
- `board_generate`：走现有生成确认。
- `ConfirmPreview.reason = "board_destructive"`，字段：
  - `boardDeleteNodes`
  - `boardDeleteWithAssets`
  - `boardOverwriteNodes`
  - `boardSummary`

### 10.9 撤销与工具结果

- `board_apply` 和 `board_generate` 各写一个历史版本。
- Agent 和手动修改共用同一套撤销；一次 Ctrl+Z 撤掉整批 Agent 操作。
- 成功 `summary` 必须包含新建 / 修改节点的 ref。
- 失败 `summary` 包含失败 op 序号和原因。
- zod 校验失败回灌一次，让模型重试；不整轮失败。
- 部分失败整批回滚，不执行任何一条。

### 10.10 Agent 评测用例

1. 「把这段文案做成一张图」→ 文本 + 配置 + 连线 + 生成。
2. 「在这张图旁边加一个改图节点」→ 配置 + 连图片 + prompt。
3. 「把这两个节点连起来」→ connect。
4. 「删掉右边那个空节点」→ delete（无结果，不确认）。
5. 「删掉这张生成图」→ delete（有素材，确认）。
6. 「把三个节点排成一行」→ 三条 move。
7. 「用这张图当参考，生成四张不同风格」→ count=4 + 生成。
8. 「现在选中了什么」→ board_read。
9. 「把画板整理一下」→ 明确拒绝或先问。
10. 「把这张图设为对话参考图」→ 不在无限画布线程里做；提示回对话。

---

## 11. 与现有模块的关系

| 模块 | 关系 |
|---|---|
| 对话创作 | 独立工作区；共享 Agent 引擎，但线程、上下文、工具不同 |
| 分镜画布 | 完全独立；P2 可加「发送到无限画布」 |
| 参考图组 | 完全独立；P2 可加「设为参考图组」 |
| 生图 / 视频工作台 | 复用渠道、模型、尺寸、任务、素材 |
| 生成历史 | 无限画布任务照常进历史；来源标 `board` |
| 素材库 | 无限画布有自己的素材视图；上传/生成都进当前板 |
| 撤销重做 | 仅无限画布；对话和分镜不接入 |

### 11.1 跨模式桥（P2）

- 分镜产物 / 素材库图 → 发送到无限画布（创建图片节点，不自动连线）。
- 无限画布图片 → 设为参考图组（1–8 张）。
- 无限画布图片 → 发送到当前对话（作为附件或消息图片）。
- 桥接只走显式按钮，不做自动上下文共享。

---

## 12. 里程碑

### P0：工作区与画布底座（6–8 个开发日）

- `boards` / `board_history` / `board_assets` / `board_tasks` 建表。
- `conversations.kind` / `board_id` 迁移；所有会话列表查询加 `kind='chat'`。
- `GET/PUT/undo/redo/selection/ui-state` API。
- 工作区切换、logo 点击、侧栏入口、无限画布列表占位。
- 全屏画布、平移缩放、框选、节点拖动、连线、删除。
- 文本 / 图片 / 配置节点渲染。
- 防抖保存、版本冲突、撤销重做。
- 上传、素材索引、删除清理。
- 验收：能建节点、连线、保存、重开恢复、撤销重做；对话侧栏不出现无限画布线程。

### P1：图片生成（4–6 个开发日）

- 配置节点输入聚合、提示词拼接、参考图上限。
- `POST /api/boards/:id/generate`、结果节点、任务回写、失败 / 取消 / 重试。
- 客户端任务对账、重启恢复。
- 验收：文本 + 参考图 → 配置节点 → 生成 → 结果节点；重启后状态正确。

### P2：浮动 Agent（8–12 个开发日）

- `BoardAgentPanel`：拖动、缩放、收起、记位置。
- 无限画布线程：创建、消息、SSE、确认卡、停止。
- 三个工具：`board_read` / `board_apply` / `board_generate`。
- 上下文摘要、选中 / 视口注入。
- 原子 ops、临时 ID、结果回灌、确认卡。
- 提示词规则、10 条评测用例。
- 验收：自然语言建节点、连线、生成、删除；破坏性操作确认；一次撤销撤整批。

### P3：多板、视频与打磨（5–7 个开发日）

- 无限画布列表、新建 / 重命名 / 删除 / 切换。
- 配置节点视频模式、首帧 / 尾帧 / 参考图。
- 小地图、快捷键、右键菜单、复制粘贴、自动布局。
- 跨模式桥：分镜 → 无限画布、无限画布 → 参考图组。
- 验收：多板切换互不串数据；视频生成可用。

### P4：可选

- 节点分组折叠、图片组节点。
- 文本生成模式、音频节点。
- 跨板素材复用、导入导出。
- 模板 / 协作 / 云同步（暂不做）。

---

## 13. 测试计划

### 13.1 单元测试

- 文档 schema：合法 / 非法节点、重复 ID、重复 ref、超限。
- 输入聚合：文本排序、空文本、超长、图片上限、缺图。
- 连线：环检测、重复边、跨类型非法边、删除节点级联删边。
- 历史：50 步上限、撤销后新编辑删除未来、版本冲突。
- 素材：保存重建索引、删除素材清引用、跨板素材拒绝。
- Agent ops：临时 ID 映射、原子回滚、字段白名单、破坏性确认判定。

### 13.2 接口测试

- `GET/PUT` 无限画布；冲突 409。
- `undo/redo` 往返；`selection` / `ui-state` 不升版本。
- 上传素材不写消息、进当前板素材库。
- 生成：配置节点解析、任务创建、结果节点、完成回写、失败 / 取消。
- 删除无限画布级联；素材保留。
- 任务重启恢复：模拟重启后继续轮询并回写。
- **线程隔离**：对话列表 / 搜索 / 最近会话不出现 `kind='board'`；无限画布线程不出现在对话侧栏。

### 13.3 前端测试

- `useBoard` 防抖保存、冲突重载、卸载 flush。
- 拖动不逐帧保存、`pointerup` 保存一次。
- 任务对账：loading → succeeded / failed / cancelled。
- 浮动 Agent 拖动 / 缩放 / 收起的位置持久化。
- 200 节点渲染和拖动性能手测。

### 13.4 Agent 测试

- 三个工具只在 board 线程加载。
- schema 校验。
- 10 条评测用例。
- 工具结果包含新建 ref。
- 破坏性操作确认卡字段。
- 对话线程不出现 board 工具；board 线程不出现参考图组 / 分镜上下文。

---

## 14. 风险与未决问题

### 14.1 风险

1. **复用 conversations 的 `kind` 会碰很多查询**：会话列表、搜索、最近、自动标题、未读、任务计数都要加过滤。开发前先全局搜索 `listConversations` 一类入口，列清单。
2. **两套 Agent 提示词分叉**：共用 schema / 执行器，但系统提示词分支。用评测用例防止对话工具和无限画布工具串味。
3. **素材清理**：无限画布、对话、分镜三处引用素材；删除逻辑容易漏。所有清理集中到统一的素材引用检查。
4. **浮动面板事件**：拖动 / 滚轮 / 输入可能穿透到画布；必须 `stopPropagation` 并做手测。
5. **入口可发现性**：logo 点击 + 侧栏入口都要有；不要只做 logo。
6. **JSON 截断**：一次 ops 太多会被 `max_tokens` 截断；限制 20 条，服务端校验失败整批拒绝。
7. **文档体积**：200 节点 + 长提示词可能到 2 MB；限制单节点文本，素材只存 ID。
8. **删除无限画布后的孤儿素材**：本期保留文件，后续做「清理无引用素材」。

### 14.2 未决问题

- P0 单板、P1 多板，是否接受？（当前方案：接受）
- 无限画布素材是否要跨板复用？（当前：P2）
- 浮动 Agent 默认展开还是收起？（当前：首次展开，之后记住状态）
- 对话里的「画布」文案是否在本次一起改成「参考图组」？（当前：无限画布发布时一起改）
- 无限画布是否需要在侧栏显示生成/历史/模型设置等全局入口？（当前：隐藏，通过「返回对话」使用）

---

## 15. 验收标准

P0 + P1 + P2 完成时，以下全部通过才算“无限画布可用”：

1. logo 点击和侧栏入口都能进入无限画布；能返回对话。
2. 每个无限画布有自己的节点、连线、视口、素材、撤销历史和 Agent 线程。
3. 能新建文本、图片、配置节点，能拖动、缩放、连线、删除。
4. 文本 + 图片接到配置节点，点生成能出图，结果成为新节点。
5. 生成中刷新 / 重启，状态和结果能恢复。
6. 撤销 / 重做覆盖手动和 Agent 修改，最多 50 步。
7. 删除节点不删素材；删除素材后节点显示缺失，不崩溃。
8. 无限画布素材只出现在当前板素材库；上传不写聊天消息。
9. 浮动 Agent 可拖动、缩放、收起；位置按板记住；不干扰画布操作。
10. Agent 能读无限画布、批量建节点 / 连线、在配置节点上生成；破坏性操作有确认；一次撤销撤整批。
11. 对话侧栏、搜索、最近会话不出现无限画布线程；对话 Agent 不加载 board 工具。
12. 200 节点以内拖动和缩放可用，不出现明显卡顿。

---

## 16. 开发顺序建议

1. 先写 `src/shared/board.ts`（类型 + schema + 限制），它是前端、服务端和 Agent 的共同契约。
2. 再写 `src/server/board.ts`（保存 / 历史 / 素材索引），先不接生成。
3. 加 `conversations.kind` 迁移，全局审计会话查询，先把线程隔离跑通。
4. 客户端先做工作区 shell + 只读渲染 + 拖动 + 保存，验证文档模型。
5. 接配置节点图片生成和任务回写。
6. 做浮动 Agent 面板 + 线程复用 + 三个工具。
7. 最后做多板、视频、跨模式桥和打磨。

---

## 18. P0 实施记录（2026-10-26）

### 18.1 已完成

**共享契约**

- `src/shared/board.ts`：节点 / 连线 / 文档 zod schema、限制、`nX` 短引用分配、直接上游排序、配置节点提示词拼接、环检测、素材 id 提取。
- `tests/board-doc.test.ts`：13 条单元测试，覆盖默认值、重复引用、非法连线、环、文本超长、排序、提示词拼接、素材去重。

**服务端**

- `src/server/db.ts`：
  - 新增 `boards`、`board_history`、`board_assets`、`board_tasks`；
  - `conversations` 新增 `kind` / `board_id` 迁移和唯一索引；
  - `listConversations()` / `emptyConversationIds()` 只查 `kind='chat'`，无限画布线程不会被对话侧栏或空壳清理误伤；
  - 无限画布读取 / 保存 / 历史 / 撤销 / 重做 / 素材索引 / 级联删除。
- `src/server/board.ts`：
  - 建板 + 板线程、读写、重命名、删除；
  - 版本冲突 409、快照历史、选中 / 视口 / 浮窗状态；
  - 上传图片到无限画布（不写聊天消息）；
  - 从无限画布移除素材、清理节点引用。
- `src/server/app.ts`：
  - `/api/boards` 全组路由；
  - 对话专属子路由（分镜 / 文档 / 上传 / 参考图组素材）拒绝 board 线程；
  - 对话 PATCH / DELETE 拒绝 board 线程。
- `src/server/agent-settings.ts`：把 `readAgentDefaults` / `pickBrainChannel` 从 `app.ts` 抽出，供无限画布建线程复用，避免循环依赖。
- `tests/board-api.test.ts`：8 条接口测试，覆盖线程隔离、保存 / 冲突、撤销重做、上传 / 移除素材、跨板引用、删除隔离。

**客户端**

- `src/client/board/`：
  - `BoardWorkspace`：独立工作区、侧栏无限画布列表（新建 / 切换）、顶栏、文件选择、灯箱；
  - `BoardCanvas`：平移 / 缩放 / 框选 / 多选 / 拖动 / 节点缩放 / 连线 / 删除 / 快捷键 / 适应窗口；
  - `BoardNodeView`：文本、图片、视频、配置节点；文本双击编辑；图片上传 / 预览 / 移除；配置节点上游摘要；
  - `BoardInspector`：名称、文本、提示词、模式、张数、上游引用、删除；
  - `useBoard`：乐观更新、400ms 防抖、版本冲突重载、撤销重做、视口 / 选中持久化、任务对账预留；
  - `board.css`：浅色 / 深色主题、节点、连线、检查器、控件。
- `App.tsx`：logo 点击切换「对话 / 无限画布」；侧栏新增「无限画布」；board 模式下侧栏改为无限画布列表；`View` 增加 `board`。
- `api.ts`：`ApiError.details`、board API 全组方法。

**开发脚本**

- `scripts/dev.mjs`：固定 Web 开发 API 端口为 17891。预览面板会往子进程注入 `PORT`，不固定的话 API 会去抢 Vite 的 5173，Vite 代理 17891 时变成 ECONNREFUSED。

**验证结果**

- `npx tsc --noEmit`：通过。
- `npm test`：32 个测试文件、351 条用例全部通过。
- `npm run build`：通过。
- 手测：进入无限画布、新建文本 / 配置节点、双击编辑文本、从文本端口拖到配置节点、拖动节点、撤销 / 重做、拖入图片上传、深色主题、侧栏多板切换、StrictMode 下只自动建一块板、删除无限画布后不残留线程。

### 18.2 与计划的偏差

- 侧栏无限画布列表、新建 / 切换 / 标题重命名已经提前做了；但**删除无限画布**目前只有接口，没有 UI 入口（P1 补）。
- 无限画布素材没有独立抽屉；P0 用文件选择 / 拖入上传，节点上可以移除引用。素材库 UI 放 P1。
- 小地图、复制粘贴、自动布局按计划留给 P3。
- 配置节点「生成」按钮已显示但禁用，图片生成在 P1。
- Agent 三个工具、浮动面板、确认卡在 P2。
- 没有改 `CHANGELOG.md` / `README.md`：工作区里已有未提交的用户改动，不在这次开发里混入。

### 18.3 P1 起点

1. 配置节点图片生成：聚合上游文本 / 图片，复用 `TaskRunner`，结果节点落在配置节点右侧。
2. `board_tasks` 完成回写 + 重启对账 + 失败 / 取消 / 重试。
3. 生成结果节点状态和素材库刷新。
4. 无限画布素材抽屉 + 删除无限画布 UI。
5. 之后再接 P2 的浮动 Agent 和 `board_read` / `board_apply` / `board_generate`。

---

## 19. P1 实施记录（2026-10-26）

### 19.1 已完成

**服务端**

- `POST /api/boards/:id/generate`：
  - 校验配置节点、图片模式、提示词、节点数上限；
  - 用 `composeConfigPrompt` 拼「自己的 prompt + 直接上游文本」；
  - 上游图片按位置排序，`prepareImageBytes` 转成 `ReferenceImageUpload`；
  - 用 `buildCapabilityAliases` / `resolveAlias` 解析图片模型，缺渠道时明确 400；
  - 复用 `TaskRunner.create()` 提交任务；
  - 在配置节点右侧创建 `count` 个结果占位节点，写 `result` 连线；
  - 文档保存一个历史版本，返回值包含 `board`、`task`、`resultNodeIds`。
- `board_tasks` 主键改成 `(task_id, result_node_id)`，装得下 count > 1；旧 P0 表在无数据时自动重建。
- 文档保存时允许「刚生成、还没进 `board_assets`」的素材：只要 `board_tasks` 能证明它属于这块板，就放行。
- 删除生成历史 / 上传任务时，先 `detachAssetFromBoards()` 摘掉无限画布节点引用，再删任务和文件；`deleteTask()` 同步清理 `board_tasks`。

**客户端**

- 配置节点「生成」按钮启用：节点内和检查器都能点；生成中显示「生成中」并禁用。
- `useBoard.generate()`：先 flush 未保存编辑，再提交；成功后用服务端返回的 BoardView 替换文档，保留本地视口和选中。
- `useBoard.reconcileTasks()`：每 1.5s 轮询 loading 节点对应的任务；完成后只合并 `status / assetId / error`，不碰位置、文本和 prompt。
- 打开无限画布时如果还有 loading 节点，会自动对账；应用重启后同样适用。
- 任务结果素材通过 `board_tasks` 校验写回文档，保存后 `board_assets` 重建，素材抽屉刷新。
- 服务端临时 500 / 网络错误不再 reload 冲掉本地改动，保留 pending 并在 2 秒后重试；只有 400 / 404 才重新拉文档。
- 结果节点失败时显示失败原因摘要。

**测试**

- `tests/board-generate.test.ts`：3 条用例，覆盖聚合提示词、提交任务、占位节点、生成素材写回、空提示词拒绝、跨板 / 不存在素材拒绝。
- 全量：33 个测试文件、354 条用例通过；`npm run build` 通过。
- 手测：用本地 mock 图片服务验证「文本 → 配置 → 生成 → 结果节点」，count=2 时上游只返回 1 张会正确标部分失败；count=1 时成功出图并写回素材。

### 19.2 与计划的偏差

- **任务完成回写改由客户端轮询，而不是服务端在任务回调里改文档**。原因：服务端改文档会和用户正在编辑的文档抢版本；客户端只合并状态字段，冲突面小，重启后也能对账。服务端仍保留 `board_tasks` 映射，P2 的 Agent 可以直接复用。
- 结果节点只在提交时创建；没有实现「停止生成」按钮和「重试失败结果」按钮，留到 P1 收尾 / P2。
- 配置节点还没有模型 / 尺寸选择器；P1 先用默认生图模型，alias 可以后续从检查器补。
- count > 1 时，上游返回完全相同的图片会被 TaskRunner 按 sha256 去重，可能出现「只返回 1/2 张」的部分失败；这是现有素材去重行为，不是无限画布特判。
- 没有实现服务端 SSE；客户端用轮询。

### 19.3 下一步

1. 生成结果节点的「停止 / 重试」按钮。
2. 检查器补模型、尺寸、质量选择。
3. 无限画布素材抽屉 + 删除无限画布 UI。
4. P2：浮动 Agent、`board_read` / `board_apply` / `board_generate`、确认卡。

---

## 17. P0 文件改动清单

这一节只列 P0（工作区 + 画布底座 + 单块板）的改动，不包含图片生成和 Agent。

### 17.1 先做只读审计

动手前先把下面这些点确认一遍，避免 `kind='board'` 的线程混进对话：

| 位置 | 现状 | P0 要做什么 |
|---|---|---|
| `src/server/db.ts:1000` `listConversations()` | `SELECT * FROM conversations ORDER BY updated_at DESC` | 加 `WHERE kind = 'chat'` |
| `src/server/db.ts:1024` `emptyConversationIds()` | 查所有没有消息的会话 | **必须**加 `kind = 'chat'`；否则新建无限画布线程后，下一次新建对话会把它当空壳删掉 |
| `src/server/db.ts:1013` `resetConversationsStuckInRunning()` | 重置所有 `running` | 保留，无限画布线程也要能收回 `idle` |
| `src/server/db.ts:2002` `conversationFromRow()` | 映射 Conversation | 补 `kind`、`boardId` |
| `src/server/db.ts:980` `createConversation()` | 插入固定字段 | 增加 `kind`、`board_id`，默认 `chat` / `NULL` |
| `src/server/db.ts:1844` `findConversationByTask()` | 按 `messages.task_id` 找回会话 | P0 不改；P2 要区分 board 线程，避免走对话自动续跑 |
| `src/server/db.ts:1700` `deleteConversation()` | 删消息、分镜、文档、会话 | 只允许 chat 线程；无限画布删除走 `deleteBoard()` |
| `src/server/app.ts:678` `GET /api/conversations` | 调 `listConversations()` | 依赖上面的过滤，无需重复写 WHERE |
| `src/server/app.ts:698` 新建对话前清空壳 | 调 `emptyConversationIds()` | 依赖上面的过滤；这是最容易误删无限画布线程的一步 |
| `src/server/app.ts` 对话专属路由 | storyboard / documents / uploads / canvas assets | 增加 `requireChatConversation()` 守卫，拒绝 board 线程 |
| `src/client/ChatView.tsx:251` | `api.conversations()` | 服务端过滤后无需改；侧栏不会再出现无限画布线程 |
| `tests/*conversation*` | 现有空会话测试 | 补一条「board 线程不算空会话、不会被清理」 |

### 17.2 新增文件

```text
src/shared/board.ts
src/server/board.ts
src/client/board/BoardWorkspace.tsx
src/client/board/BoardCanvas.tsx
src/client/board/BoardNodeView.tsx
src/client/board/BoardInspector.tsx
src/client/board/useBoard.ts
src/client/board/board.css
tests/board-doc.test.ts
tests/board-api.test.ts
```

可选拆分：

```text
src/client/board/BoardMinimap.tsx   // P0 可以先不做，P3 再补
src/server/uploads.ts               // 如果 board 上传逻辑和现有三处重复太多，再抽
```

### 17.3 修改文件

| 文件 | 改动 |
|---|---|
| `src/shared/agent-types.ts` | `Conversation` 增加 `kind: "chat" \| "board"`、`boardId: string \| null`；`ConversationInput` 增加可选的 `kind` / `boardId`（只给内部建线程用） |
| `src/server/db.ts` | 四张新表 + 迁移；conversation 映射；列表过滤；board CRUD / 历史 / 素材索引 / 线程创建 / 级联删除 |
| `src/server/app.ts` | `/api/boards` 路由；上传；错误码；`requireChatConversation()` 守卫 |
| `src/client/app-shared.ts` | `View` 增加 `"board"` |
| `src/client/App.tsx` | 侧栏「无限画布」入口；logo 点击切换；渲染 `BoardWorkspace`；board 模式侧栏 / 顶栏 |
| `src/client/main.tsx` | `import "./board/board.css"` |
| `src/client/api.ts` | board 类型和请求方法 |

### 17.4 每个文件的具体职责

**`src/shared/board.ts`**

- `BOARD_LIMITS`：节点 200、连线 400、文档 2MB、文本 20000、标题 80、历史 50。
- `boardNodeSchema` / `boardEdgeSchema` / `boardDocSchema`（zod，discriminated union）。
- `createEmptyBoardDoc()`。
- `validateBoardDoc(doc)`：限制、重复 id / ref、边合法性、环检测。
- `assignNodeRef(doc)`：创建节点时分配 `nX`。
- `sortUpstreamText/Images(nodes, edges, configId)`：纯函数，P1 生成时复用，P0 可以先只写类型和 schema。
- 不 import 服务端模块。

**`src/server/board.ts`**

- `createBoard(db, { title? })`：建板 + 建 `kind='board'` 线程；线程的大脑模型复用 `pickBrainChannel` 的默认选择。
- `getBoard(db, id)` / `listBoards(db)`。
- `saveBoard(db, id, { doc, viewport, baseVersion, reason })`：校验、历史、版本、素材索引重建。
- `undoBoard(db, id, baseVersion)` / `redoBoard(db, id, baseVersion)`。
- `saveBoardSelection(db, id, nodeIds)` / `saveBoardUiState(db, id, state)`。
- `storeBoardUpload(db, boardId, file)`：图片落盘、建 upload 任务/素材、写 `board_assets`。
- `deleteBoard(db, id)`：删板、历史、素材索引、任务映射、board 线程和消息；素材文件保留。
- `rebuildBoardAssets(db, boardId, doc)`：按节点 `assetId` 重建派生索引。
- `assertAssetsBelongToBoard(db, boardId, doc)`：只允许当前板素材。
- P0 不实现 `generate` / `applyTaskResult`，留到 P1。

**`src/server/db.ts`**

- 建表：`boards`、`board_history`、`board_assets`、`board_tasks`。
- 迁移：`conversations.kind`、`conversations.board_id`、唯一索引。
- 新方法：
  - `createBoard` / `getBoardRow` / `listBoardRows` / `updateBoardDoc` / `updateBoardViewport` / `updateBoardSelection` / `updateBoardUiState`
  - `insertBoardHistory` / `listBoardHistory` / `deleteFutureBoardHistory` / `trimBoardHistory`
  - `replaceBoardAssets` / `listBoardAssets` / `findBoardsByAsset`
  - `createBoardThread` / `getBoardByThread` / `deleteBoardCascade`
- 修改：
  - `conversationFromRow` 补 `kind` / `boardId`
  - `createConversation` 写 `kind` / `board_id`
  - `listConversations`、`emptyConversationIds` 过滤 `kind='chat'`
  - `deleteConversation` 不处理 board 线程；board 删除走 `deleteBoardCascade`

**`src/server/app.ts`**

- 新增路由：
  - `GET /api/boards`
  - `POST /api/boards`
  - `GET /api/boards/:id`
  - `PUT /api/boards/:id`
  - `PUT /api/boards/:id/selection`
  - `PUT /api/boards/:id/ui-state`
  - `POST /api/boards/:id/undo`
  - `POST /api/boards/:id/redo`
  - `POST /api/boards/:id/assets`（multipart）
  - `DELETE /api/boards/:id`
- 新增 `requireChatConversation(id)`：只允许 `kind='chat'` 的线程访问分镜、文档、上传、参考图组等对话专属路由。
- 新增 `requireBoard(id)`。
- 错误码：`BOARD_NOT_FOUND`、`BOARD_VERSION_CONFLICT`、`BOARD_DOC_INVALID`、`BOARD_ASSET_INVALID`。

**`src/client/board/useBoard.ts`**

- 拉取 / 保存 / 撤销 / 重做。
- `applyLocal(mutator, reason)`：本地更新 + 400ms 防抖 + 保存。
- 拖动只在 `pointerup` 保存；文本输入防抖。
- 409 冲突：重拉 + toast，不重放本地改动。
- 卸载 / `visibilitychange` flush。
- 选中节点、视口、浮窗 ui-state 的保存（P0 先存选中和视口）。

**`src/client/board/BoardWorkspace.tsx`**

- 工作区 shell：顶栏、侧栏、画布、检查器。
- 顶栏：标题、撤销重做、缩放、适应窗口、关闭 / 返回对话。
- 侧栏：P0 只显示「返回对话」+ 当前无限画布；P1 再接列表。
- 不挂 Agent 浮窗（P2）。

**`src/client/board/BoardCanvas.tsx`**

- 平移 / 缩放 / 框选 / 多选 / 拖动 / 节点缩放 / 连线 / 删除 / 快捷键。
- 与分镜画布独立，先复制小的几何函数（`clampScale`、`toWorld`、`edgePath`），P3 再抽公共 helper。
- 不渲染分镜语义，只认文档里的节点和边。

**`src/client/board/BoardNodeView.tsx`**

- `text` / `image` / `config` 三种节点渲染。
- 文本双击编辑；图片上传/预览/替换；配置节点显示上游摘要和占位生成按钮（P0 按钮禁用或提示「下一阶段」）。
- 空状态、失败状态、素材缺失状态。

**`src/client/board/BoardInspector.tsx`**

- 选中节点的位置、尺寸、类型、素材信息。
- P0 不放生成参数；P1 再接模型 / 尺寸 / 张数。
- 提供删除、置顶 / 置底（可选）。

**`src/client/App.tsx`**

- `View` 增加 `"board"`。
- 侧栏 NavButton「无限画布」；点击进入最近的板或新建默认板。
- logo 点击切换「对话 / 无限画布」；`brand-chevron` 改为单独的菜单按钮，保留设置 / 素材目录 / 版本。
- board 模式下侧栏显示无限画布入口和「返回对话」，不显示对话专属顶栏。
- 渲染 `<BoardWorkspace />`。
- 切回对话时恢复上次会话；不改动 ChatView 内部状态。

**`src/client/api.ts`**

- 类型：`BoardSummary`、`BoardResponse`、`BoardSaveInput`。
- 方法：`boards`、`board`、`createBoard`、`saveBoard`、`undoBoard`、`redoBoard`、`updateBoardSelection`、`updateBoardUiState`、`uploadBoardAsset`、`deleteBoard`。

### 17.5 实施顺序

1. 先跑 17.1 的只读审计，把受 `kind` 影响的查询和测试列全。
2. 写 `src/shared/board.ts` + `tests/board-doc.test.ts`。
3. 改 `src/server/db.ts`：建表、迁移、`kind` / `boardId`、列表过滤。
4. 写 `src/server/board.ts` + `/api/boards` 路由 + `tests/board-api.test.ts`。
5. 改 `src/client/api.ts`。
6. 改 `App.tsx` / `app-shared.ts` / `main.tsx`：工作区切换和空壳。
7. 写 `BoardWorkspace` + `BoardCanvas`：只读渲染、拖动、保存。
8. 写 `BoardNodeView` / `BoardInspector`：文本、图片、配置节点。
9. 接上传、素材索引、删除清理。
10. 跑全量测试 + 手测清单。

### 17.6 P0 验收 / 手测

自动：

```bash
npm test
npm run build
```

手测：

1. logo 点击能在对话和无限画布之间切换；侧栏入口也能进。
2. 没有无限画布时自动建一块「未命名无限画布」；重开还在。
3. 新建文本 / 图片 / 配置节点，拖动、缩放、连线、删除。
4. 关闭再打开，节点、连线、视口、选中状态恢复。
5. 撤销 / 重做最多 50 步；拖动保存后撤销能回到拖动前。
6. 上传图片到无限画布，素材出现在当前板；删除节点不删素材。
7. 从素材删除图片，画板节点显示「素材已删除」，不崩溃。
8. 对话侧栏、搜索、最近会话不出现无限画布线程。
9. 新建对话触发的空壳清理**不会**删掉无限画布线程（关键回归）。
10. 删除对话不影响无限画布；删除无限画布不影响对话和素材文件。
11. 两个浏览器窗口同时改同一块板，后保存的一方收到版本冲突并重载。

### 17.7 P0 明确不做

- 配置节点生成、结果节点、任务回写（P1）。
- 浮动 Agent、board 工具、确认卡（P2）。
- 多无限画布列表、重命名、删除 UI（P1/P3）。
- 视频节点、视频生成（P3）。
- 小地图、复制粘贴、自动布局（P3）。
- 分镜 / 参考图组 / 素材库的跨模式桥（P3）。

---

## 20. P1 收尾 + P2 实施记录（2026-10-26）

### 20.1 P1 收尾

- **停止 / 重试**：
  - `POST /api/boards/:id/tasks/:taskId/cancel` 校验任务属于当前板后调用 `TaskRunner.cancel()`；
  - `POST /api/boards/:id/tasks/:taskId/retry` 调用 `TaskRunner.retry()`，把新 taskId 映射到同一组结果节点；
  - 节点内和检查器都有「停止 / 重试」按钮；
  - `TaskRunner.run()` 在同步请求返回后检查 `cancelled`，防止用户点停止后结果又把它改回 succeeded。
- **模型 / 尺寸**：
  - 配置节点新增 `imageSize`（1K / 2K / 4K）；
  - 检查器从 `/api/agent/capabilities` 拉启用的生图 alias，显示模型选择；
  - 按所选渠道适配器切换尺寸选项：gemini 用 `imageSize`，OpenAI / generic 用 `size`，Midjourney 提示由画幅决定；OpenAI 系另有质量选项；
  - `POST /api/boards/:id/generate` 和 `board_generate` 都接受 `imageSize` override。
- **测试**：`board-generate.test.ts` 扩到 5 条（重试、停止）。

### 20.2 P2：浮动 Agent

**线程与上下文**

- 复用 `kind='board'` 的 conversation 线程；`AgentService` / SSE / 消息表 / 确认闸门全部复用。
- `agent-brain.assemble()` 对 board 线程走独立分支：
  - system prompt 用 `buildBoardSystemPrompt()`；
  - 上下文只用 `describeBoard()`：选中节点 + 一跳上下游 + 视口近似 + 坐标 + 上游数量；
  - 不加载参考图组、分镜、脚本文档、歌曲，也不附视觉缩略图。
- `describeBoard()` 同时服务系统提示词和 `board_read`，避免「说的和读的不一样」。

**工具**

- `board_read`：scope selection / viewport / all、depth 0/1、nodeRefs、limit。
- `board_apply`：
  - 协议在 `src/shared/board-ops.ts`，最多 20 条 op；
  - 支持 add_node / update_node / connect / disconnect / move_node / delete_node；
  - 在文档副本上执行，任意一条失败整批回滚；
  - tempId 映射到真实 ref，结果 summary 回灌给大脑；
  - 保存一次历史版本，一次 Ctrl+Z 可撤销整批 Agent 操作。
- `board_generate`：解析配置节点，调用 `generateBoardConfig`，返回结果节点 ref + taskId。
- 对话线程不能调用 board_*；无限画布线程只能用 board_* / ask / reply。
- 删除有资产节点或一次删除 3 个以上节点时，`previewBoardOps()` 要求确认；确认卡使用 `reason="board_destructive"`。
- Agent 修改后通过 SSE `board` 事件通知浮窗，浮窗回调 `useBoard.reload()` 刷新画布。

**浮动面板**

- `BoardAgentPanel`：
  - 固定浮层，可拖动、缩放、收起成气泡；
  - 位置 / 尺寸存 `boards.ui_state_json`，按无限画布记住；
  - 复用 `UserBubble` / `AssistantBubble` / `SystemNote` / `StreamingBubble` / `ToolCard` / `ConfirmCard`；
  - 支持发送、停止、确认 / 拒绝、ask 选项、任务进度；
  - 发送前先 flush 未保存的画布改动，保证 Agent 读到的是最新文档；
  - 没有对话模型时显示警告并禁用输入。
- 顶栏新增「助手」开关；默认打开。

**测试**

- `tests/board-agent.test.ts`：7 条，覆盖原子建节点 / 连线、非法 op 回滚、读取、生成、对话线程拒绝、破坏性确认判定、提示词与 read 共用描述。
- `tests/board-agent-e2e.test.ts`：1 条，假大脑 → `board_apply` → 工具结果 → 收尾回答，画布真的多出节点和连线。
- 全量：35 个测试文件、364 条用例通过；`npm run build` 通过。

### 20.3 已知限制

- 无限画布 Agent 看不到图片内容，只能按节点 id / 状态 / 提示词摘要操作；看图工具留给后续。
- 浮窗的 brain 模型固定为创建无限画布时选中的对话渠道，面板里暂不能切换。
- Agent 修改后画布会整体 reload；如果用户在 Agent 运行期间还在画布上编辑，这次 reload 可能覆盖未保存的改动。发送前已经 flush，剩下的冲突窗口留给 P3 做增量事件。
- 手动生成的任务仍由客户端轮询回填；Agent 生成的任务同样由客户端回填，服务端不在任务回调里写文档。
- 无限画布列表的删除入口、视频配置节点、小地图、复制粘贴、自动布局仍未做。

### 20.4 下一步（P3）

1. 无限画布列表删除 / 重命名 UI、素材抽屉。
2. 配置节点视频模式与首帧 / 尾帧 / 参考图。
3. Agent 看图（选中图片节点时附缩略图）。
4. 画布增量 SSE（只推变化节点，不再整份 reload）。
5. 小地图、复制粘贴、自动布局、导入导出。

---

## 21. P3 实施记录（多板、视频与打磨）

### 21.1 已完成

**多板与素材**

- 侧栏每块无限画布都有删除入口；删除前确认，当前板被删后自动切到下一块，最后一块删掉时立刻建一块空的。
- 重命名仍走顶栏标题；切换无限画布会换用该板保存的浮窗位置 / 尺寸。
- 顶栏新增「素材」抽屉：只列当前文档引用到的图片 / 视频，支持预览、把图片插回画布、从板中移除（素材文件不删）。

**视频配置节点**

- 配置节点 `mode = "video"` 可选；检查器按渠道能力列出可用方式、时长、分辨率、音频。
- 输入连线新增 `role` 语义：不填 = 自动，`reference` = 参考图，`first-frame` = 首帧，`last-frame` = 尾帧。
- 自动判定：无图 = 文生视频；1 张 = 首帧；首帧 + 尾帧 = 首尾帧；多张 = 参考生视频。显式模式优先，模糊组合直接报错，不静默丢图。
- 复用现有万相 / Seedance / 可灵 / Grok 适配器与 `TaskRunner`；视频结果落成 `video` 节点，仍然只有一个占位结果（一次一个视频）。
- 客户端轮询同时覆盖图片和视频任务，按 `mimeType` 把视频写回视频节点；停止 / 重试 / 错误状态沿用原有链路。
- 视频生成参数也进了 `board_generate` 的 overrides，Agent 可以设置 `videoMode` / `durationSeconds` / `resolution` / `audio`。

**Agent 看图**

- 用户选中的图片节点会在每轮对话中作为缩略图附件发送给无限画布大脑（最多 8 张，受全局反代 / 模型能力限制）。
- 没选中的图片仍然只给 ref、标题和状态；系统提示词明确说明「看不到没选中的图片」。

**画布交互**

- 小地图（默认开，可关）：显示节点分布和当前视口，点击跳转。
- 复制 / 粘贴：`Ctrl/Cmd + C`、`V`；`Ctrl/Cmd + D` 原地复制。复制会重建节点 id / ref，保留节点内部连线，不复制任务 id 和生成状态。
- 自动排版：按依赖层级从左到右排列，配置节点在中间、结果在右侧。
- 右键菜单：加文本 / 配置节点、上传图片、复制 / 粘贴 / 原地复制、自动排版、适应窗口、删除选中。
- 双击空白处加文本节点；`Ctrl/Cmd + V` 在剪贴板里是图片时直接上传并落成节点。
- 画布底部提示同步更新；小地图、右键菜单和素材抽屉都有窄屏样式。

### 21.2 数据结构与接口变化

- `ConfigBoardNode.videoMode?: "text-to-video" | "first-frame" | "first-last-frame" | "reference"`；不填 = 自动。
- `directInputLinks(doc, configId)` 返回带 edge 的直接上游，供检查器和视频解析共用。
- `resolveBoardVideoSelection()` 是视频模式判定的唯一入口，导出给测试用。
- `board_generate` 和 `POST /api/boards/:id/generate` 的 overrides 增加视频字段。
- `VIDEO_DEFAULTS` 从 `agent-tools.ts` 移到 `shared/video-capabilities.ts`，无限画布、对话工具、分镜共用一份默认值。

### 21.3 测试与验证

- `tests/board-video.test.ts`：6 条，覆盖单图自动首帧、首尾帧、显式参考、文生视频带图报错、模型不支持模式，以及万相模拟服务的完整提交 → 轮询 → 视频落库 → 写回文档。
- `tests/board-agent-e2e.test.ts`：新增 1 条选中图片节点的视觉附件测试。
- 全量：36 个测试文件、371 条用例通过；`npm run build` 通过。
- 浏览器手测：素材抽屉、无限画布删除、视频检查器（Grok 只显示文生 / 参考两种方式）、右键菜单、复制粘贴、自动排版及撤销恢复。
- 未消耗真实视频 / 图片生成额度；视频与 Agent 视觉测试全部使用本地 mock 服务。

### 21.4 仍未做

- 跨模式桥（分镜 → 无限画布、无限画布 → 参考图组）没有接；需要先决定从哪个入口选目标会话 / 板。
- Agent 修改后仍是整份 reload，增量 SSE 留到后续；发送前 flush 仍在，冲突窗口比 P2 没有变大。
- 视频只支持生成，不支持上传视频节点；视频任务固定一次一个结果。
- 自动排版是按依赖层级的朴素布局，没有做节点宽度均衡 / 连线交叉最小化。
- 导入 / 导出、节点分组、模板、协作仍属于 P4。

---

## 22. P4 实施记录（分组、生文本、导入导出）

P4 原计划是可选阶段。这一轮先做了三项对日常创作收益最直接的功能；音频节点和模板 / 协作 / 云同步仍然保留为后续可选项。

### 22.1 节点分组与折叠

- `BoardDoc` 增加可选 `groups`：`{ id, title, nodeIds[], collapsed }`；旧文档没有这个字段时按空数组处理，不需要迁移数据库。
- 校验：分组 id 唯一、成员节点必须存在、同一个节点不能同时在两个分组里。
- 画布：
  - 选两个以上节点后右键「把选中节点编组」，或按 `Ctrl/Cmd + G`；
  - 展开状态显示虚线分组框，拖动分组标题栏整体移动成员节点；
  - 折叠后成员节点和连线一起隐藏，显示一个分组卡片；双击或点展开按钮恢复；
  - 分组边框上的按钮可以折叠 / 展开、解散分组；
  - 删除节点会自动从分组里移除；复制整组节点时会把分组关系一起复制。
- Agent 的 `board_read` 会看到分组名、成员 ref 和折叠状态；Agent 暂不能创建 / 解散分组（留给用户在画布上操作，避免多一层误操作）。
- 分组属于文档内容，参与撤销 / 重做，也随导出文件一起保存。

### 22.2 生文本模式

- 配置节点 `mode` 增加 `"text"`。
- 服务端用**无限画布助手自己的对话渠道和模型**生成文本，不额外要求用户再选一个模型。
- 只使用文本上游；如果连着图片 / 视频会明确返回 `BOARD_TEXT_IMAGE_UNSUPPORTED`，不静默丢图。
- 生成是同步的：结果直接写成配置节点右侧的新文本节点，`result` 连线指向文本节点，`task = null`；结果文本可以继续作为下游配置节点的输入。
- 检查器在生文本模式下隐藏模型 / 尺寸 / 张数，显示「跟随无限画布助手」；画布上的配置节点显示「生文本 / 1 段」。
- 空结果、超长结果、没有对话渠道 / 密钥都有单独的错误码。

### 22.3 导入 / 导出与跨板素材复用

- 导出格式 `chatcanvas-board`：`{ format, version: 1, title, exportedAt, doc }`，同时兼容直接导入一份裸 `BoardDoc`。
- 顶栏新增导入 / 导出按钮：
  - Tauri 下走系统保存对话框；
  - 浏览器下走 Blob 下载。
- 导入会新建一块无限画布（不覆盖现有板），并尝试复用当前安装里已有的素材：
  - 素材存在且类型匹配 → 建立 `board_assets` 链接，两块板共享同一张素材；
  - 素材不存在 / 类型不符 → 节点清空为「空素材」，返回缺失的节点 ref，并提示用户。
- 分组、连线、节点坐标随文档一起导入；视口和浮窗位置不导出，按新板默认值打开。导入本身是新建板 + 一次快照，不经过客户端冲突检查。

### 22.4 测试与验证

- 新增 `tests/board-text.test.ts`：2 条，覆盖同步生成文本 / 写入文本节点，以及图片上游被拒绝且不调用大脑。
- 新增 `tests/board-import.test.ts`：3 条，覆盖同机素材复用、分组 / 连线保留、缺失素材清空、非法文件 400。
- `tests/board-doc.test.ts` 增加 2 条分组校验和「结果边指向文本节点」。
- 全量：38 个测试文件、378 条用例通过；`npm run build` 通过。
- 浏览器手测：Ctrl+A / Ctrl+G 编组、拖动分组、折叠 / 展开、撤销恢复；切到生文本检查器确认模型提示与按钮；通过 UI 导入当前板并在导入后删除，原板配置未受影响。
- 生文本测试使用本地 mock 大脑，**没有消耗真实对话额度**；手测没有点任何真实生成按钮。

### 22.5 仍未做

- 音频节点 / 音频生成模式：后续已在第 24 节补上。
- Agent 主动编组 / 折叠、跨模式桥（分镜 ↔ 无限画布）、增量 SSE，仍是后续项。
- 模板、协作、云同步按原计划不做。

---

## 23. 桌面反馈修正（2026-10-26）

这一轮先处理「新建文本文档 (4).md」里的 5 条反馈，再继续 P4 剩余项。

### 23.1 默认平移与无限画布

- 空白处左键拖动现在默认就是平移，不再需要先按空格；空格 / 中键仍可平移。
- 框选改为 `Shift` / `Ctrl` / `Cmd` + 拖动空白；单击空白（没有拖动）会取消选中，但拖动平移不会。
- 画布不再用固定的 1600×1000 世界尺寸：画布层按内容和视口动态扩展，负坐标节点也能正常显示；平移不设上限。
- 缩放范围放宽到 5%–300%，`parseBoardViewport` 同步；小地图、适应窗口仍按真实内容计算。
- 画布底部提示同步改为「拖动空白平移 · Shift / Ctrl 拖动框选」。

### 23.2 「保存失败，正在重试…」排查

- 现象对应的是 `useBoard` 里服务端 5xx / 网络错误的兜底提示；改动本身留在内存中，没有丢。
- 主要触发场景是开发期 `tsx watch` 重启或 Vite 代理暂时连不上 API（`api.saveBoard` 收到 500），不是文档校验失败；400 / 409 会走各自的明确提示。
- 处理方式：
  - 第一次失败不再弹错误 Toast，只在顶栏显示「重试中」；
  - 指数退避（2s → 4s → … 最多 10s）继续重试，成功后自动恢复；
  - 连续失败两次以上才提示，20 秒内不重复刷屏；恢复时只在确实提示过的情况下说「连接已恢复」；
  - 服务端 5xx 现在会带 requestId 打印完整错误到终端，方便下次直接定位。
- 限制：如果 API 长时间不可用且用户直接关闭应用，内存里的未保存改动仍会丢；这是客户端兜底方案本身的边界，后续可以加本地草稿。

### 23.3 收起后的机器人气泡可拖动

- 气泡位置单独存进 `boards.ui_state_json`（`bubbleX` / `bubbleY`），不再只能跟着面板右上角。
- 气泡可拖动到窗口任意位置；点击（没有拖动时）展开面板，面板会出现在气泡附近。
- 拖动结束才写一次 UI 状态，不会拖动过程中刷保存。

### 23.4 进入无限画布默认收起侧栏 / 菜单 / 创作历史

- 从 logo 或侧栏进入无限画布时自动收起侧栏，把整页留给画布。
- 无限画布顶栏原来的「返回对话」改为「菜单」，点击展开侧栏，从侧栏选择对话或其他工作区。
- 顶栏新增「创作历史」抽屉：
  - 列出最近 50 个版本、保存原因和时间；
  - 当前版本标记为「当前」；
  - 可恢复到任意旧版本；恢复会把旧文档作为新版本保存，当前内容仍留在历史里，也能撤销；
  - 撤销后产生的「未来」重做快照不在历史里展示，避免和当前版本混淆。
- 服务端新增 `GET /api/boards/:id/history` 和 `POST /api/boards/:id/history/:version/restore`。

### 23.5 验证

- 新增 `tests/board-history.test.ts`：2 条，覆盖历史列表、恢复、冲突 409、缺失版本 404。
- 全量：39 个测试文件、380 条用例通过；`npm run build` 通过。
- 手测：
  - 进入无限画布后侧栏自动收起；「菜单」能重新展开侧栏；
  - 创作历史抽屉正常列出快照；
  - 拖动空白可平移；节点拖到负坐标后仍存在，撤销可恢复；
  - 机器人气泡拖动后位置改变，点击在附近展开面板。
- 没有点任何真实生成按钮；没有消耗生图 / 视频 / 对话额度。

---

## 24. 音频节点（P4 收尾）

### 24.1 节点与生成

- 新增 `audio` 节点：`assetId` / `source` / `status` / `taskId` / `prompt` / `duration`，和图片、视频节点一样只引用素材。
- 配置节点 `mode = "audio"`，分两种：
  - `audioKind = "speech"`：配音 / 朗读，走 Gemini TTS；`voice` 选音色，`ttsStyle` 写语气；一次 1 段。
  - `audioKind = "music"`：音乐，走 Suno 的「灵感描述」模式；`instrumental` 控制纯音乐；一次 2 首，生成两个音频节点。
- 提示词仍然来自「配置节点自己的 prompt + 直接文本上游」；音频模式不接受图片 / 视频上游，会明确报错。
- 音频任务沿用 `TaskRunner`：配置节点和音频结果节点显示 loading / 成功 / 失败 / 已取消；停止、重试、重启后的客户端对账都复用现有链路。
- 素材抽屉、检查器、灯箱都支持音频：可预览、下载、从板中移除；音频结果会写进 `board_assets`，导出 / 导入时按 `audio/` 类型校验。

### 24.2 Agent 与界面

- 检查器在音频模式下显示音频类型、模型、音色 / 语气或「纯音乐」开关；不再显示尺寸、张数。
- `board_read` 会显示音频配置节点的类型和上游；`board_generate` 支持 `audioKind` / `voice` / `ttsStyle` / `instrumental` overrides。
- 画布节点显示音频图标、文件名、时长和 MIME，点击打开灯箱播放。

### 24.3 测试与验证

- 新增 `tests/board-audio.test.ts`：2 条
  - Gemini TTS mock → 提交 → 音频落库 → 写回音频节点；
  - Suno 音乐模式创建两个音频占位节点。
- 全量：40 个测试文件、382 条用例通过；`npm run build` 通过。
- 手测：配置节点切「生音频」显示音色 / 语气；切「音乐」显示纯音乐开关；用导入的音频素材创建临时板确认音频节点和灯箱正常，测试板已删除。
- 音频 mock 服务本地运行，没有消耗真实 TTS / 音乐额度。

### 24.4 仍未做

- 音乐只接了「灵感描述」：自定义歌词、翻唱、混音、音效、歌单还没有搬进无限画布。
- 配音是单人单音色；双人对话、语言选择还没进节点；音频上传也还没开。
- 跨模式桥、增量 SSE、模板 / 协作 / 云同步仍未做。

---

## 25. 跨模式桥、增量 SSE 与改名（2026-10-26）

### 25.1 产品名

- 面向用户的名称从「创作板」改为「无限画布」：侧栏导航、列表、顶栏、助手、导出文件、错误提示、Agent 身份和提示词都已同步。
- 数据库启动时做一次幂等迁移：
  - 只有默认标题 `未命名创作板` 的板改成 `未命名无限画布`；
  - 只有 `kind='board'` 的 Agent 线程标题把前缀「创作板」换成「无限画布」；
  - 用户自己改过的板名不动。
- 内部代码继续使用 `board` / `BoardDoc` 命名，避免大范围无意义重命名。

### 25.2 跨模式桥

**分镜 → 无限画布**

- 分镜列表的每张已生成分镜图旁新增「无限画布」按钮；分镜画布多选后工具栏新增「发到无限画布」。
- 弹窗选择目标无限画布，也可以直接新建一块「分镜参考」。
- 服务端把已有素材复用成目标板的图片节点：保留标题（第 N 镜）和分镜提示词，建立 `board_assets` 链接；重复 / 非图片 / 超出节点上限的素材跳过。
- 目标板只追加节点，不覆盖已有布局。

**无限画布 → 参考图组**

- 选中一个或多个已绑定图片的节点后，顶栏「参考图组」可用。
- 弹窗选择普通对话；服务端把图片追加到该对话的 `canvasAssetIds`，去重并遵守 8 张上限。
- `listConversationAssets` 现在会把 `canvasAssetIds` 里不属于消息 / 分镜 / 设定的素材补成来源 `bridge`，因此对话素材库、参考图组、`resolveAssetRef` 都能看到并引用它们。
- 素材库新增「无限画布」来源分类。

**接口**

- `POST /api/boards/:id/bridge/assets`：`{ items: [{assetId,title?,prompt?}] }`
- `POST /api/conversations/:id/canvas/append`：`{ assetIds }`，只允许普通对话。

### 25.3 增量 SSE

- `AgentStreamEvent.board` 增加可选 `delta`：`BoardDelta`。
- 服务端 `buildBoardDelta()` 按 id 比较节点 / 连线 / 分组，只带新增和修改项、删除 id、`nextRef`、`baseVersion` 和 `version`。
- `board_apply` / `board_generate` 在保存后直接推送增量，不再只发一个空事件。
- 客户端：
  - `applyDelta()` 先检查当前版本是否等于 `baseVersion`，且没有本地未保存改动 / 正在保存；
  - 通过 `applyBoardDeltaToDoc()` 合并（保留原顺序，新项追加），更新版本和选中；
  - 不满足条件（版本对不上、有本地改动）时回退到整份 reload。
- 正常情况下 Agent 改完画布不再整份重拉；生成任务的结果仍由客户端轮询对账增量写回。

### 25.4 测试

- 新增 `tests/board-bridge.test.ts`：3 条，覆盖分镜素材进无限画布、去重 / 跨板链接、追加参考图组与 8 张上限、无限画布线程拒绝。
- 新增 `tests/board-delta.test.ts`：2 条，覆盖增量内容、删除项、`applyBoardDeltaToDoc` 合并一致。
- `tests/board-agent.test.ts` 增加断言：`board_apply` 的 SSE 事件确实带 delta，客户端合并结果等于服务端文档。
- 全量：42 个测试文件、387 条用例通过；`npm run build` 通过。
- 手测：导航 / 标题改名、入门侧栏收起、创作历史、默认平移、气泡拖动、跨模式桥弹窗、音频节点渲染。
- 没有消耗真实生成额度；测试产生的临时板已删除，原板配置已还原。

### 25.5 限制

- 跨模式桥只搬图片：视频 / 音频没有加入参考图组或无限画布的入口。
- 增量 SSE 只在没有本地未保存改动时生效；用户正在编辑时仍回退整份 reload（会以服务端版本为准）。
- 手动保存、另一个窗口的修改没有 SSE 广播，仍依赖版本冲突提示。
- 模板 / 协作 / 云同步仍未做。

---

## 26. 模板层与分镜入口隐藏（2026-10-27）

### 26.1 模板协议与存储

- 新增 `canvas-template` 共享协议：
  - 模板节点用 `tempId`（t1、c1…）互相引用，导入时再换成真实 id / nX；
  - 节点类型支持 text / image（占位）/ config；
  - 配置节点保留 image / video / text / audio 的生成参数；
  - 支持连线、分组；
  - 模板不携带任何 assetId，导入不会自动生成。
- 新增 `canvas_templates` 表：id、名称、说明、来源（agent / storyboard / import）、来源对话、doc_json、创建时间。
- `templateInputToDoc()` 把临时模板转成合法 BoardDoc；`instantiateDoc()` 在导入时重新分配 id / ref，并平移到已有内容右侧。

### 26.2 对话生成模板

- 新增 Agent 工具 `create_canvas_template`：接收临时节点 / 连线 / 分组，生成模板并返回 `templateId`。
- `create_storyboard` 在拆完分镜后自动生成一份「按场景分组」的模板：
  - 每镜一个文本节点（剧本、台词、景别、运镜等参考信息）和一个配置节点（真正用于生成的 prompt）；
  - 文本节点连到配置节点，但配置节点不拼接上游文本，避免把标签送进生图模型；
  - 只排结构，不提交任何生成任务。
- 工具卡上出现「导入无限画布」按钮：选已有板或新建板；只创建节点和提示词，不自动生成。
- 无限画布顶栏新增「模板」抽屉：列出对话 / 分镜生成过的模板，可再次放入当前画布。

### 26.3 接口

- `GET /api/templates`：模板摘要列表。
- `GET /api/templates/:id`：完整模板。
- `POST /api/boards/from-template`：`{templateId, title?}` 新建板并实例化。
- `POST /api/boards/:id/templates`：`{templateId}` 导入已有板。

### 26.4 分镜入口

- 对话页头的「分镜」按钮暂时隐藏（`STORYBOARD_ENTRY_ENABLED = false`）。
- 后端分镜表、Agent 工具、StoryboardPanel 代码全部保留；已经生成的分镜数据和图片不受影响。
- 当前对话侧的分镜用途改为：
  1. Agent 拆剧本；
  2. 自动生成分镜模板；
  3. 用户在工具卡上导入无限画布继续生成。
- 这样后续决定彻底删除分镜时，可以先迁移模板和旧数据，再删后端，不需要一次性动 900 多处引用。

### 26.5 验证

- 新增 `tests/canvas-template.test.ts`：4 条，覆盖模板生成、导入已有板的重排 / 分组、从模板新建板、分镜自动生成模板且不产生任务、模板接口列表 / 详情 / 新建 / 导入。
- 全量：43 个测试文件、391 条用例通过；`npm run build` 通过。
- 手测：
  - 对话页头不再出现「分镜」入口；
  - 无限画布顶栏「模板」抽屉能列出模板，放入画布后节点 / 分组出现，撤销可恢复；
  - 分镜「发到无限画布」和「参考图组」桥接仍正常。
- 测试用临时模板已删除，原画布内容已恢复；没有消耗真实生成额度。

### 26.6 限制

- 模板目前只支持 text / image 占位 / config；视频 / 音频结果节点由配置节点生成，不能作为空占位提前摆出来。
- 模板导入不做模型可用性检查；跨机器导入后，配置节点里的模型 alias 可能需要在画布上重新选择。
- 模板库只能导入，不能重命名 / 删除；模板版本不追踪。
- 分镜入口只是隐藏，旧分镜面板代码仍在；彻底删除需要另做迁移。

---

## 27. 模板库管理、音视频占位与分镜迁移（2026-10-27）

### 27.1 模板库管理

- 模板抽屉每行新增：
  - 双击名称或点铅笔按钮原地重命名；
  - 删除按钮（确认后删除模板，已导入画布的副本不受影响）；
  - 「放入画布」保持原样。
- 接口：
  - `PATCH /api/templates/:id`：`{name?, description?}`
  - `DELETE /api/templates/:id`
- 删除只删模板记录；模板实例化出来的节点、连线、分组仍在画布里。

### 27.2 视频 / 音频占位

- 模板节点类型扩展为 `text | image | video | audio | config`。
- image / video / audio 都是空占位：没有 assetId，导入后状态是 empty；用户可手动绑定素材，或把配置节点的结果节点当作它们。
- 默认尺寸：
  - image 280×210
  - video 320×240
  - audio 300×110
- Agent 工具说明同步更新；`config` 仍是唯一真正执行生成的地方。

### 27.3 分镜迁移

- 新增 `storyboard_migrations` 表，每个会话只迁移一次。
- 迁移流程：
  1. 复用/生成该会话的分镜模板；
  2. 新建一块 `分镜 · <会话名>` 无限画布；
  3. 导入模板的文本 / 配置 / 分组；
  4. 把已生成的分镜图、视频、配音作为结果节点接到对应配置节点；
  5. 把素材链接写入 `board_assets`；
  6. 记录迁移标记。
- 迁移不删除旧分镜表和旧图片；迁移失败时会删掉临时新建的空板。
- 接口：`POST /api/templates/migrate-storyboards`。
- 模板抽屉底部新增「迁移旧分镜」按钮；完成后刷新模板列表和侧栏画布列表。
- 在本机现有数据上已执行一次迁移：4 个有分镜的会话生成了 4 块画布，其中「帮我写一个剧本」迁移出 23 镜、15 张分镜图、9 个场景分组。

### 27.4 验证

- `tests/canvas-template.test.ts` 扩展到 7 条：
  - 模板生成 / 导入重排 / 分组；
  - 从模板新建板；
  - 分镜自动模板；
  - 模板接口；
  - 视频 / 音频占位；
  - 模板重命名 / 删除；
  - 旧分镜迁移与重复调用跳过。
- 全量：43 个测试文件、394 条用例通过；`npm run build` 通过。
- 手测：模板抽屉列出 4 个迁移模板，重命名 / 删除按钮可见；执行迁移后侧栏出现 4 块「分镜 · …」画布；原画布内容未被改动。
- 没有消耗真实生成额度。

### 27.5 限制

- 迁移只搬「分镜图 / 视频 / 配音」结果，不单独为每镜的首帧 / 尾帧 / 参考图建输入节点；这些素材仍可通过素材库或桥接手动加入。
- 迁移不删除旧分镜表；旧入口只是隐藏，彻底删除需要后续单独做一次数据清理。
- 模板库没有复制、版本历史、分类 / 搜索。
- 视频 / 音频占位导入后不会自动绑定素材，仍需要用户上传或生成。

---

## 28. 大脑空正文排查（2026-10-27）

### 28.1 现场

用户上传 5,918 字的《剧情.md》后连续两次收到「（大脑没有返回内容）」；重新上传后再发「1」仍然为空。之后模型还声称「上一轮没接到文档」，用户只能重新上传。

数据库里的 `brain_calls` 记录：

- `completion_tokens = 4096`
- `reasoning_tokens = 4096`
- 正文为空

也就是模型把 4,096 的输出额度全部用在思考过程上，`finish_reason = length`，正文一个 token 都没留下。不是脚本太长、不是上传失败，也不是解析 JSON 失败。

### 28.2 修复

- `BRAIN_DEFAULT_MAX_TOKENS` 从 4,096 提到 16,384；长上下文 + 推理模型不再一开始就被截断。
- `BrainRunner.callBrainWithRecovery` 增加空正文自救：
  - 如果第一次 `content` 为空，自动用 32,768 的额度再请求一次；
  - 仍为空时才落错误消息，并明确说是「输出额度用在思考上」而不是笼统的「大脑没有返回内容」。
- 创作板的生文本（`generateBoardText`）同样改成 16K 起步、空正文时 32K 重试。
- 脚本文档上下文增加一次失败回退：
  - 如果紧挨着当前用户消息的助手消息是错误，且当前轮没有新文档，就往回找最近一份上传文档并带上；
  - 这样空正文之后用户只说「重试 / 1」也能继续，不用第三次上传；
  - 正常成功后不会重复把旧文档灌进上下文。
- 创作板 Agent 提示词明确：画布线程不能生成模板；用户要拆剧本 / 做模板时，引导到「对话创作」生成后导入，不要用生文本或几十条 `board_apply` 假装修好一个模板。

### 28.3 关于第二张截图

第二张截图是「无限画布助手」在画布里生成的单个文本节点，不是模板：

- 画布线程只有 `board_read / board_apply / board_generate`，没有 `create_canvas_template`；
- 它用「生文本」把分镜表写成了一段文本，所以看起来像拆好了，实际只是 n3 文本节点；
- 正确的模板流程在「对话创作」：让助手拆镜 → `create_storyboard` 自动生成模板 → 工具卡点「导入无限画布」；
- 现在画布助手会直接说明这一点，不再尝试用文本节点冒充模板。

### 28.4 验证

- 新增 `tests/brain-token-retry.test.ts`：模拟第一次 reasoning 用满 4,096、正文为空，断言第二次请求使用 32,768 并成功落消息。
- 新增 `tests/document-context.test.ts`：空正文错误后下一轮「重试」仍能拿到最近上传的脚本；正常成功后不会重复带旧文档。
- 全量：45 个测试文件、397 条用例通过；`npm run build` 通过。
- 用真实失败会话的数据核对：两次空回复都对应 `reasoning_tokens = completion_tokens = 4096`，确认根因。
- 没有为验证再消耗真实大脑额度。

### 28.5 备注

- 已经失败的那条会话不需要重新上传：更新后再发一句「继续拆」即可，失败回退会把最近一份《剧情.md》带上。
- 如果模型仍然把 32K 全用在思考上，会明确提示换非推理模型，而不是继续沉默。

---

## 29. 分镜设定参考、旧数据清理与拆分镜收敛（2026-10-27）

### 29.1 模板 / 迁移带角色和场景

- 分镜模板现在包含：
  - `角色 · 名字` 图片占位（x 在镜头左侧负坐标区）；
  - `场景 · 名字` 图片占位；
  - 「角色设定」「场景设定」分组；
  - 每个镜头按 `character` / `characters` / `scene` 自动连到对应设定图，role = reference，最多 8 张。
- 迁移画布会把旧分镜里已经绑定到角色 / 场景的设定图直接写进这些占位节点，并建立 `board_assets` 链接；没有设定图的保留空占位，等待用户上传或生成。
- 旧分镜迁移版本升到 v2：
  - `storyboard_migrations.version`；
  - 升级时删除上次迁移生成的旧画布并重建，旧模板删除，避免模板库重复；
  - UI 迁移按钮会提示「上一次迁移生成的旧版画布会升级重建」。

### 29.2 删除旧分镜数据

- 新增 `POST /api/templates/cleanup-storyboards`：
  - 只处理 v2 迁移过、迁移画布仍存在的会话；
  - 删除 `conversation_shots / conversation_characters / conversation_scenes / graph positions`；
  - 模板和迁移画布不受影响。
- 模板抽屉新增「删除旧分镜数据」按钮，带确认。
- 已在本机实际执行：
  - 5 个有分镜的会话升级为 v2，迁移画布增加角色 / 场景节点和参考连线；
  - 随后清理了这 5 个会话的旧分镜表数据；
  - 执行前数据库备份：`data/app-backup-before-v2-migration.db`。
- 旧分镜后端代码和隐藏面板仍保留，但聊天提示词不再暴露 `create_storyboard` / `tag_storyboard_characters`，新流程不会继续写旧分镜表。

### 29.3 新的拆分镜工具（更短、更少输出）

- 新增 `create_storyboard_template`：
  - 只接收：`title`、`characters`、`scenes`、`shots[{prompt, character, scene, dialogue?, speaker?, shotSize?, cameraMove?}]`；
  - **默认 12–24 镜，最多 30 镜**，每镜 prompt 40–80 字；
  - 不再要求 `sourceText / soundEffect / durationSeconds / videoPrompt / voice / aspectRatio`；
  - 直接生成模板，不写 `conversation_shots`，不提交生成。
- 聊天提示词改为优先使用这个工具：
  - 不要逐句拆成 40–60 镜；
  - 不要输出逐条分析或思考过程；
  - 角色 / 场景设定自动作为参考节点连到镜头。
- 旧的 `create_storyboard` / `tag_storyboard_characters` 已从工具清单、执行器和提示词中删除；旧分镜 HTTP API、旧面板组件与旧面板测试也已删除。

### 29.4 超时与输出额度

- `BRAIN_DEFAULT_TIMEOUT_MS` 从 120 秒提高到 240 秒；
- 超时不再自动重试（避免再等一轮），直接给用户明确提示「模型思考超时，拆短一点或换非推理模型」；
- 空正文仍走 16K → 32K 的额度自救；
- 创作板生文本超时也翻译成中文提示。

### 29.5 验证

- `tests/canvas-template.test.ts` 扩展到 8 条：角色 / 场景占位、参考连线、新分镜模板工具、迁移、清理。
- `tests/brain-token-retry.test.ts`、`tests/document-context.test.ts` 继续通过。
- 全量：45 个测试文件、398 条用例通过；`npm run build` 通过。
- 本机迁移结果：5 个会话，最大一块迁移画布 74 个节点（23 镜、15 张分镜图、13 个角色 / 场景占位、41 条参考连线、11 个分组）。
- 没有消耗真实大脑额度。

### 29.6 限制

- 迁移保留设定图占位；旧分镜里没有生成过设定图的角色 / 场景只能留空，需要用户自己上传 / 生成。
- 新分镜模板没有视频专用提示词 / 音效 / 时长字段，需要时用户可以在画布配置节点里补充。

## 30. 画布体验补全：媒体节点、参数、避让与旧分镜清理

### 30.1 媒体节点就地生成（P5）

- 图片 / 视频 / 音频节点不再只是「上传 / 结果占位」，现在自带：
  - 提示词输入框；
  - 直接生成按钮；
  - 左侧输入端口和右侧输出端口，可接文本 / 图片上游，也可继续连到别的生成节点。
- 媒体节点生成是**就地回填**：任务结果写回同一个节点，不再额外生成一张结果卡。
  - 配置节点仍然是「汇总多张参考图 + 批量结果」，一次生成 N 张 / 2 首音乐时继续使用；
  - 单图 / 单视频 / 单段配音直接用媒体节点，卡片数从 2~3 张降到 1 张。
- 服务端 `generateBoardConfig` 会按节点类型分发：
  - `config`：保持旧行为，创建结果节点；
  - `image` / `video` / `audio`：`generateBoardMediaNode` 就地生成；
  - 任务仍写 `board_tasks`，停止 / 重试 / 轮询回填沿用原链路。
- 模板里的 `角色 · 名字` / `场景 · 名字` 占位现在可以直接写提示词生成，不再只能上传。
- 已有结果的媒体节点默认收起提示词，把高度让给图片 / 视频；右下角箭头可以随时展开。
- 旧版分镜模板里角色 / 场景挤在镜头左侧的问题，在重新导入时会被重排成「角色一行、场景一行」，镜头从下方开始。

### 30.2 生成结果避让

- 旧算法固定把结果放在配置节点右侧 120px，模板里下一行的文本 / 配置卡正好在同一落点，于是新图盖住旧卡。
- 新 `placeResultNode`：
  - 从配置节点右侧开始；
  - 先向下找空位，一列排满再向右挪一列；
  - 用 24px 间距与所有已有节点做矩形相交检查。
- 图片 / 视频 / 音频 / 文本结果都走这套避让。

### 30.3 配置节点完整参数

- 新增并持久化：
  - 图片：`negativePrompt`、`aspectRatio`、`seed`、`style`、`background`、`outputFormat`、`moderation`；
  - 视频：`seed`、`aspectRatio`、`promptExtend`、`watermark`；
  - 音乐：`musicTitle`、`musicTags`、`musicNegativeTags`、`instrumental`。
- 检查器新增可折叠「高级参数」区；不支持的字段由适配器忽略，不会导致生成失败。
- 新增「配音（TTS）」和「音乐」两个添加入口；音频节点可以在检查器里切换 `audioKind`。

### 30.4 模型下拉与顶栏

- `ModelPicker` 改为 `createPortal` + `position: fixed`：
  - 不再被检查器的 `overflow: auto` 裁掉；
  - 自动夹在视口内，下方空间不足时向上翻。
- 画布顶栏在 `<=1560px` 时隐藏按钮文字、只留图标（tooltip 保留），标题收窄；1280 默认窗口下最后一个按钮距离右边缘仍有 16px，不再被窗口边框遮挡。
- 撤销 / 重做补上图标，避免收起文字后出现空白圆角按钮。

### 30.5 旧分镜清理

- 删除：
  - `src/client/chat/StoryboardPanel.tsx`、`StoryboardCanvas.tsx`、`StoryboardExportDialog.tsx`、`video-export.ts`、`storyboard.css`；
  - 所有 `/api/conversations/:id/storyboard*` 路由与 `src/server/storyboard.ts`；
  - `create_storyboard` / `tag_storyboard_characters` 工具、schema、提示词与旧测试。
- 保留：
  - `conversation_shots / characters / scenes` 表和历史数据读取方法，仅用于 `canvas-template` 的旧分镜迁移；
  - `shared/storyboard.ts` 里的脚本文档字数常量；
  - 模板抽屉里的「迁移旧分镜」「删除旧分镜数据」。

### 30.6 存储方案

- 当前画布数据：
  - SQLite：`data/app.db`（开发）/ 桌面端应用数据目录下的 `app.db`；
  - 画布文档、版本历史、素材链接、任务映射都在 SQLite；
  - 素材文件：默认 `data/assets`，可在「设置 → 素材目录」改到任意路径；
  - 缩略图：`data/thumbs`，跟随数据目录。
- 自定义路径：
  - 素材目录支持运行时设置，只影响之后生成的产物，旧文件仍按各自 `base_dir` 读取；
  - 整个数据目录（含 `app.db`）可通过启动环境变量 `DATA_DIR` 指定；桌面端由 Tauri 传入，不在设置界面暴露（运行中移动 SQLite 不适合做热切换）。
  - 画布本身支持 JSON 导入 / 导出，可跨机器迁移结构（素材 id 不存在时会清空并提示）。

### 30.7 验证

- `npx tsc --noEmit`、`npm run build` 通过。
- 全量：43 个测试文件、369 条用例通过。
- 新增：
  - 图片节点就地生成不新增节点；
  - 生成结果避开落点已有节点；
  - 音频节点就地生成配音；
  - 输入连线允许连到媒体节点、音频拒绝图片输入。
