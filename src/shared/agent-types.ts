/**
 * 对话式 Agent 的类型定义（AGENT_PLAN.md §5、§8、§14）。
 *
 * 这里的类型被服务端和前端共用：服务端用它做 DB 映射，前端用它渲染消息流。
 * 服务端内部还有一层 `agent-tools.ts` 的 zod schema，那是「校验大脑输入」用的，
 * 和这里是两件事——这里只管「已经落库的东西长什么样」。
 */
import type { Asset } from "./types.js";
import type { BoardDelta } from "./board.js";

export type ConversationStatus =
  | "idle"
  | "running"
  /** 已提交异步任务（视频），等 TaskRunner 的完成事件 */
  | "waiting_task"
  /** 卡在视频确认卡片上，等用户点确认（§13） */
  | "awaiting_confirmation";

/**
 * 会话类型。
 *
 * - `chat`：对话创作，出现在侧栏；
 * - `board`：某个无限画布的 Agent 线程，不出现在侧栏，只从无限画布进入。
 *
 * 两者复用 messages / SSE / 大脑引擎，但上下文和工具不同。
 */
export const CONVERSATION_KINDS = ["chat", "board"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/** §13.2 视频确认策略 */
export const VIDEO_CONFIRM_POLICIES = ["always", "auto_only", "never"] as const;
export type VideoConfirmPolicy = (typeof VIDEO_CONFIRM_POLICIES)[number];

export const videoConfirmPolicyLabels: Record<VideoConfirmPolicy, string> = {
  always: "每次都问",
  auto_only: "自动续跑时才问",
  never: "直接生成",
};

/** 消息角色。tool 既承载工具调用也承载结果，两者都存这一行，回放时展开成两条 */
export const MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export type MessageStatus = "ok" | "pending" | "error";

/** §8 工具清单。这一份是「大脑能调什么」的唯一真相，提示词和解析共用它 */
export const AGENT_TOOL_NAMES = [
  "generate_image",
  "edit_image",
  "view_images",
  "set_canvas",
  "optimize_prompt",
  "generate_video",
  "generate_music",
  "generate_speech",
  "create_storyboard_template",
  "create_canvas_template",
  "board_read",
  "board_apply",
  "board_generate",
  "board_generate_batch",
  "board_check",
  "board_storyboard",
  "board_storyboard_update",
  "board_assets",
  "board_versions",
  "board_view_images",
  "board_extract_frame",
  "ask",
  "reply",
] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** 产出图片的工具：成功后自动把画布指针挪到新产物上（§10.1 规则 1） */
export const IMAGE_PRODUCING_TOOLS: AgentToolName[] = ["generate_image", "edit_image"];
/** 会花钱、会占任务额度的工具：会话任务软上限（§16）和确认流程都看这一份 */
export const GENERATION_TOOLS: AgentToolName[] = ["generate_image", "edit_image", "generate_video", "generate_music", "generate_speech"];

export const agentToolLabels: Record<AgentToolName, string> = {
  generate_image: "生成图片",
  edit_image: "修改图片",
  view_images: "查看图片",
  set_canvas: "切换画布",
  optimize_prompt: "优化提示词",
  generate_video: "生成视频",
  generate_music: "生成音乐",
  generate_speech: "生成配音",
  create_storyboard_template: "拆分镜模板",
  create_canvas_template: "生成画布模板",
  board_read: "读无限画布",
  board_apply: "修改无限画布",
  board_generate: "无限画布生成",
  board_generate_batch: "批量生成画布节点",
  board_check: "检查生成条件",
  board_storyboard: "查看关联分镜",
  board_storyboard_update: "修改分镜项目",
  board_assets: "搜索公共素材",
  board_versions: "查看节点版本",
  board_view_images: "查看画布图片",
  board_extract_frame: "提取视频尾帧",
  ask: "提问",
  reply: "回复",
};

/** 脚本文档引用：消息气泡上显示成一个文件条，不把全文塞进聊天记录 */
export interface ChatDocumentRef {
  id: string;
  name: string;
  charCount: number;
}

/** 一次并行调用里的一个调用（需求.md 问题 2） */
export interface PlannedCall {
  tool: AgentToolName;
  args: Record<string, unknown>;
}

/**
 * 一次最多并行几个产图调用（需求.md 问题 2 拍板的硬上限）。
 *
 * 定 8 是因为它同时是「用户一次最多想要几张」的经验值、和参考图上限
 * （`MAX_REFERENCE_IMAGES`）对齐，且 8 路并发不至于让中转站当成攻击。
 */
export const MAX_BATCH_CALLS = 8;

/**
 * 新建会话时的占位名，同时是**自动命名的判据**：
 * 标题还等于它，说明用户没改过名，可以用第一条指令的前几个字顶替。
 */
export const DEFAULT_CONVERSATION_TITLE = "新对话";

/** 自动取前几个字。20 个字在侧栏里正好一行放得下，再多就要截断显示 */
export const AUTO_TITLE_MAX_CHARS = 20;

/** 大脑必须输出的那一个 JSON 对象（§7 输出格式） */
export interface AgentPlan {
  tool: AgentToolName;
  args: Record<string, unknown>;
  /** 给用户看的一句话，附在工具卡片上 */
  say?: string;
  /**
   * 需要一次出多张图时，大脑改输出 `{"calls":[{tool,args},…], "say":"…"}`，
   * 归一化后**第一个调用同时写在 `tool` / `args` 上**（见 `planCalls`）。
   *
   * 这么设计是为了向后兼容：单调用的老计划里没有这个字段，落库的 `plan_json`、
   * `rows.ts` 的折叠规则、`ToolCard` 的单卡片渲染全都不用改；
   * 只有多调用时才多出这个字段，而多调用本来就只能走新的那两条路径。
   */
  calls?: PlannedCall[];
  /**
   * 这一批图要**保持一致性**时由大脑写上。
   *
   * - `character`：同一人物（脸、发型、服装保持一样）
   * - `style`：同一画风（人物可以不同）
   *
   * 执行器不会把它们同时发出去，而是**先生成第 1 张当基准**，再以它为参考图
   * 并行生成其余几张——并行的文字描述再像，也保证不了同一张脸。
   * 第 1 张本身也是用户要的结果之一，所以张数不变、费用不变。
   */
  consistency?: "character" | "style";
}

/**
 * 计划里的全部调用。
 *
 * 单调用（绝大多数）返回长度 1 的数组，`calls` 字段不存在——所以调用方
 * 只要把它当成「一次可能多个」来写，就自然同时兼容老记录和新批量。
 */
export function planCalls(plan: AgentPlan | null | undefined): PlannedCall[] {
  if (!plan) return [];
  if (plan.calls?.length) return plan.calls;
  if (!plan.tool) return [];
  return [{ tool: plan.tool, args: plan.args ?? {} }];
}

/** §8 各工具的参数。写成 interface 是为了让 execute 的实现有类型可依 */
export interface GenerateImageArgs {
  prompt: string;
  modelHint?: string;
  size?: string;
  aspectRatio?: string;
  /**
   * gemini 系站点的输出尺寸（1K / 2K / 4K，大小写敏感）。
   * 和 `size` 并存是因为两者的适用面不同：OpenAI 系认 `size`，gemini 系只认这个。
   * 没给值时服务端会按渠道补默认值（见 TaskRunner.resolveImageSize）。
   */
  imageSize?: string;
  count?: number;
  /** true 表示不带参考图，纯粹重画 */
  fromScratch?: boolean;
  /**
   * 这次要用的参考图（画布/会话里的产物引用）。
   *
   * 不给时按「本条消息附带的图 → 画布只有一张就用它」兜底；
   * 画布多于一张又没指定时会直接失败，让大脑先 `view_images` 或 `ask`，
   * 而不是再默默把主图/整组画布塞进去。
   */
  imageRefs?: string[];
}

export interface EditImageArgs {
  prompt: string;
  modelHint?: string;
  /**
   * 要改的那几张图（`#abcd` 形式的产物引用，按顺序）。
   *
   * **只改这里指定的图**；不填时用本条消息附带的图，再退到「画布只有一张」。
   * 画布多于一张又没指定时会失败并提示先 `view_images` / `ask`。
   */
  imageRefs?: string[];
  /** 额外的参考图，用 #abcd 形式的产物引用；上限 8，和 MAX_REFERENCE_IMAGES 对齐 */
  extraReferences?: string[];
  /** 改图同样能指定输出尺寸与宽高比——改完的画面未必沿用原图的形状 */
  aspectRatio?: string;
  imageSize?: string;
}

/** 看画布/会话里图片的缩略图。不生成、不花钱，由 Agent 主循环直接处理 */
export interface ViewImagesArgs {
  /** 看哪几张；不填 = 整组当前画布 */
  assetRefs?: string[];
}

export interface SetCanvasArgs {
  /** 产物引用：#a3f1 / a3f1 / "last" / 资产 id。一次设一张时用它 */
  assetRef?: string;
  /**
   * 一次设一组的写法（按给到的顺序，`[0]` 成为主图），最多 `MAX_CANVAS_IMAGES` 张。
   *
   * 语义是**整组替换**画布，不是"加进去"：想留原来的就得把它们一起写进来。
   */
  assetRefs?: string[];
}

export interface OptimizePromptArgs {
  prompt: string;
  target: "image" | "video";
}

export interface GenerateVideoArgs {
  prompt: string;
  modelHint?: string;
  mode?: string;
  duration?: number;
  resolution?: string;
  audio?: boolean;
  promptExtend?: boolean;
  /**
   * 这次进视频的图（`#abcd` 形式，按顺序）：
   * first-frame 只要 1 张；first-last-frame 正好 2 张（首帧、尾帧）；
   * reference 1~N 张。不填时用本条消息附带的图，再退到「画布只有一张」。
   */
  imageRefs?: string[];
  /**
   * 老参数：`none` = 纯文生视频；`current` = 用当前画布。
   * 新计划应当直接用 `imageRefs` 说清用哪张，别把「当前画布」当成默认目标。
   */
  imageFrom?: "current" | "none";
}

export interface GenerateMusicArgs {
  /** 灵感模式是描述；自定义模式是歌词；翻唱/混音/音效等模式按各自语义 */
  prompt?: string;
  mode?: "inspiration" | "custom" | "cover" | "mashup" | "sound" | "playlist" | "sample";
  /** 歌名，最多 80 字 */
  title?: string;
  /** 曲风 / 音效标签 */
  tags?: string;
  /** 要排除的曲风 */
  negativeTags?: string;
  /** 纯音乐（无人声） */
  instrumental?: boolean;
  /** 翻唱 1 首、混音 2 首的产物引用（#abcd） */
  sourceAssetRefs?: string[];
  /** 音效模式的 BPM / 调性 / 是否循环 */
  tempo?: number;
  key?: string;
  loop?: boolean;
  modelHint?: string;
  /** Suno 模型版本，例如 chirp-v3-5 */
  version?: string;
}

export interface GenerateSpeechArgs {
  /** 要朗读的正文；双人对话用 A：/ B： 标注说话人 */
  text: string;
  /** 预置音色名，例如 Kore / Puck；不填默认 Kore */
  voice?: string;
  /** 风格标注，例如「轻声耳语，放慢语速」 */
  style?: string;
  /** BCP-47 语种，例如 zh-CN / en-US；不填自动判断 */
  language?: string;
  /** 双人对话的第二个音色；给了就把正文按 A：/ B： 分给两个人 */
  secondVoice?: string;
  modelHint?: string;
}

export interface AskArgs {
  question: string;
  options?: string[];
}

export interface ReplyArgs {
  text: string;
}

export interface ToolResult {
  ok: boolean;
  /** 回灌给大脑的一句话结果。大脑据此决定下一步，措辞要能直接看懂 */
  summary: string;
  taskId?: string;
  assetId?: string;
  /** 一次产出多个产物时用（音乐通常 2 首）；`assetId` 仍指向第一个，兼容旧卡片 */
  assetIds?: string[];
  /**
   * 产物的 MIME。卡片靠它决定缩略图怎么渲染（图片 `<img>` / 视频 `<video>`）——
   * 只给 assetId 的话前端还得反过来查一次素材表，而对话卡片并不持有那份数据。
   */
  mimeType?: string;
  /** 异步任务（视频）已提交，Agent 这一轮到此为止，等完成事件再续跑（§12.2） */
  async?: boolean;
  error?: string;
  /** 给前端卡片渲染用的补充字段，不进大脑上下文 */
  data?: Record<string, unknown>;
}

/**
 * 参数核对的一条结论（需求.md 问题 1）。
 *
 * 类型放在 shared 而不是 diagnose.ts，是因为它要同时被服务端（产出）和
 * 前端卡片（渲染）用到，而前端不该反过来 import 服务端模块。
 */
export type ParamStatus = "applied" | "defaulted" | "dropped";

export interface ParamNote {
  /** 给用户看的参数名 */
  label: string;
  /** 真正出网的值；dropped 时是请求时写的那个值 */
  value: string;
  status: ParamStatus;
  /** dropped 的原因，一句话 */
  hint?: string;
}

/** 从 `ToolResult.data` 里安全取出参数核对结果：data 是无约束的 Record */
export function readParamNotes(data: Record<string, unknown> | undefined): ParamNote[] {
  const raw = data?.parameterNotes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const note = item as Record<string, unknown>;
    const status = note.status;
    if (typeof note.label !== "string" || typeof note.value !== "string") return [];
    if (status !== "applied" && status !== "defaulted" && status !== "dropped") return [];
    return [{
      label: note.label,
      value: note.value,
      status,
      ...(typeof note.hint === "string" ? { hint: note.hint } : {}),
    }];
  });
}

/**
 * 从 `ToolResult.data` 里安全取出「这次把画布设成了哪几张」。
 *
 * 和 `readParamNotes` 同一个套路：`data` 是无约束的 Record，老记录里根本没有这个键。
 * `set_canvas` 一次设了多张时，卡片要能把它们列出来——`ToolResult.assetId` 只装得下主图一张，
 * 而那个字段是**喂给大脑看的契约**，不能为了前端显示去把它撑成数组。
 */
export function readCanvasAssetIds(data: Record<string, unknown> | undefined): string[] {
  const raw = data?.canvasAssetIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string");
}

/** 视频里一张图扮演的角色。和万相 `VideoMediaType` / Seedance `role` 对齐 */
export type ConversationVideoRole = "first_frame" | "last_frame" | "reference_image";

/** 确认卡上要展示的「哪几张图、各自什么角色」 */
export interface ConfirmVideoInput {
  assetId: string;
  role: ConversationVideoRole;
}

/**
 * 待确认计划的信息（§13.5 确认卡片）。
 *
 * 服务端在生成 pending 消息时把「已经解析好的渠道和模型」一并算好存进 tool_result，
 * 前端不必也不该再去解析 alias——alias 表只活在服务端。
 */
export interface ConfirmPreview {
  /**
   * 待确认的原因：
   * - `video_policy` / `session_limit`：生成闸门（§13）
   * - `brain_down`：大脑不可用，退化成「按你原话生成」（§15 直通模式）
   */
  reason: "video_policy" | "session_limit" | "brain_down" | "board_destructive" | "board_generation" | "board_project_update";
  prompt: string;
  model: string;
  channelName: string;
  /**
   * 渠道的适配器类型。
   *
   * 卡片上的时长范围、分辨率档位、音频/提示词扩展开关都得跟着它走。只给渠道名和模型名的话，
   * 前端只能写死一套参数范围——于是给 Grok 摆出「带音频」，它根本不认这个参数。
   */
  adapterType?: string;
  mode?: string;
  duration?: number;
  resolution?: string;
  audio?: boolean;
  promptExtend?: boolean;
  /** 无限画布破坏性操作确认卡片 */
  boardDeleteNodes?: number;
  boardDeleteWithAssets?: number;
  boardSummary?: string;
  /** 音乐确认卡片展示用 */
  musicMode?: "inspiration" | "custom" | "cover" | "mashup" | "sound" | "playlist" | "sample";
  musicTitle?: string;
  musicTags?: string;
  musicInstrumental?: boolean;
  musicSourceAssetRefs?: string[];
  musicTempo?: number;
  musicKey?: string;
  musicLoop?: boolean;
  /**
   * 这次真正进视频的图，按顺序、带角色。
   *
   * 新卡片优先渲染这份：用户要一眼看出「哪几张图、谁是首帧、谁是尾帧、谁是参考图」。
   * 不写这个字段时，前端回退到下面那份老的单图字段。
   */
  videoInputs?: ConfirmVideoInput[];
  /**
   * @deprecated 老卡片的首帧引用。新卡片请用 `videoInputs`。
   * 保留它是为了让升级前已经待确认的卡片照常显示、照常能确认。
   */
  referenceAssetId?: string;
  /**
   * @deprecated 老卡片里「画布上一共几张」。新卡片请用 `videoInputs`。
   */
  referenceCount?: number;
  /**
   * 这一次确认会提交几个任务（需求.md 问题 2）。
   *
   * 只在批量时才有值：额度快满时一张卡要替 N 张图一次问清楚，
   * 卡片上不写出 N 的话，用户点「确认生成」根本不知道自己同意了多少钱。
   */
  count?: number;
  /**
   * 这一批要保持一致：`character` 同一人物 / `style` 同一画风。
   * 卡片据此说明「先生成基准图，再并行改」，而不是「一次并行提交 N 个」。
   */
  consistency?: "character" | "style";
  message: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  content: string | null;
  /** 大脑的原始输出，留着回放和排查 */
  plan: AgentPlan | null;
  toolName: AgentToolName | null;
  toolArgs: Record<string, unknown> | null;
  toolResult: ToolResult | null;
  /** 待确认时，toolResult 里放 ConfirmPreview */
  confirm: ConfirmPreview | null;
  taskId: string | null;
  assetId: string | null;
  /**
   * 这条消息引用的一组产物。
   *
   * 用户把自己已经生成的图从画布/消息里拖进输入框再发送时，光有文字看不出他指的是哪几张，
   * 所以连同这句话一起记下来，气泡上照原样摆出来。`assetId` 是「产出/上传的那一张」，
   * 两者不重叠。
   */
  assetRefs: string[];
  /** 这条消息附带的脚本文档。全文只在当轮喂给大脑，回放时只留名字和字数 */
  documents: ChatDocumentRef[];
  status: MessageStatus;
  errorMessage: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  kind: ConversationKind;
  /** 无限画布线程指向的板 id；普通对话为 null */
  boardId: string | null;
  brainChannelId: string;
  brainModel: string;
  /**
   * 当前画布：有序的一组图 id（上限 `MAX_CANVAS_IMAGES`），`[0]` 是**主图**——生视频的首帧、
   * 看图改喂给大脑的那张、确认卡上的缩略图都用它。空数组 = 没有画布。
   *
   * 「画布」和「本会话的图」是两件事：画布是**参与下一步**的那几张（被选中、会被当参考图发出去），
   * 本会话的图是仓库（`ConversationView.sessionImages`）。这里存的是前者。
   */
  canvasAssetIds: string[];
  status: ConversationStatus;
  videoConfirmPolicy: VideoConfirmPolicy;
  /** §11.7 看图改开关，关掉就完全退化成盲改 */
  visionEnabled: boolean;
  /**
   * 原话直发：大脑必须**逐字**使用用户那句话当提示词，不许增删改写。
   *
   * 平时它会把口语扩写成完整画面（默认就该这样，效果更好），但有些用户是带着
   * 自己攒了很久的提示词来的，被「优化」一下反而不是他要的。这个开关交给他自己决定。
   */
  verbatimPrompt: boolean;
  chatMode?: "creative" | "chat";
  contextBudget?: number;
  chatAutoContinueLimit?: number;
  autoContinueCount: number;
  /** 本会话已经提交过的生成任务数，用于 §16 的任务软上限 */
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 本会话的大脑海量用量（每次调用累加；上下文取最近一次请求的输入大小） */
export interface ConversationUsage {
  /** 最近一次大脑请求的 prompt_tokens——这就是「现在上下文有多大」最准的近似 */
  contextTokens: number;
  /** 本会话所有大脑调用的输入 token 合计 */
  promptTokens: number;
  /** 本会话所有大脑调用的输出 token 合计 */
  completionTokens: number;
  /** 其中推理 token（已包含在 completionTokens 里，单独列出来便于排查） */
  reasoningTokens: number;
  /** 记过几次调用——0 表示这个会话还没跟大脑说过话 */
  calls: number;
}

export interface ConversationView extends Conversation {
  contextSummary: { text: string; throughSeq: number } | null;
  messages: ChatMessage[];
  /** token 用量；状态行用它，接口不可用时全 0 */
  usage: ConversationUsage;
  /**
   * 画布那一组图的详情，顺序同 `canvasAssetIds`（`[0]` 是主图），已滤掉查不到的 id 和非图片。
   *
   * 名字里的 canvas 指的就是当前画布——这一点是刻意的：以前这里叫 `canvasAssets`，
   * 而那个字段装的是**整个会话**的图，名字和含义正好反着，谁都读不对。
   *
   * ⚠️ 界面上渲染上区时**不直接用这一份**，而是拿 `canvasAssetIds` + `sessionImages` 现算
   * （见 `ChatView` 里的 `canvasImages`）。因为点选是乐观更新的、PATCH 的响应刻意不回灌 view，
   * 直接渲染这份服务端快照的话，点一下要等下一次全量刷新才看得见。这份是服务端视角的
   * 权威结果，给测试和其它消费者用。
   */
  canvasImages: Asset[];
  /**
   * 会话里出现过的全部图片产物，按时间正序。界面上的「本会话的图（全部 N 张）」区渲染它。
   *
   * 和 `canvasImages` 的顺序不同不是疏忽：这一份是仓库，按时间排才找得到；
   * 那一份是「参与下一步的顺序」，顺序本身有含义（第一张是主图）。
   */
  sessionImages: CanvasAsset[];
  /**
   * 会话里出现过的**全部**产物（图 + 视频），按时间正序。
   *
   * 和 `sessionImages` 是两个用途：那一份只有图片；这一份是「能点开看的」——
   * 视频不在里面找的话，点视频结果就只剩一个裂图（需求.md 问题 3 的现场）。
   */
  mediaAssets: CanvasAsset[];
  /** 分镜表里的镜头数；会话头用它显示「分镜 N」，0 表示还没拆过 */
  storyboardCount: number;
}

/** 产物引用：`#a3f1` 是 id 的前 4 位，也是展示给大脑和用户的编号 */
export interface CanvasAsset {
  asset: Asset;
  /** 第几轮产出的，用于徽章上的「来自第 N 轮」 */
  round: number;
  prompt: string;
  /**
   * 这张是生成出来的还是用户自己传的（需求.md 问题 4）。
   *
   * 两者的可预期行为不一样——上传的图没有提示词、也没花钱——所以「本会话的图」
   * 里要能一眼看出来源，不能长得一模一样。
   */
  source: "generate" | "upload" | "storyboard" | "setting" | "bridge";
}

/** 简短的产物编号，展示和大脑引用都用它 */
export function assetRef(assetId: string) {
  return `#${assetId.slice(0, 4)}`;
}

export interface ConversationSummary extends Conversation {
  lastMessage: string;
  messageCount: number;
}

/** §14 SSE 事件协议 */
export type AgentStreamEvent =
  /** 推理模型的思考过程，实时推给前端（§21.3 的延迟缓解手段） */
  | { type: "reasoning"; text: string }
  /** 正文 token */
  | { type: "token"; text: string }
  | { type: "status"; status: ConversationStatus }
  /** 大脑已经决定要调用什么工具 */
  | { type: "plan"; messageId: string; plan: AgentPlan }
  /** 落库后的完整消息（工具卡片、气泡、产物都在这里） */
  | { type: "message"; message: ChatMessage }
  /** §13 等待用户确认 */
  | { type: "confirm"; messageId: string; preview: ConfirmPreview }
  /**
   * 丢掉已经流式显示的半截内容。
   *
   * 只在「这一轮要重来」时发：身份跑偏后的纠正、JSON 解析失败的纠正。
   * 不发的话，前端会把第一次跑偏的正文和重试后的正文拼在一起，用户看到的
   * 是一段前后矛盾的独白。
   */
  | { type: "context_compression"; status: "started" | "finished"; message: string }
  | { type: "context_summary"; text: string; throughSeq: number }
  | { type: "text_token"; text: string }
  | { type: "reset" }
  /** 视频进度转发 */
  | { type: "progress"; taskId: string; status: string; progress: number | null }
  /** 无限画布 Agent 改了文档：带上增量，画布能直接合并；delta 缺失时回退整份拉取 */
  | { type: "board"; boardId: string; version: number; reason?: string; delta?: BoardDelta }
  | { type: "board_frame_request"; boardId: string; requestId: string; videoAssetId: string }
  | { type: "board_batch_progress"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; status: ConversationStatus };

/** 新建会话时可以指定的东西，全部可选，缺省走设置里的全局默认 */
export interface ConversationInput {
  title?: string;
  brainChannelId?: string;
  brainModel?: string;
  videoConfirmPolicy?: VideoConfirmPolicy;
  visionEnabled?: boolean;
  verbatimPrompt?: boolean;
}

export interface ConversationPatch {
  contextBudget?: number;
  chatAutoContinueLimit?: number;
  chatMode?: "creative" | "chat";
  title?: string;
  brainChannelId?: string;
  brainModel?: string;
  videoConfirmPolicy?: VideoConfirmPolicy;
  visionEnabled?: boolean;
  verbatimPrompt?: boolean;
  /**
   * 手动设/清画布（§10.1 规则 3 的「设为当前」）：有序的一组图 id，`[0]` 是主图。
   * 空数组 = 清空画布，和「没传这个键」是两回事。
   */
  canvasAssetIds?: string[];
  /**
   * @deprecated 老版本的单图画布指针，只为了让旧前端不静默失效而保留在这里，新代码用 `canvasAssetIds`。
   * 服务端收到它的唯一去处是归一成 `canvasAssetIds`（见 app.ts 的 PATCH 路由）。
   */
  currentAssetId?: string | null;
}

/** Agent 相关的设置，和 assetsDir 并列存在 settings 表里 */
export interface AgentSettings {
  /** 新建会话时的默认视频确认策略 */
  videoConfirmPolicy: VideoConfirmPolicy;
  /** 新建会话时默认是否开看图改 */
  visionEnabled: boolean;
  /**
   * 默认生图 / 生视频模型（需求.md 问题 5），存的是 alias，空串表示没设。
   *
   * 存 alias 而不是 channelId + model：alias 表是按**启用中**的渠道现算的，
   * 所以渠道一停用，存着的值就自然失效、自动退回类目第一个——不用额外维护引用完整性。
   */
  defaultImageAlias: string;
  defaultVideoAlias: string;
  /** 音乐（Suno）和语音（TTS）分开存；`defaultAudioAlias` 是旧版的合并值 */
  defaultMusicAlias: string;
  defaultSpeechAlias: string;
  defaultAudioAlias: string;
}
