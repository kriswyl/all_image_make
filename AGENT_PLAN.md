# 益达工作台 · 对话式 Agent 能力设计

> 状态：**设计稿，尚未实现**。对应版本规划 `2.1.0`。
> 本文只描述设计，不含代码改动。实现时以本文为参照，有偏差请回来改这份文档。

## 1. 目标

在现有「生图 / 视频 / 渠道 / 历史」四个工作区之外，增加第五个工作区**对话**，用自然语言驱动生成：

1. **一句话调用各个模型**——"用 gemini 画个猫"、"用万相做个 5 秒视频"
2. **多轮对话改图**——"背景换成雨夜"、"再加一把伞"
3. **先生图再生视频**——"画一只柴犬，然后让它点头"
4. **优化提示词再生成**——"帮我把提示词写详细点再画"
5. **看图改**——大脑能看到当前画布的实际画面，而不是盲改

## 2. 设计前提

本方案的核心判断：**Agent 只是 `TaskRunner` 的第二个调用方**，第一个是现有的生图 / 视频工作台。

因此 `src/server/adapters.ts`、`src/server/security.ts`、`src/server/key-store.ts` **完全不需要改动**。Agent 产出的一切任务照常进 `tasks` / `assets` 表，照常出现在生成历史页，照常支持双击放大、下载、诊断——全部免费复用。

新增的复杂度集中在三块：**大脑调用**、**会话状态**、**对话 UI**。

## 3. 已确认的决策

| # | 决策 | 取值 |
|---|---|---|
| 1 | 大脑怎么接入 | 新增 `openai-chat` 适配器，作为正常渠道进渠道列表 |
| 2 | 对话界面放哪 | 独立的第五个工作区 |
| 3 | 多轮改图的画布语义 | 隐式自动切换 + 界面分两区（当前画布 / 本会话的图），可手动增删、设主图 |
| 4 | 长任务完成后 | 默认自动续跑，但 **视频生成前插一道可配置的确认** |
| 5 | 看图改 | **做**。画布主图缩到 512px 作为 `image_url` 进上下文 |

---

## 4. 大脑接入：`openai-chat` 适配器

### 4.1 为什么用适配器而不是另开一套配置

做成 `Channel` 的一种，可以直接白嫖现有的：渠道列表、添加渠道向导、连接测试、品牌图标、`KeyStore` 密钥管理、`applyAuth()` 的五种鉴权方式、SSRF 防护。另开一套配置则这些都要重写一遍。

### 4.2 定义

| 项 | 值 |
|---|---|
| `adapterType` | `"openai-chat"`（加进 [types.ts:1](../src/shared/types.ts) 的联合类型） |
| 默认路径 | `/v1/chat/completions`（加进 [adapters.ts:143](../src/server/adapters.ts) 的 `defaultEndpoint()`） |
| 鉴权 | 复用 `applyAuth()`，`bearer` / `x-api-key` / `query` / `custom-header` / `none` 全支持 |
| 密钥 | 复用 `KeyStore` 与 `resolveKey()`，**零改动** |
| 请求体 | `{ model, messages, stream: true, temperature }` |
| 响应 | SSE `data: {...}` 增量，拼 `choices[0].delta.content` |

### 4.3 关键约束

**大脑调用不经过 `TaskRunner`，也不使用 `GenerationInput`。**

它是一次裸 HTTP 调用，由 `src/server/brain.ts` 直接发起。原因是 `adapters.ts` 的 `buildGenerationRequest()` 是为生图服务的参数映射器，硬塞 chat 语义进去会污染它。`brain.ts` 保持极简，只做三件事：拼 headers、发请求、拼流。

### 4.4 注意点

`isVideoAdapter()`（[types.ts:16](../src/shared/types.ts)）是按白名单判断，加 `openai-chat` 不会误伤。但 `App.tsx` 里按适配器渲染参数面板、以及生图 / 视频工作台的渠道选择器，都需要确认 **`openai-chat` 渠道不会出现在生图工作台的渠道下拉里**——它是大脑专用，不该被当成出图渠道。

建议给 `types.ts` 加一个和 `isVideoAdapter` 对称的 `isChatAdapter()`，所有筛渠道的地方统一用它。

### 4.5 预设

`src/shared/provider-presets.ts` 给向量引擎、词元流墟各补一个 `chat` 单元，模型 ID 用中转站实际在售的文本模型。

---

## 5. 数据模型

两张新表，通过 `task_id` / `asset_id` 关联到现有 `tasks` / `assets`，**不重复存产物**。

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id                   TEXT PRIMARY KEY,
  title                TEXT NOT NULL,           -- 首条用户消息截断 20 字
  brain_channel_id     TEXT NOT NULL,
  brain_model          TEXT NOT NULL,
  canvas_asset_ids    TEXT,                    -- 画布：有序 JSON 数组，见 §10
  current_asset_id     TEXT,                    -- 已废弃：老的画布指针，只被一次性回填读过
  status               TEXT NOT NULL DEFAULT 'idle',
                                                -- idle | running | waiting_task | awaiting_confirmation
  video_confirm_policy TEXT NOT NULL DEFAULT 'auto_only',
                                                -- always | auto_only | never，见 §13
  auto_continue_count  INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  seq              INTEGER NOT NULL,            -- 会话内递增，保证顺序
  role             TEXT NOT NULL,               -- user | assistant | tool | system
  content          TEXT,                        -- 气泡正文
  plan_json        TEXT,                        -- 大脑原始输出，可回放可调试
  tool_name        TEXT,
  tool_args_json   TEXT,
  tool_result_json TEXT,
  task_id          TEXT,                        -- → tasks.id
  asset_id         TEXT,                        -- → assets.id
  status           TEXT NOT NULL DEFAULT 'ok',  -- ok | pending | error
  error_message    TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, seq);
```

**`auto_continue_count` 放在会话上而不是消息上**，因为护栏要按会话算总账。

### 建表方式

沿用 `db.ts` 现有模式：`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 手工补列。`db.ts:126` 已经有补列的先例，照抄即可。项目没有迁移框架，也不需要引入。

### `assets` 表补列（看图改需要）

```sql
-- 沿用 PRAGMA table_info(assets) + ALTER TABLE ADD COLUMN 的补列逻辑
thumb_path TEXT   -- 相对 thumbs/ 的缩略图文件名，见 §11
```

### 5.1 落地时的实际差异

实现过程中为了少绕路改了几处，记在这里，免得后来人对着上面的 SQL 找不存在的列。

| 设计里写的 | 实际落地的 | 为什么 |
| --- | --- | --- |
| `conversations` 无视觉开关 | 多一列 `vision_enabled INTEGER NOT NULL DEFAULT 1` | §11.7 要求「会话级开关」，不放会话上就只能全局放，而全局开关没有意义——同一个用户可能这个会话盲改、那个会话看图改 |
| `messages` 无确认字段 | 多一列 `confirm_json TEXT` | §13.5 的确认卡片刷新后必须还在。塞进 `tool_result_json` 也能跑，但那样「工具执行结果」和「还没执行的待确认参数」就是同一个字段的两种语义，回放时得靠 `role`/`status` 猜，太脆 |
| — | `AppDatabase.thumbsDir`（`{DATA_DIR}/thumbs/`） | 缩略图要落盘给 `assets.thumb_path` 用，得有个明确的家。和产物目录一样按 `DATA_DIR` 派生，测试里换成临时目录就隔离了 |
| `Conversation` 上存 `auto_continue_count` | `auto_continue_count` 照旧存，另外 `taskCount` 用 `COUNT` 现算 | 额度要用「这个会话一共花了几次任务」，这是个**派生值**，存起来就得在每个提交路径上记得加一，漏一处就永久错位 |

**另外三处值得单独记一笔：**

1. **§11.2 的附图方式是「追加一条合成 user 消息」，不是往最后一条 user 消息里塞 content part。**
   后者要改动已落库的消息内容（或者只在内存里改，但那样回放和实时走的是两条路径）。
   追加一条 `[{type:"text"},{type:"image_url"}]` 的尾随消息，历史消息保持原样，回放天然一致。

2. **§14 的 SSE 拆成了独立的 `GET /api/conversations/:id/events`，不是 `POST .../messages` 的响应。**
   这样「发消息」和「收事件」之间没有先后依赖：页面刷新、断线重连、甚至先开流再发消息都成立。
   代价是要处理重连，做法是 `EventSource` 的 `onOpen` 触发一次全量拉取补齐错过的事件。

3. **§14 的事件表里没有 `asset` 事件，`done` 也不带 `messageId`。**
   产物不是独立事件——工具执行完会落一条 `message`（带 `assetId`/`taskId`），UI 从它里面取就行，
   少一种事件就少一处要对齐的状态。`done` 只报 `status`，因为前端拿到 `done` 后无论如何都会
   重新拉一次会话（画布、任务额度都不在事件流里），没必要再传 id。

4. **§13.5 确认卡片上改过的参数，跟着那次确认请求一起提交**（`POST /confirm` 的 `args` 字段），
   没有单独的「保存修改」接口。分开两步的话，「改完参数再点确认」和「只改不确认」之间会出现
   服务端拿旧参数执行的时间窗——而执行是真的花钱。

5. **`ChatView` 里所有回调身份必须先固定住，SSE 那个 effect 才不会变成请求风暴。**
   `App` 传给 `ChatView` 的 `onToast` 是 JSX 里现写的箭头函数，App 每次渲染都换一个新身份；
   它顺着 `toastError → reloadList / reloadView` 一路传进「开 SSE」和「首次加载」两个 effect 的
   依赖数组，于是 App 每渲染一次，会话事件流就断开重连一次，`onOpen` 又补一次全量拉取。
   而 App 恰恰是**每隔 1.8 秒**渲染一次（`usePolling` 在建任务进行中时 `setTasks`）。
   修法是 `onToastRef` + 一个 `useCallback([], …)` 的 `toast`，让这个链条上所有函数都恒定；
   实测空闲 20 秒零请求。
   同时给 `api.ts` 加了带 `status`/`code` 的 `ApiError`——`reloadView` 必须能分辨「这条会话没了（404）」
   和「这次请求失败了」，前者要放掉 `localStorage` 里的指针并刷新列表，后者只该弹个提示。
   不区分的话，一个已删除的会话 id 会被 SSE 重连和 `onOpen` 反复拉，用户一直看到「会话不存在」。

---

## 6. 能力清单与别名解析

### 6.1 问题

如果让 LLM 直接输出 `channelId` 和 `model`，它**一定会编造**不存在的值。中转站的模型 ID 尤其五花八门（`gpt-image-2`、`sd-2.0-fast`、`wan3.0-video`），模型没有理由记得住。

### 6.2 解法：alias 中间层

服务端从用户真实渠道生成一份**别名表**，只把 alias 和该 alias 的能力摘要喂给大脑。大脑只能填 `modelHint: "gemini"`，由服务端解析成真实的 `channelId` + `model`。

```
alias=gemini  →  { channelId: "ch_7", model: "gemini-3-pro-image" }
alias=wan     →  { channelId: "ch_9", model: "wan3.0-video" }
```

alias 的生成规则：取模型 ID 的语义前缀（`gpt` / `gemini` / `wan` / `seedance` / `grok`），同类目多个则加后缀（`gpt` / `gpt-c`）。同一 alias 下多个渠道时，选该渠道的 `enabled` 且排在最前的。

`src/server/capabilities.ts` 负责：

- `buildCapabilityManifest(channels)` —— 生成喂给大脑的文本块
- `resolveAlias(alias, kind)` —— alias → `{channelId, model}`，失败返回默认
- `defaultChannelFor(kind)` —— 兜底用的类目默认渠道

### 6.3 能力清单文本

每个 alias 压成一行，只给大脑做决策必需的信息：

```
alias=gpt-image  图片  尺寸=1024x1024|1536x1024|1024x1536  图生图=✔  视觉=✘
alias=gemini     图片  宽高比=1:1|16:9|9:16  尺寸=1K|2K|4K  图生图=✔  视觉=✔
alias=wan        视频  2-30s  480P|720P|1080P  模式=文生|首帧|首尾帧|参考|编辑|延长  音频=✔  提示词扩展=✔
alias=seedance   视频  4-30s  480p|720p|1080p  音频=✔
alias=grok       视频  1-15s  480p|720p|1080p  参考图≤7
```

**这一段绝不能出现 `baseUrl`、密钥、完整 `channelId`。** 只有 alias 和能力。

---

## 7. 系统提示词

每次调用大脑时由服务端拼装，固定四段：

```
【你是谁】
你是益达工作台的生成助手。你只能通过工具操作。
绝对不要凭想象描述生成结果——图片还没出来时你并不知道它长什么样。

【可用模型】
<§6.3 的能力清单>

【当前画布】
#a3f1（主图） 来自第2轮  1200x800  "一只猫"
#b2c4  来自第3轮  …
（无图时整段省略；有图时**列出整组**，大脑复述 ref 时才有得抄）

【历史结果】
第1轮 #b21 图"柴犬" · 第2轮 #a3f 图"猫" · 第3轮 #c09 视频5s
（只给文字摘要）

【规则】
1. 一次只输出一个 JSON 对象，不要输出解释文字、不要包 markdown 代码块。
2. 模型一律用 alias，不要编造 channelId 或模型 ID。
3. 信息不足（如时长、尺寸）时用 ask 工具反问，不要猜。
4. 视频优先开启 promptExtend，不要自己重写提示词——渠道自带的扩展比你的改写便宜。
5. 修改图片时默认基于当前画布（**整组**都会当参考图发出去），除非用户明确说要重新画；
   画布有多张时，用户说「改这张」默认指主图。

【输出格式】
{"tool": "...", "args": {...}, "say": "给用户看的一句话"}
```

### 7.1 用 JSON 协议而不是原生 function calling

**基线走严格 JSON 文本协议，不用 `tools` / `function_call` 参数。**

原因是中转站对 function calling 的透传质量参差不齐，有的直接把 `tools` 字段吞掉，有的返回格式不符合 OpenAI 规范。JSON 协议在所有兼容 `/v1/chat/completions` 的中转站上行为一致。

代价是模型可能输出格式不准，靠 zod 严格校验 + **失败重试一次**兜住（见 §9）。实践里这一步能挡掉大部分噪音。

工具少的时候（本例 7 个），JSON 协议还有额外好处：schema 可以写进系统提示词里用自然语言解释，比 JSON Schema 更省 token。

---

## 8. 工具清单

| 工具 | 参数 | 说明 |
|---|---|---|
| `generate_image` | `prompt, modelHint?, size?, aspectRatio?, count?, fromScratch?` | `fromScratch=true` 表示不带参考图 |
| `edit_image` | `prompt, modelHint?, extraReferences?: string[]` | 强制带上画布**整组**作参考；`extraReferences` 是临时补的一两张 |
| `set_canvas` | `assetRef?` 或 `assetRefs?: string[]` | 用这些替换画布（有序列，`[0]` 是主图） |
| `optimize_prompt` | `prompt, target: 'image'\|'video'` | 只返回优化后的文本，**不直接生成** |
| `generate_video` | `prompt, modelHint?, mode?, duration?, resolution?, audio?, promptExtend?, imageFrom?` | 默认 `imageFrom: 'current'` |
| `ask` | `question, options?` | 信息不足时反问，不猜 |
| `reply` | `text` | 纯文本回复，结束这一轮 |

### 8.1 `generate_video` 的模式选择

由大脑根据当前素材自行决定：

| 场景 | mode |
|---|---|
| 画布上有图 | `first-frame`（取**主图**，其余几张不发） |
| 用户提供两张图 | `first-last-frame` |
| 纯文字描述 | `text-to-video` |
| 用户说"把这个视频改一下" | `video-edit` |

### 8.2 生图 → 生视频的接线点

`generate_video` 默认 `imageFrom: 'current'`。服务端读出画布**主图**（`canvasImages[0]`）对应的本地文件，转成 data URI，塞进 `wanVideoMedia: [{ type: 'first_frame', url: 'data:...' }]`。视频的 `first_frame` 只有一个槽，所以画布上其余几张这一轮不发。

这套 `buildWanMedia()`（[adapters.ts:75](../src/server/adapters.ts)）已经写好了，直接用。

⚠️ **内联素材有体积上限**。`tasks.ts:40` 的 `MAX_INLINE_MEDIA_CHARS = 1_400_000` 会拦超限请求。agent 传的参考图来自本地落盘的产物，体积不可控，所以：

- 生图产物的参考图入参应尽量走**已生成的较小尺寸**（如果模型支持指定尺寸）
- 超限时 `TaskRunner.create()` 会抛 `AppError`，错误进 `tool_result`，大脑可以据此改参数重试
- 兜底：错误信息里已经写明了"请改用更小的图片"，直接透传给用户

---

## 9. Agent 循环

```ts
async function runTurn(convId: string, opts: { isContinuation: boolean }) {
  let rounds = 0;
  while (rounds++ < MAX_ROUNDS) {              // 6
    const ctx = buildBrainContext(convId);     // §7 的四段式
    const raw = await callBrain(ctx, onToken); // 流式
    const plan = parsePlan(raw);               // zod 严格校验

    if (!plan) {
      if (rounds === 1) {
        // 带上"上次输出格式不对"的纠正提示重试一次
        appendSystem(convId, "你上一次的输出不是合法的 JSON，请只输出一个 JSON 对象。");
        continue;
      }
      appendAssistant(convId, raw);            // 降级成纯文本
      break;
    }

    if (plan.tool === "reply") { appendAssistant(convId, plan.say); break; }

    // §13：视频可能需要用户确认
    if (shouldConfirm(plan.tool, opts.isContinuation, getPolicy(convId))) {
      appendPendingToolMessage(convId, plan);
      setStatus(convId, "awaiting_confirmation");
      emit("confirm", { plan });
      return;                                   // 停在这里等用户
    }

    const result = await runTool(convId, plan);
    appendToolMessage(convId, plan, result);

    if (result.async) {                         // 视频已提交
      setStatus(convId, "waiting_task");
      return;                                   // 退出，等任务完成事件
    }
  }
}
```

### 9.1 任务完成后的续跑

```ts
runner.on("taskFinished", (task) => {
  const conv = db.findConversationByTask(task.id);
  if (!conv) return;
  if (conv.status !== "waiting_task") return;

  if (conv.autoContinueCount >= MAX_AUTO_CONTINUE) {   // 3
    appendAssistant(conv.id, "这个任务完成了，要我接着做什么吗？");
    setStatus(conv.id, "idle");
    return;
  }
  db.bumpAutoContinue(conv.id);
  void runTurn(conv.id, { isContinuation: true });     // 续跑
});
```

### 9.2 `TaskRunner` 需要加事件机制

**当前 `TaskRunner` 没有任何事件机制**（[tasks.ts:71](../src/server/tasks.ts)）。它只有 `private readonly running = new Set<string>()` 和 `queueMicrotask(() => void this.run(id))`，任务在后台跑完没有任何通知。

需要加一个最小的发射器：

- `on("taskFinished", cb)` —— 在 `run()` 的终态（succeeded / failed）处发射
- `on("taskProgress", cb)` —— 在视频轮询循环里发射，用于前端进度条

这是 M3 的前置任务，改动很小但绕不开。备选方案是 agent 层起定时器扫库，但会引入无谓的数据库查询和延迟，不推荐。

---

## 10. 画布（多轮改图）

画布是**有序的一组图**（1~8 张），不是一根指针。整组会一起作为参考图参与下一步；
`[0]` 是**主图**，决定生视频首帧、喂给大脑的那张视觉附件、确认卡上的缩略图。

存成 `conversations.canvas_asset_ids`（JSON 数组）。老列 `current_asset_id` 保留在表里但新代码
不读不写——它只在启动时被**一次性回填**读过：键在 `canvas_asset_ids IS NULL` 上，所以迁移
可重入（中断后重启能补上），而写成 `'[]'`（清空画布）之后那行再也不会被选中、用户清空过的
画布不会在重启时复活。读画布统一走 `db.canvasImages(conversation)`：按数组顺序返回，
顺手滤掉已被删的产物和非图片。

### 10.1 规则

```
U: 画一只猫                  → generate_image(gpt-image)              → a1 ★
U: 背景换成雨夜街道            → edit_image(...)                        → a2 ★
U: 手里加一把透明伞            → edit_image(...)                        → a3 ★
U: 用 gemini 重画上面那张      → generate_image(modelHint=gemini, 带当前画布) → a4 ★
U: 还是第二张好   ← 用户点 a2 缩略图把它加回画布，再点「设为主图」把它提到第一位
U: 加个阴影                   → edit_image(...) 基于 a2                → a5 ★
```

1. 任何**产出图片**的工具成功后，画布**整组替换**成新产物那一张（不是追加）——
   老参考图不会悄悄渗进下一次生成、不会多花钱；想留着重拼就重新点
2. 一行放着本会话的全部图（**每张只出现一次**），单击加入/移出画布、双击看大图；
   在画布里的带序号（① 是主图，底边一条「主图」），非主图带「设为主图」，标题行右侧「清空」。见 §10.2
3. 用户说"重新画一张" → 大脑填 `fromScratch: true`，完全不带参考图（含整组画布）
4. 参考图**总量**封顶 `MAX_REFERENCE_IMAGES = 8`，画布整组优先、`extraReferences` 随后，
   放不下的丢掉并把「已跳过」写进工具卡片。画布上限 `MAX_CANVAS_IMAGES` 就等于这个数——
   8 张画布已经吃掉全部预算，相等不是巧合而是同一笔账
5. `set_canvas` 收 `{assetRef}` 或 `{assetRefs:[…]}`，语义是**整组替换**、去重保序；
   一个 ref 都没解析出来就硬失败（不让大脑把画布悄悄清空）；跳过原因（找不到 / 是视频 /
   超上限）写进 summary。`ToolResult.assetId` 仍然只放主图，整组走 `data.canvasAssetIds`
6. 生视频只吃**主图**一张：`wan-video` / `seedance-video` 的 `first_frame` 只有一个槽，
   画布上其余几张不发给视频模型——这句话在提示词和确认卡上都要写出来，否则用户会以为整组都发了

### 10.2 一行图 + 标记

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ ▦ 本会话的图（全部 11 张）   [画布 3 张 · 一起当参考图 · 生视频用 #c904 当首帧]  清空 │
│ [⑴ 主图 #c904 设为主图 ×][⑵ #d5c1 设为主图 ×][⑶ #5397 ×][#5c1a][#c549]…          │
└────────────────────────────────────────────────────────────────────────────────┘
```

**每张图只出现一次**：一行放本会话的全部图，点一下给它打上「在画布里」的记号——
左上角一个序号（① 就是**主图**，底边再加一条绿色「主图」），不在画布里的没有记号。
右上角留给「你自己传的」来源标记，三个角各占一个，互不打架。

早先的设计是上下两段（上段「当前画布」、下段「本会话的图」两个框，各有标题和底色），
好处是「哪几张参与下一步」一眼可见，代价是**同一张图会在两段里各出现一次**，点一下
整行还会跳，用户的原话是「所有图只展示一次，点一下，被标记的就是当前画布的」。
记号和序号能做到同样的事，且不重复占位；`本会话 N 张图` 和 `画布 N 张` 两个词仍然分得清清楚楚。

- 序号**查表得出**（`canvasIds.indexOf`），不是数「前面有几张在画布里」——画布顺序是点选顺序，
  和 `sessionImages` 的时间顺序无关，数出来的序号会和药丸上写的对不上
- 动作说明（「单击加入/移出，双击看大图」）挂在**每张缩略图自己的 tooltip** 上，
  指到哪张说哪张，比在标题行写一句更容易在"想动手的那一刻"被看见
- 画布为空时，标题行改显示「点一下加入画布 · 双击看大图」，「清空」按钮同时消失

---

## 11. 看图改（视觉上下文）

### 11.1 目标

默认情况下大脑只看到文字摘要，改图是**盲改**——它不知道当前图长什么样，只能照用户的话下指令。开启视觉后，大脑能看着画面理解"把背景换成雨夜"里的"背景"具体指什么。

### 11.2 流程

1. 大脑调用前，若画布**主图**存在且会话开关开着
2. 读取该产物的 **512px 长边缩略图**
3. 转成 `data:image/jpeg;base64,...`，作为 `image_url` content part 附在最后一条 user 消息上
4. 缩略图前面带一行文字锚点，把**整组**列出来：`[当前画布] 画布上有 3 张图，下面附的是主图 #a3f1……其余 2 张是 #b2c4、#c3d5——你没有看到它们的内容，但它们会一起作为参考图发给改图模型`

第 4 条里「你没有看到它们的内容」那半句不能省：大脑只看得到主图，不说清它就会凭 ref 装模作样地
聊一张自己没看过的图（用户说「把第二张的天空换掉」时最容易踩）。

### 11.3 缩略图生成 —— ⚠️ 需要拍板的实现细节

**项目当前没有任何服务端图像处理库。** `package.json` 的依赖里没有 `sharp` / `jimp` / `canvas`，现有的压缩全部在浏览器端用 `createImageBitmap` + canvas 做（见 [VideoGenerateView.tsx:854-882](../src/client/VideoGenerateView.tsx)，那个把视频参考图压到长边 1280）。

服务端生成缩略图是绕不开的（大脑调用发生在服务端）。两个选项：

#### 选项 A：加 `jimp`（推荐）

- **纯 JS 实现，没有原生二进制**，不需要为 Tauri sidecar 单独打包平台文件，不影响 `PACKAGING.md` 里的便携版 / 安装包流程
- 服务端确定性，没有时序竞态
- 大致用法（以实际版本 API 为准）：

```ts
import { Jimp } from "jimp";
const image = await Jimp.read(bytes);
image.scaleToFit({ w: 512, h: 512 });
const jpeg = await image.getBuffer("image/jpeg", { quality: 80 });
```

- 代价：新增一个依赖，便携版包体增加几 MB

#### 选项 B：客户端 canvas 回传（零依赖，但引入时序问题）

- 和现有 `VideoGenerateView.tsx` 的做法一致，符合项目既有风格
- 但 agent 的续跑是**服务端驱动**的，服务端需要缩略图时前端未必已经上传完，要加 SSE 请求 + 等待 + 超时降级的一整套协调逻辑
- 历史产物（对话功能上线前生成的）也需要懒补

**建议选 A。** 多一个纯 JS 依赖换来的是实现简单和没有竞态，值得。

### 11.4 生成时机

两处都做，互为兜底：

- **落盘时预生成**：产物从上游下载下来时本来就有一个 `Buffer` 在手上，顺手缩一张存到 `{DATA_DIR}/thumbs/{assetId}.jpg`，写入 `assets.thumb_path`。用 `try/catch` 包住，失败不影响主流程。
- **使用时懒生成**：大脑要用时若 `thumb_path` 为空（老产物），读原文件现缩现存。

视频不生成缩略图。缩略图放**数据目录**（和 `inputs/` 同级），不放可配置的产物目录——它是派生数据，不是产物，跟着用户改目录跑没意义。

### 11.5 视觉支持的自愈判定

不是所有中转站模型都接受 `image_url` content part。**不做预判，直接用，失败了自我修正：**

1. 大脑调用返回 400 / 明确的"不支持图片"类错误
2. 把 `{channelId}::{model}` 记进 `settings` 表的一个 JSON 数组 `visionUnsupported`
3. 该模型后续不再附图，前端提示一次"该模型不支持看图，已切换为文字改图"
4. 若该模型**只有**它一个可用大脑，则整个会话退回盲改模式

这比维护一张"哪些模型支持视觉"的静态表可靠得多，也不需要新增配置 UI。

### 11.6 附图数量

**默认只附画布主图 1 张。** 上限做成常量 `MAX_VISION_IMAGES`（M1 设 1，将来可调到 3），便于将来支持"把第一张的天空换到第二张上"这类跨图指令。

每张 512px JPEG q80 约 40–80KB → base64 约 55–110KB。即使调到 3 张也在可接受范围。

⚠️ **画布是一组图、但视觉附件仍然只有一张**（§10），这两件事别混：每多附一张就是每轮多一份图元，
而「整组参与」是靠工具层把全组当参考图发出去的，不需要大脑"看见"每一张。代价是大脑认不出
「第二张」的画面内容，只能靠 ref 定位——所以提示词里要写明它没看见那几张（§11.2 第 4 条）。

### 11.7 会话开关

对话头部一个开关「看图改」，默认开。关掉就完全退化成盲改（省 token、省带宽）。

---

## 12. 视频异步与续跑

### 12.1 为什么不能阻塞等

视频任务提交后要走 `VIDEO_POLL_INTERVAL_MS = 8000` × `VIDEO_MAX_POLLS = 100`，最长约 13 分钟。绝不能让大脑调用挂在那里等。

### 12.2 处理方式

`generate_video` 提交后**立即返回** `{ taskId, status: "running", async: true }`。Agent 这一轮先回复"已提交，约 3 分钟"，然后 `runTurn` 退出。

任务完成事件触发后（§9.1），服务端追加一条 tool 消息，并续跑一轮，让大脑判断用户意图是否已满足。

### 12.3 状态机

```
idle → running → waiting_task → running → ... → idle
                    ↓
              awaiting_confirmation   ← §13，停在这里等用户点确认
```

### 12.4 等待期间用户继续发消息

允许。新消息进 `pending` 队列，但**同一会话同时只跑一个生成任务**，否则画布会被两个任务先后覆盖、用户点选的顺序也会跟产出对不上。队列里的消息在处理完之后依次执行。

---

## 13. 视频确认机制

### 13.1 动机

用户要"一气呵成"，但视频又贵又慢，值得在真正花钱前插一道闸。图片便宜快，不插。

### 13.2 策略

```sql
-- conversations.video_confirm_policy
```

| 取值 | 行为 |
|---|---|
| `always` | 任何视频生成都先弹确认，包括用户自己明说的 |
| `auto_only` | **只有自动续跑触发的视频**才确认；用户这一轮亲自说的直接放行（**默认**） |
| `never` | 完全一气呵成，不打断 |

### 13.3 判定逻辑

不靠猜语义，靠**轮次来源**：

```ts
function shouldConfirm(tool: AgentToolName, isContinuation: boolean, policy: Policy) {
  if (tool !== "generate_video") return false;   // M1 只拦视频
  if (policy === "always") return true;
  if (policy === "never") return false;
  return isContinuation;                          // auto_only
}
```

`isContinuation` 是现成的：由 `taskFinished` 事件触发的 `runTurn` 为 `true`，有新鲜用户消息的为 `false`。

签名写成 `(tool, isContinuation, policy)` 而不是写死视频判断，是为了将来想拦"自动连生 4 张图"时只改一行。

### 13.4 流程

```
大脑输出 {tool:"generate_video", args:{...}}
   ↓
shouldConfirm() ?
   ├─ 否 → 照常执行
   └─ 是 → 写一条 status='pending' 的 tool 消息（完整 plan_json 存进去）
           会话 status = 'awaiting_confirmation'
           推 SSE: event: confirm
           runTurn 直接 return
```

### 13.5 确认卡片

```
┌────────────────────────────────────────────┐
│ 🎬 准备生成视频                      待确认 │
├────────────────────────────────────────────┤
│  [ 上一轮生成的柴犬缩略图 ]                   │
│                                            │
│  提示词    这只柴犬缓慢点头，镜头轻微推近        │
│  模型      通义万相 wan3.0-video             │
│  模式      首帧生视频                        │
│  参考图    #a3f1（第 2 轮产物）               │
│  时长      5 秒        分辨率  720P           │
│  音频      开启        提示词扩展  开启         │
├────────────────────────────────────────────┤
│   [ 确认生成 ]   [ 改一下 ]   [ 取消 ]        │
└────────────────────────────────────────────┘
```

| 按钮 | 后端 | 前端 |
|---|---|---|
| **确认生成** | `POST /api/conversations/:id/confirm` → 取出 `plan_json` 执行 → 继续 `runTurn` 循环 | 卡片转成生成中 |
| **改一下** | 不调后端 | 把这条计划的提示词和参数**预填进输入框**，用户改完当新消息发 |
| **取消** | 写一条 system 消息记录取消，清 pending，回 `idle` | 卡片置灰标注"已取消" |

**「改一下」做成预填输入框而非弹出参数表单**：用户直接说"改成 10 秒、1080P"比在表单里翻下拉框快，还能顺便改提示词，少写一个表单组件。

### 13.6 三个必须处理的细节

**① 待确认状态必须持久化。** 存在 SQLite 里，关掉应用重开卡片还在。这与项目已有的"重启后继续轮询视频"（见 `DEVELOPMENT_HANDOFF.md`）是同一种气质，用户体验一致。

**② 待确认时用户直接发新消息，不要拦。** 新消息自动视为"放弃旧计划 + 开新的一轮"，旧卡片置灰标注"已被新指令取代"。拦着不让打字是最让人火大的交互。

**③ 卡片上必须能看到参考图。** 用户要看着上一轮生成的图才能决定值不值得做成视频。这个顺序天然满足——生图 tool 返回时 asset 已经落盘了。

### 13.7 策略配置位置

照抄现有设置的模式：全局默认值进 `settings` 表（和 `assetsDir` 并列，见 [db.ts:120](../src/server/db.ts)），会话级可在对话头部一个小图标覆盖。

---

## 14. SSE 事件协议

`POST /api/conversations/:id/messages` 返回 `text/event-stream`：

```
event: token     data: {"text":"先画"}                            ← 大脑流式输出，UI 显示"思考中"
event: plan      data: {"tool":"generate_image"}
event: args      data: {"prompt":"...","modelHint":"gemini"}      ← 渲染成工具卡片
event: confirm   data: {"plan":{...}}                             ← §13，等待用户确认
event: progress  data: {"taskId":"...","status":"running","progress":0.4}
event: asset     data: {"taskId":"...","assets":[...]}            ← 出图，直接内联展示
event: message   data: {"role":"assistant","content":"好了"}
event: done      data: {"messageId":"..."}
```

Express 5 直接支持流式响应。前端不需要轮询——`progress` 事件由 `TaskRunner` 的新发射器转发（§9.2）。

---

## 15. 降级路径

保证大脑出问题时应用仍然可用。

| 故障 | 处理 |
|---|---|
| 大脑 401 / 超时 / 网络不可达 | 退化为**直通模式**：把用户原话当 prompt、用该类目默认渠道生成。⚠️ **落地时改成先弹一张确认卡片**（见下方说明），不是直接生成 |
| JSON 解析失败 | 带纠正提示重试 1 次；再失败转纯文本回复，不中断会话 |
| alias 解析不到 | 用该类目默认渠道，消息里标注"已默认使用 X" |
| 模型不支持视觉（§11.5） | 记进 `visionUnsupported`，该模型不再附图，提示一次 |
| 视频提交失败 / 内联素材超限 | 错误进 `tool_result`，大脑下一轮可自行换渠道或改参数重试 |
| 缩略图生成失败 | 静默跳过，这一轮走盲改 |

### 15.1 直通模式落地成了「先问一句」

计划里写的是大脑一挂就直接按原话生成。实现时发现这样有两个问题：

1. **这个工作区里的用户原话是给大脑看的，不是给生图模型看的。**
   「把这张的手改成咖啡杯」「刚才那张做成视频」这类句子当 prompt 送进生图接口，
   出来的是一张字面意思的图——既不是用户要的，也花了钱。
2. **§16 的全部精神是不让任何东西替用户决定花钱。** 静默生成等于把这条规矩破在
   最不该破的时候：用户既没有得到他要的结果，也没有机会喊停。

所以能力保留、决定权交回用户：大脑挂了以后，助手回一张确认卡片，上面就是用户的原话，
标注「大脑不可用」，按钮是「按这句话生成 / 算了」。点一下才真的提交。
数据结构和 §13 的确认卡片完全共用，只是多了一个 `reason: "brain_down"`。

另外两处配套改动：

- **只在「这一轮什么也没发生」时才退化。** 如果大脑已经跑了几轮、图也画出来了，
  那问题就不是「连不上」，再兜一次只会把上下文搅乱——这时候老老实实报错。
- **已经执行完的工具不会因为大脑挂了被说成失败。** 用户在卡片上点了确认、图顺利生成、
  之后大脑才断线，这时只补一句「生成已经提交并完成，但助手暂时接不上话」，
  而不是甩一个红色报错让用户重新生成一遍。
- 给用户看的失败原因不再复用上游的 `error.message`——那里面可能回显 Base URL 和请求片段，
  而这些会原样落进 SQLite。改成按状态码翻译的一句人话。

---

## 16. 护栏

| 项 | 值 | 说明 |
|---|---|---|
| `MAX_ROUNDS` | 6 | 单轮用户消息最多 6 次大脑调用 |
| `MAX_AUTO_CONTINUE` | 3 | 每会话自动续跑上限，防止"不满意就重做"循环烧钱 |
| 单会话任务数软上限 | 20 | 超过弹确认 |
| 工具执行 | **串行** | 同一会话同时只跑一个生成任务，保证画布不乱 |
| `MAX_VISION_IMAGES` | 1 | 只附画布主图，见 §11.6 |
| `MAX_CANVAS_IMAGES` | 8 | 画布整组上限，**等于** `MAX_REFERENCE_IMAGES`（同一笔预算） |
| `MAX_REFERENCE_IMAGES` | 8 | 参考图**总量**上限：画布整组优先，`extraReferences` 随后，多的丢掉并在卡片上写出来 |

**不放进工具集的操作**：批量生成、清空历史、改渠道配置。这些要么涉及大额花费，要么破坏性太强，不该让大脑自由决定。

---

## 17. 改动清单

### 新增

| 文件 | 职责 |
|---|---|
| `src/shared/agent-types.ts` | `AgentPlan` / `Conversation` / `ChatMessage` / `ToolResult` / `ConversationStatus` |
| `src/server/brain.ts` | `callBrain({ channel, model, messages, onToken, signal })`，SSE 增量解析 |
| `src/server/capabilities.ts` | 能力清单生成、alias 解析、类目默认渠道 |
| `src/server/agent-tools.ts` | `AGENT_TOOLS: Record<name, { schema: ZodType, execute(ctx, args) }>` |
| `src/server/agent.ts` | `runTurn()`、续跑、状态机、确认流程 |
| `src/server/vision.ts` | 缩略图生成与读取（§11） |
| `src/client/ChatView.tsx` | 对话工作区主视图 |
| `src/client/chat/MessageBubble.tsx` | 消息气泡 |
| `src/client/chat/ToolCard.tsx` | 工具调用卡片（可折叠显示实际参数） |
| `src/client/chat/ConfirmCard.tsx` | 视频确认卡片（§13.5） |
| `src/client/chat/AssetStrip.tsx` | 产物缩略图条 + 「设为当前」 |
| `src/client/chat/Composer.tsx` | 输入框 |

### 改动

| 文件 | 改动 |
|---|---|
| `src/server/tasks.ts` | 加最小发射器：`on("taskFinished"\|"taskProgress")`，在 `run()` 终态和轮询循环里 `emit`；产物落盘处顺手生成缩略图 |
| `src/server/db.ts` | 两张新表 + `assets.thumb_path` 补列 + CRUD |
| `src/server/app.ts` | `/api/conversations*` 路由（含 SSE）、`/api/conversations/:id/confirm`、`/api/assets/:id/thumb` |
| `src/shared/types.ts` | `AdapterType` 加 `"openai-chat"`；加 `isChatAdapter()` |
| `src/shared/provider-presets.ts` | 补 chat 单元预设 |
| `src/client/App.tsx` | 加第五个工作区 tab；确认 `openai-chat` 渠道不出现在生图/视频工作台的渠道选择器里 |
| `src/client/api.ts` | 会话相关接口 + SSE 客户端 |
| `src/client/styles.css` | 对话样式 |
| `package.json` | 加 `jimp`（若采用 §11.3 选项 A） |

### 完全不动

`src/server/adapters.ts`、`src/server/security.ts`、`src/server/key-store.ts`

---

## 18. 里程碑

| | 内容 | 产出 | 预估 |
|---|---|---|---|
| ~~**M0**~~ | ~~`openai-chat` 适配器 + 预设 + `brain.ts` 跑通~~ | ✅ **已完成**，实测结果见 §21 | 半天 |
| ~~**M1**~~ | ~~两张表 + `capabilities.ts` + `runTurn` 单轮 + 五个工具（`generate_image` / `edit_image` / `optimize_prompt` / `ask` / `reply`）+ `ChatView` 基础~~ | ✅ **已完成** | 1–2 天 |
| ~~**M2**~~ | ~~画布指针 + 徽章 + 流式 SSE + 工具卡片 + **看图改（§11）**~~ | ✅ **已完成** | 1–2 天 |
| ~~**M3**~~ | ~~`TaskRunner` 发射器 + `generate_video` + 续跑 + **视频确认卡片**~~ | ✅ **已完成** | 1–2 天 |
| ~~**M4**~~ | ~~六条降级路径 + 护栏 + 取消 / 中断 + 会话列表（重命名、删除）~~ | ✅ **已完成**（直通模式的实现见 §15.1） | 1 天 |

M1–M4 全部落地，`npm test` 90 条通过，`npm run build` 通过。落地过程中与本文的偏差集中在 §5.1 和 §15.1。

**M0 是最重要的一步。** 半天就能验证"大脑到底好不好用"。如果 chat 渠道调不通、或者模型输出 JSON 质量太差，整个方案要调整，此时改成本最低。

---

## 19. 测试计划

`tests/` 已有 vitest 基建，`npm test` 还在 release 脚本里。以下几块是纯函数，必须补单测：

| 目标 | 用例 |
|---|---|
| `parsePlan()` | 输出前后有多余文字、包了 markdown 代码块、字段缺失、`args` 类型错误、完全不是 JSON |
| `resolveAlias()` | 正常命中、alias 不存在时的默认回退、同类目多渠道时的选择 |
| `shouldConfirm()` | 真值表：3 种 policy × 2 种轮次来源 × 是否视频工具 |
| 画布更新 | 图片产出后整组换成新产物、`fromScratch` 不带参考图、参考图总量超 8 张时按「画布优先」丢 extra 并写出来、视频产出**不**改画布 |
| 画布迁移 | 老指针搬成单元素数组、跑第二遍幂等、清空后重启不复活 |
| `buildCapabilityManifest()` | 确认输出里**不含** baseUrl / 密钥 / channelId |

最后一行的断言很重要——它把"绝不泄露渠道信息给 LLM"这条约束变成了一个会失败的测试。

---

## 20. 待定问题

1. **`jimp` 还是客户端回传**（§11.3）。推荐 jimp，但要确认包体增量可接受。
2. **chat 单元的预设模型 ID 用什么**。需要按向量引擎 / 词元流墟实际在售的文本模型填。
3. **对话的标题**由谁生成：截断首条用户消息，还是让大脑起一个。截断不花钱，脑起名要额外一次调用。
4. ~~**大脑的温度**~~。已由实测结论取代，见 §21.4。
5. **对话与生图工作台的桥接**：对话产出的结果卡片上加一个"丢到生图工作台继续调参"按钮，把参数和参考图带过去。M4 之前可以不做。

---

## 21. M0 实测结果

M0 已用 `api.tiantoken.com` 的 `deepseek-v4-1-flash` 验证完毕，
探针脚本保留在 `scripts/probe-brain.ts`（`npx tsx scripts/probe-brain.ts`）。
以下结论是实测的，不是推测的，实现时以本节为准。

### 21.1 JSON 计划协议成立

四个用例全部通过，模型输出干净、无 markdown 包裹、alias 正确：

| 用例 | 结果 |
|---|---|
| 直接出图（指定 gemini + 16:9） | ✅ `generate_image`，`modelHint=gemini`、`size=16:9` 都正确 |
| 多步链式（生图→视频） | ✅ 第一轮正确选 `generate_image`，把视频留到拿到图之后 |
| 信息不足（"帮我做个视频"） | ✅ 选 `ask` 并列出需要补充的三项，没有瞎猜 |
| 纯聊天（"你能做什么"） | ✅ 选 `reply` |

**这意味着不需要原生 function calling 的兜底方案**，§7.1 的判断成立。

### 21.2 ⚠️ 这是推理模型

**实现时必须注意，否则会拿到空回复。**

响应里正文和推理是分开的两个字段：

- 非流式：`message.content` 与 `message.reasoning_content`
- 流式：`delta.content` 与 `delta.reasoning_content`

`max_tokens` 给小了，模型会把额度全花在推理上，返回**满额 `reasoning_tokens` + 空 `content` + `finish_reason: "length"`**。
实测给 50 时正文完全为空，给 3000 才正常。

已据此定下 `BRAIN_DEFAULT_MAX_TOKENS = 4096`，并在 `BrainResult` 里保留 `truncated` 标志供 Agent 层重试。

附带收益：`reasoning_content` 可以实时推给前端做"思考中"展示，比转圈圈有信息量得多。

### 21.3 ⚠️ 单次调用 2.5–6 秒

| 用例 | 延迟 | reasoning tokens |
|---|---|---|
| 直接出图 | 3.3s | 101 |
| 多步链式 | 6.1s | 457 |
| 信息不足反问 | 2.5s | 31 |
| 纯聊天 | 4.2s | 0 |

`MAX_ROUNDS = 6` 意味着最坏情况单轮用户消息要等 **20–35 秒**才出第一个气泡。
缓解手段（M1 就该做，不是 M4）：

- `event: token` 把推理过程实时推给前端，让用户看到"在动"
- 简单意图（纯 chat、单步出图）尽量一轮结束
- 换更快的模型时优先看这一项

### 21.4 `temperature` 默认不发送

推理模型对上采样参数的处理各不相同，有的直接报错。
`callBrain` 默认**不带** `temperature` 字段，只在调用方明确传入时才加上。
§20 里"大脑温度设 0.3"的设想作废——实测这个模型不需要靠调温度来稳定 JSON 格式。

### 21.5 ✅ 视觉可用

`deepseek-v4-1-flash` **能看图**。探针发了一张 64×64 纯红 PNG，模型正确回答"暗红色"，
推理里还给出了估计的色值。所以 §11 看图改可以默认开启。

§11.5 的自愈判定仍然保留——换个不支持视觉的模型时它是兜底，只是不再是默认路径。

### 21.6 站点兼容性

- `/v1/models` 可用 → `buildConnectionTestRequest()` 走 `openai-*` 分支拿到 `/v1/models`，连接测试直接通过（实测 690ms，HTTP 200）
- 流式正常，标准 `chat.completion.chunk`，以 `data: [DONE]` 收尾
- 但"站点忽略 `stream: true`"的兜底**仍要保留**：`callBrain` 已实现对非 `text/event-stream` 响应的降级解析，换中转站时用得上

### 21.7 M0 实际改动

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `AdapterType` 加 `"openai-chat"`；新增 `isChatAdapter()` 和 `isImageAdapter()` |
| `src/server/adapters.ts` | `defaultEndpoint()` 加 `openai-chat` 分支；`applyAuth()` 改为导出供 brain.ts 复用 |
| `src/shared/provider-presets.ts` | `adapterDefaultEndpoint()` 加分支；新增 `tiantoken-chat` 预设单元 |
| `src/server/app.ts` | `adapterTypes` 枚举加 `"openai-chat"` |
| `src/server/brain.ts` | **新增**，SSE 流式客户端 + 非流式降级 |
| `src/client/labels.ts` | 适配器中文名"对话模型（大脑）" |
| `src/client/App.tsx` | 生图工作台的渠道筛选改用 `isImageAdapter()`，**把对话渠道挡在生图/视频工作台之外** |
| `scripts/probe-brain.ts` | **新增**，M0 探针 |
| `tests/provider-presets.test.ts` | 补 chat 预设的断言 |

`isImageAdapter()` 这个改动正是 §4.4 预警的坑：原来 `imageChannels` 只判断"不是视频"，
对话渠道会被一并收进生图工作台的下拉里，用户选中后提交必然失败。现在已验证生图 / 视频工作台的下拉里都没有它。

### 21.8 环境

密钥放在项目根目录的 `.env`（已在 `.gitignore` 中，且 `loadEnvFiles()` 会把 `.env` 读进 `process.env`）：

```dotenv
TIANTOKEN_CHAT_API_KEY=sk-...
```

渠道填的环境变量名就是 `TIANTOKEN_CHAT_API_KEY`，`hasKey` 自动为真。**密钥不进代码、不进 SQLite、不进诊断记录**，沿用现有机制。
