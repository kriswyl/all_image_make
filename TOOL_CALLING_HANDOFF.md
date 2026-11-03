# 普通聊天接入通用工具（Agent）开发文档

> 目标读者：接着写代码的人（Codex）。
> 范围：**普通聊天模式**获得原生工具调用能力，第一批工具是文档生成 / 读取 / 转换。
> 创意助手（JSON 协议）不动；画布助手不动。

---

## 0. 一句话

普通聊天继续保持"纯文本流式"，额外挂一条 **OpenAI 原生 `tool_calls` 通道**；
模型想调工具就调，不想调就正常说话。工具层做成注册表，以后加"网页抓取 / 计算 / 检索"只是加一个模块。

---

## 1. 现状（读代码前先看这段）

| 事实 | 位置 |
|---|---|
| 普通聊天 = 单次调用、纯文本流式、无工具 | `src/server/agent.ts` 的 `turn()`，`plain` 分支 |
| 创意助手 = 让模型输出一段 JSON，服务端解析 | 同上，非 `plain` 分支 |
| 大脑调用没有 `tools` 参数 | `src/server/brain.ts` `buildRequestBody()` |
| SSE 只解析 `delta.content` / `delta.reasoning` | `src/server/brain.ts` `consumeSse()` |
| 已有 XMind → PPTX（只能一个方向） | `src/server/mind-document.ts` |
| 已有 `document_read` / `document_make_pptx` 工具 | `src/server/agent-tools.ts` 约 1290–1330 行 |
| **临时方案**：普通聊天里一旦有 XMind 且话里提到 pptx，就强制切回创意助手 | `src/server/agent.ts` 约 391–393 行 `wantsDocumentAction` |
| 文档存在库里（`conversation_documents` / `conversation_document_outputs`，都是 BLOB） | `src/server/db.ts` 约 855–900 行 |

**这次要做的，本质是替换掉 `wantsDocumentAction` 这个临时开关**：不再靠关键词把整轮切回 JSON 协议，
而是让普通聊天自己就能调工具。

### 已实测：渠道支持原生工具调用

对 `deepseek-v4-1-flash`（`https://api.tiantoken.com`）发带 `tools` 的流式请求，返回标准增量：

```
HTTP 200 | chunks with tool_calls: 11
{"function":{"arguments":"","name":"calc"},"id":"call_00_jkCPc4TwQ4j1m5q9Nan13031","index":0,"type":"function"}
{"function":{"arguments":"{\""},"index":0}
{"function":{"arguments":"17"},"index":0}
...
finish_reason: "tool_calls"
```

注意两点，实现时必须按这个来：

1. **该站强制 SSE**：即使传 `stream:false` 也回 `data:` 分片，所以流式解析是唯一路径。
2. **`name` 只在第一片出现**，`arguments` 是逐片拼接的 JSON 串。

---

## 2. 目标 / 非目标

**目标**

- 普通聊天可以调用工具，正文仍然是正常 markdown 流式输出。
- 工具层可扩展：新增能力 = 新增一个工具模块 + 注册。
- 第一批工具覆盖：文本类文档（md/txt/csv/json）、思维导图（xmind）、演示文稿（pptx 导出）。
- 文件落在本地工作目录，可以「在文件夹中显示 / 用外部程序打开 / 下载」。

**非目标（这一期不做）**

- 不改创意助手的 JSON 协议。
- 不做 Word/Excel（P2），不做富排版 PDF（P3+）。
- 不做联网搜索、代码执行。
- 不做多工具并行调用（v1 顺序执行，见 §13）。

---

## 3. 总体架构

```
用户消息
   │
   ▼
┌─────────────────────────────┐
│ agent.turn()                │
│  chatMode === "chat"        │
│  → runChatTurn()（新）       │
└──────────────┬──────────────┘
               │ 循环（≤ MAX_TOOL_ROUNDS）
               ▼
        brain.callBrainRaw(tools=...)
               │
    ┌──────────┴───────────┐
    │ 有 tool_calls？       │
    └──────────┬───────────┘
       否 │            │ 是
          ▼            ▼
   落库 + 结束   执行工具（注册表）
                  │ 写文件 / 读文件 / 转换
                  ▼
            结果作为 role:"tool" 消息
                  │
                  └──► 下一轮
```

三层，互不耦合：

1. **协议层**（`brain.ts`）：把 `tools` 发出去，把 `tool_calls` 收回来。
2. **运行时**（`chat-agent.ts`）：循环、落库、SSE 广播、超限与中断。
3. **工具层**（`chat-tools/*`）：每个工具一份 schema + 一个 `run()`。

---

## 4. 协议层改动：`src/server/brain.ts`

### 4.1 类型

```ts
export interface BrainToolCall {
  id: string;
  name: string;
  /** 模型给的原始 JSON 字符串，别在这里解析——留到工具层校验 */
  arguments: string;
}

export interface BrainToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export type BrainMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | BrainContentPart[] }
  | {
      role: "assistant";
      /** 只调工具、不说话时这里是空串或 null */
      content: string | BrainContentPart[] | null;
      tool_calls?: BrainToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };
```

> 注意：现在 `BrainMessage` 是双字段接口，改成上面这个联合类型后，
> 所有构造消息的地方（`agent-brain.ts`、`agent-context.ts`、`tools` 里的 `messages`）
> 都需要跟着改；TS 会全部指出来，不要用 `as any` 绕过。

### 4.2 请求体

```ts
function buildRequestBody(options: CallBrainOptions) {
  return {
    model: options.model,
    messages: options.messages,
    stream: true,
    max_tokens: options.maxTokens ?? BRAIN_DEFAULT_MAX_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.tools?.length
      ? { tools: options.tools, tool_choice: options.toolChoice ?? "auto" }
      : {}),
  };
}
```

`CallBrainOptions` 增加：

```ts
tools?: BrainToolSpec[];
toolChoice?: "auto" | "none";
```

### 4.3 解析 `tool_calls`

在 SSE 循环里维护一个 `Map<number, { id: string; name: string; arguments: string }>`：

```ts
for (const call of delta.tool_calls ?? []) {
  const index = typeof call.index === "number" ? call.index : 0;
  const entry = calls.get(index) ?? { id: "", name: "", arguments: "" };
  if (call.id) entry.id = call.id;
  const namePart = call.function?.name ?? "";
  // 有的站整串只给一次，有的站分片给；两种都要能拼对
  if (namePart && namePart !== entry.name) entry.name = entry.name ? `${entry.name}${namePart}` : namePart;
  if (call.function?.arguments) entry.arguments += call.function.arguments;
  calls.set(index, entry);
}
```

- `finish_reason === "tool_calls"` 时即使 `content` 为空也不算异常。
- **非流式兜底分支**（站点忽略 `stream:true`、直接回 JSON）也要读 `message.tool_calls`，
  别忘了这条路径（`usedFallback` 那个分支）。

`BrainResult` 增加：

```ts
toolCalls: BrainToolCall[];
```

### 4.4 单测（必须）

- `name` 一次给全 → 只出现一次，不重复。
- `name` 分两片给 → 拼成完整名字。
- `arguments` 分多片 → 拼成合法 JSON。
- 同时返回 content + tool_calls（有的模型会先说话再调工具）。
- 站点忽略 `stream:true` 时，JSON 分支也能拿到 tool_calls。

---

## 5. 运行时：`src/server/chat-agent.ts`（新增）

### 5.1 入口

`agent.ts` 里 `plain` 分支替换成：

```ts
if (plain) {
  await runChatTurn({ host: this, conversation: turnConversation, turnAttachmentIds, controller, userMessage });
  return;
}
```

`runChatTurn` 负责整个循环；`agent.ts` 只保留"决定走哪条路"。

**顺手删掉 `wantsDocumentAction`**（约 391–393 行）——新机制取代它。

### 5.2 循环

```ts
const MAX_TOOL_ROUNDS = 5;

export async function runChatTurn(input) {
  const tools = toolsForConversation(input.conversation, input.host.db);
  let messages = await buildMessages(input);       // 复用 agent-brain 的上下文拼装
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds += 1;
    const result = await brainCall({ messages, tools: rounds === 1 ? tools : tools, signal });

    if (!result.toolCalls.length) {
      persistAssistantText(result.content);        // 落库 + 广播 message
      return finish();
    }

    // 1) 先把这一轮的话说完（可能是空串）
    // 2) 落库一条带 tool_calls 的 assistant 消息
    const assistantRow = persistAssistantToolCalls(result.content, result.toolCalls);

    // 3) 顺序执行（v1 不并行，见 §13）
    for (const call of result.toolCalls) {
      const outcome = await executeChatTool(call, ctx);
      persistToolMessage(assistantRow, call, outcome);
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
    }
    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
  }

  // 轮次用尽：不再给工具，让模型用正文收尾
  const final = await brainCall({ messages, tools: [], signal });
  persistAssistantText(final.content);
  note("工具调用达到上限，已停止继续调用");
}
```

**细节**

- 每轮都重新拼 `messages` 也可以，但**必须包含完整的 tool 往返**，否则模型会重复调用同一个工具。
- 中断（`controller.signal.aborted`）要立刻退出，保留已产生的内容。
- 历史裁剪：只保留最近 N 轮 tool 往返（建议 10），更早的折叠成一句摘要，避免上下文爆炸（§13）。

### 5.3 SSE 事件（新增）

```ts
| { type: "tool_state"; toolCallId: string; name: string; phase: "running" | "done" | "failed"; title: string; summary?: string }
| { type: "tool_file"; toolCallId: string; fileId: string; fileName: string; byteSize: number }
```

- `tool_state`：让气泡上出现「正在生成文件…」这一行，`done` 时撤掉。
- `tool_file`：让前端立刻亮出文件卡（不用等消息落库）。
- 落库仍然走现有的 `message` 事件（`role:"tool"` 的行），渲染复用 `ToolCard`。

---

## 6. 工具注册表：`src/server/chat-tools/`

```
chat-tools/
  index.ts      // 注册表：name -> ChatTool，按会话决定可用集合
  types.ts      // ChatTool / ChatToolContext / ToolOutcome
  documents/    // 文档类工具（P1/P2）
    index.ts
    create.ts
    read.ts
    list.ts
    convert.ts
```

```ts
export interface ChatTool {
  name: string;
  /** 给模型看的说明，决定它什么时候会用；写清楚"什么时候不要用" */
  description: string;
  parameters: Record<string, unknown>;
  /** 需要用户确认才执行（覆盖、删除这类） */
  needsConfirm?: (args: unknown) => boolean;
  run(ctx: ChatToolContext, args: unknown): Promise<ChatToolResult>;
}

export interface ChatToolContext {
  db: AppDatabase;
  conversation: Conversation;
  workspace: DocumentWorkspace;
  signal: AbortSignal;
  emit(event: AgentStreamEvent): void;
}

export interface ChatToolResult {
  ok: boolean;
  /** 回灌给模型的一句话（它靠这句决定下一步） */
  summary: string;
  /** 可选：给前端的事件数据 */
  data?: { fileId?: string; fileName?: string; byteSize?: number };
}
```

**可用集合按会话决定**（为以后"某会话关掉某类工具"留口子）：

```ts
export function toolsForConversation(conversation: Conversation, db: AppDatabase): BrainToolSpec[]
```

### 参数校验

用 `zod`（项目已有）。模型给的是字符串，**必须先 `JSON.parse` 再 zod 校验**，
失败时不要把异常抛给循环，而是返回 `{ ok:false, summary:"参数不合法：…" }` 让模型自己改。

---

## 7. 文档能力（P1）

### 7.1 工具清单

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `doc_create` | 生成一个新文件 | `kind`, `name`, `content` 或 `nodes` |
| `doc_read` | 读回内容给模型 | `fileId` 或 `name`, `offset?`, `limit?` |
| `doc_list` | 列本会话文件 | 无 |
| `doc_convert` | 读一个写一个 | `fileId` / `name`, `to` |
| `doc_delete` | 删除文件（需确认） | `fileId` |

`kind` 取值（P1）：`md` | `txt` | `csv` | `json` | `xmind`；`pptx` 走 `doc_convert`（xmind → pptx，复用现有渲染）。

### 7.2 各格式的处理

**md / txt / csv / json**：直接写字节，UTF-8。csv 记得加 BOM（`﻿`），否则 Excel 打开中文乱码。

**xmind（生成）**：无需新依赖，用已有的 `jszip` 拼一个最小合法包：

```
content.json       // [{ id, class:"sheet", title, rootTopic:{ id, class:"topic", title, children:{ attached:[...] } } }]
metadata.json      // { "creator": { "name": "ChatCanvas" } }
manifest.json      // { "file-entries": { "content.json": {}, "metadata.json": {} } }
```

- 节点树直接复用 `DocumentNode`（`mind-document.ts` 里已有这个类型）。
- 生成后用 `parseXmind()` **读回来自检**，读不出来就当失败——这比祈祷格式正确靠谱。

**pptx（P1 的转换目标）**：直接调 `planMindSlides()` + `renderMindPptx()`，不要重写。

**docx / xlsx（P2）**：新增 `docx`、`xlsx`（SheetJS）依赖；策略见 §11。

### 7.3 `doc_read` 的返回策略

模型上下文有限，读文档必须分页：

- 文本类：按行返回，`offset`/`limit` 默认 200 行，单次最多返回 20,000 字符。
- xmind：按主题层级返回，深度可截断，单次最多 800 个节点。
- 超出时在 `summary` 里明确告诉模型「还有 N 行没读，用 offset 继续」。

---

## 8. 存储（方案 A）

### 8.1 目录

```
<dataDir>/documents/<conversationId>/
  2026-11-03T10-22-01-关于X的大纲.md
  2026-11-03T10-23-40-产品结构.xmind
```

- `dataDir` 用 `AppDatabase.dataDir`（已有只读字段）。
- 文件名：`时间戳-安全名.扩展名`；**保留中文**，只替换 `\ / : * ? " < > |` 和控制字符，最长 80 字。
- 同名冲突：加 `-2`、`-3` 后缀，不覆盖。

### 8.2 限额

| 项 | 上限 |
|---|---|
| 单文件 | 20 MB |
| 单会话文件数 | 200 |
| 单会话总大小 | 200 MB |

超限返回 `{ ok:false, summary:"…" }`，不要抛异常。

### 8.3 生命周期

- 会话删除时递归删除该目录（`db.deleteConversation` 里加一步；注意先删文件再删记录）。
- 不做自动清理（用户随时可能回来找文件）。
- 数据库**不再存文件字节**：新的文档输出只记路径/文件名；旧的 `conversation_document_outputs` 保留读取能力，不再写入。

### 8.4 路径沙箱（必须）

```ts
resolve(relative: string) {
  const full = path.resolve(this.dir, relative);
  if (full !== this.dir && !full.startsWith(this.dir + path.sep)) {
    throw new AppError("DOCUMENT_PATH_ESCAPE", "文件路径越界", 400);
  }
  return full;
}
```

模型永远只能拿到 `fileId`（uuid）或相对文件名，拿不到绝对路径。

---

## 9. 接口与 SSE 契约

| 接口 | 用途 |
|---|---|
| `GET /api/conversations/:id/documents/files` | 列本会话文件（id、名字、大小、时间） |
| `GET /api/conversations/:id/documents/files/:fileId` | 下载 / 预览（`Content-Disposition: inline`） |
| `POST /api/conversations/:id/documents/files/:fileId/reveal` | 桌面端「在文件夹中显示」 |
| `DELETE /api/conversations/:id/documents/files/:fileId` | 删除（前端确认） |

- 路径全部用 `chatThreadOnly` 中间件（和 `mind-documents` 一致）。
- 「在文件夹中显示」：桌面端用 `plugin-shell` 打开所在目录；网页端退化成下载。

### SSE 事件汇总（新增两个）

```ts
{ type: "tool_state", toolCallId, name, phase, title, summary? }
{ type: "tool_file", toolCallId, fileId, fileName, byteSize }
```

---

## 10. 界面

1. **气泡里的工具运行时提示**：普通聊天消息流中插入一行 `⟳ 正在生成「大纲.md」…`，完成后变成文件卡。
2. **文件卡**（复用 `ToolCard` 的样式）：
   - 图标按扩展名（md/txt/csv/json/xmind/pptx）
   - 文件名 + 大小
   - 按钮：打开（预览或下载）/ 在文件夹中显示 / 删除
3. **模式提示**：普通聊天顶部已有的模式 chip 不变；工具调用不改变模式。
4. **失败态**：工具失败时卡片显示一行原因，不弹全局错误。

---

## 11. Word / Excel（P2 概要）

- **docx**：用 `docx` 库从结构化内容生成（标题/段落/列表/表格）；读取用 JSZip + `fast-xml-parser` 解析 `word/document.xml`，只取段落与表格文本（样式忽略）。
- **xlsx**：用 SheetJS（`xlsx`）读写，支持单元格级修改。
- **修改已有文档的策略**：统一「读 → 改结构 → 重新生成」，**不要原地改二进制**。生成的文件名加 `-修订` 后缀，避免覆盖原件。
- 保真度提示：转换前在 `summary` 里说明「会丢失版式/动画」。

---

## 12. 安全与降级

**安全**

- 路径沙箱（§8.4）。
- 覆盖 / 删除走确认卡（`needsConfirm`），确认卡复用现有 UI。
- 上传的 docx/xmind 只解析，不执行宏、不解析外链。
- 单文件 / 单会话限额（§8.2）。
- 工具只能写 `<dataDir>/documents/<conversationId>/`，不碰素材目录。

**降级**

- 渠道返回 400 且错误含 `tools`/`tool` 字样 → 记 `conversations.tools_unsupported = 1`，本轮重试一次不带 tools，之后该会话不再发工具。
- 工具执行抛异常 → 转成 `{ ok:false }` 回灌，连续 3 次失败就让模型直接回答，不再重试。
- 轮次用尽 → 不再给工具，让模型收尾（见 §5.2）。

---

## 13. 风险与取舍

| 风险 | 处理 |
|---|---|
| 工具 schema 占 token（每轮都发） | 工具数控制在 8 个以内；描述简短；P2 再考虑按需加载 |
| 模型乱调工具 / 循环调用 | 描述里写清"什么时候不要用"；同工具同参数 2 次内重复 → 直接返回上次结果 |
| 并行调用 | v1 顺序执行。模型一次返回多个 tool_call 时按顺序跑，结果一起回灌 |
| 历史膨胀 | 只保留最近 10 轮 tool 往返，更早的折叠成"之前用工具生成过 X" |
| 长文档读爆上下文 | `doc_read` 分页 + 明确告知剩余量 |
| 与创意助手的协议分叉 | 分开维护，互不引用；共用 `brain` 与 `ToolCard` 渲染 |

---

## 14. 分期与验收

### P0 基础设施（约 1 天）

交付：`brain` 支持 tools、`runChatTurn` 循环、注册表、SSE 事件、前端运行时提示。
验收：注册一个 `echo` 工具，普通聊天里说「调用 echo 说你好」能调用并回灌，正文正常流式。

### P1 文本与导图（1–2 天）

交付：`DocumentWorkspace`、`doc_create/read/list/convert/delete`，支持 md/txt/csv/json/xmind，xmind→pptx。
验收：

1. 「写一篇关于 X 的 md 大纲」→ 文件落在会话目录，卡片可打开。
2. 「把它转成思维导图」→ 生成合法 xmind（`parseXmind` 能读回）。
3. 「导出成 PPT」→ 复用现有渲染，页数与导图节点匹配。
4. 会话删除后目录被清空。

### P2 Word / Excel（2–3 天）

交付：docx/xlsx 读写、结构化编辑、大文档分页。
验收：生成 docx 能被 Word 打开；xlsx 能被 Excel 打开且中文不乱码；改一页不影响其它页。

### P3 其它通用能力

按需求加：网页抓取（带白名单）、计算、文件检索……
每个都是一个 `chat-tools/<name>` 模块 + 一行注册。

---

## 15. 测试计划

| 层 | 用例 |
|---|---|
| brain | tool_calls 分片解析（name 整串/分片）、content+tool_calls 并存、非流式兜底、usage 记录 |
| runtime | 一轮工具 → 第二轮回答；工具失败回灌；轮次用尽收尾；中断时保留已生成内容 |
| workspace | 路径越界被拒；中文文件名保留；重名加后缀；限额 |
| 文档工具 | md/csv 写入编码（BOM）；xmind 生成后能读回；doc_read 分页余量提示 |
| 接口 | 列表/下载/删除的权限与会话隔离 |
| 手工 | 用真实渠道跑一遍「写大纲 → 转导图 → 导 PPT」 |

---

## 16. 附录

### 16.1 关键代码位置

| 内容 | 文件 |
|---|---|
| 普通聊天分支 | `src/server/agent.ts` `turn()` 约 393 行 |
| 大脑请求与 SSE | `src/server/brain.ts` |
| 大脑上下文拼装 | `src/server/agent-brain.ts` `buildBrainMessages()` |
| 历史 → 消息 | `src/server/agent-context.ts` `toBrainMessage()` |
| XMind 解析 / PPTX 渲染 | `src/server/mind-document.ts` |
| 工具卡渲染 | `src/client/chat/ToolCard.tsx` |
| 消息气泡 | `src/client/chat/MessageBubble.tsx` |
| 会话表结构 | `src/server/db-schema.ts` `conversations` |

### 16.2 数据库迁移

```sql
ALTER TABLE messages ADD COLUMN tool_call_id TEXT;      -- role:"tool" 的消息归属哪次调用
ALTER TABLE messages ADD COLUMN tool_calls_json TEXT;   -- assistant 那一轮的 tool_calls 原文
ALTER TABLE conversations ADD COLUMN tools_unsupported INTEGER NOT NULL DEFAULT 0;
```

迁移方式沿用 `db-schema.ts` 里现有的 `PRAGMA table_info` + `ALTER TABLE` 写法。

### 16.3 依赖

| 用途 | 包 | 状态 |
|---|---|---|
| zip / xmind | `jszip` | 已有 |
| pptx | `pptxgenjs` | 已有 |
| XML 解析 | `fast-xml-parser` | 已有 |
| schema 校验 | `zod` | 已有 |
| docx（P2） | `docx` | 新增 |
| xlsx（P2） | `xlsx` | 新增 |

### 16.4 实测记录（渠道支持工具调用）

对 `https://api.tiantoken.com` + `deepseek-v4-1-flash` 发送带 `tools` 的请求：

- HTTP 200，返回 SSE（该站忽略 `stream:false`）
- `delta.tool_calls` 分片到达，`name` 只在首片，`arguments` 逐片拼接
- `finish_reason` 为 `tool_calls`

结论：可以按 OpenAI 标准实现，不需要私有协议。
