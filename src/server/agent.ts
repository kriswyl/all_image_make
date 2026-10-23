/**
 * 对话式 Agent 的主循环（AGENT_PLAN.md §7、§9、§12、§13、§15）。
 *
 * 一句话概括这个文件在干什么：
 * **把任务列表里那份 §7 系统提示词，执行成一串 TaskRunner 调用。**
 *
 * 三个需要理解的设计：
 *
 * 1. **用 JSON 协议而不是原生 function calling**（§7.3）。中转站会把 `tools`
 *    参数改坏或直接丢掉，而模型对「只输出一个 JSON 对象」这种指令遵从度很高。
 *    代价是解析要写得宽容——去代码块、取第一个平衡花括号、包一层 `{"plan":{}}`
 *    也要认。
 * 2. **工具执行是串行的，一轮一个**（§16）。这样「先画图看结果再决定要不要改」
 *    才成立，也避免了并发提交把会话任务额度瞬间吃光。
 * 3. **这个类不持有 HTTP 请求**。SSE 靠每个会话一个订阅者集合广播，
 *    所以视频任务在几分钟后完成时，即使当初那个 HTTP 连接早就断了，
 *    自动续跑的输出照样能推给重新连上的客户端（§12.2）。
 */
import type { AppDatabase, AssetRow } from "./db.js";
import type { TaskEvent, TaskRunner } from "./tasks.js";
import { AppError, isTerminalStatus } from "./tasks.js";
import type { KeyStore } from "./key-store.js";
import { RemoteApiError } from "./adapters.js";
import { BrainError, callBrain, type BrainContentPart, type BrainMessage, type BrainResult } from "./brain.js";
import {
  buildCapabilityAliases,
  buildCapabilityManifest,
  markVisionUnsupported,
  modelFingerprint,
  readVisionUnsupported,
  resolveAlias,
} from "./capabilities.js";
import {
  resolveAssetRef, resolveImageRefs, resolveVideoSelection,
  type ToolContext, type ToolOutcome, type VideoSelection,
} from "./agent-tools.js";
import { assetThumbDataUri } from "./vision.js";
import {
  AGENT_TOOL_NAMES,
  GENERATION_TOOLS,
  IMAGE_PRODUCING_TOOLS,
  assetRef,
  planCalls,
  AUTO_TITLE_MAX_CHARS,
  DEFAULT_CONVERSATION_TITLE,
  type AgentPlan,
  type AgentStreamEvent,
  type AgentToolName,
  type ChatMessage,
  type ConfirmPreview,
  type ConfirmVideoInput,
  type Conversation,
  type ConversationView,
  type GenerateVideoArgs,
  type PlannedCall,
  type ToolResult,
  type VideoConfirmPolicy,
} from "../shared/agent-types.js";
import { isImageAsset, MAX_CANVAS_IMAGES, taskKindFor } from "../shared/types.js";
import {
  MAX_ROUNDS, MAX_AUTO_CONTINUE, MAX_SESSION_TASKS, MAX_PARSE_RETRY,
  MAX_VISION_READS_PER_ROUND, MAX_VISION_IMAGES,
} from "./agent-constants.js";
import {
  BATCHABLE_TOOLS, asBool, asNumber, asString, extractPlanText, parsePlan, repairPlan,
  resolveBatch, salvagePlan,
} from "./agent-plan.js";
import {
  buildConfirmPreview, mergeConfirmArgs, shouldConfirm, withConfirmedVideoSelection,
} from "./agent-confirm.js";
import { canvasAfterProducing, sameCanvasIds } from "./agent-canvas.js";
import {
  EMPTY_REPLY_CORRECTION, IDENTITY_CORRECTION, collectTurnAttachmentIds, looksLikeIdentityDrift,
  toBrainMessage, type BuiltContext,
} from "./agent-context.js";
import { describeBrainFailure, isBrainDown, isFatalBrainError, isVisionError } from "./agent-brain-errors.js";
import { buildSystemPrompt } from "./agent-prompt.js";
import { BatchExecutor, type BatchOutcome } from "./agent-batch.js";
import { isVisionBlocked, observeImages } from "./agent-vision.js";
import { handleTaskEvent } from "./agent-task-events.js";
import { BrainRunner } from "./agent-brain.js";

// 测试和外部调用仍从 `agent.ts` 导入这些纯函数，保留原来的入口
export {
  BATCHABLE_TOOLS, extractPlanText, parsePlan, repairPlan, resolveBatch, salvagePlan,
} from "./agent-plan.js";
export {
  mergeConfirmArgs, shouldConfirm, withConfirmedVideoSelection,
} from "./agent-confirm.js";
export { canvasAfterProducing } from "./agent-canvas.js";
export { buildSystemPrompt } from "./agent-prompt.js";
export { collectTurnAttachmentIds, looksLikeIdentityDrift, toBrainMessage } from "./agent-context.js";
export {
  MAX_ROUNDS, MAX_AUTO_CONTINUE, MAX_SESSION_TASKS, MAX_PARSE_RETRY,
  MAX_VISION_READS_PER_ROUND, MAX_VISION_IMAGES,
} from "./agent-constants.js";

export type TurnTrigger = "user" | "task_finished" | "confirmation";

export class AgentService {
  /** 每个会话的 SSE 订阅者。HTTP 断开会退订，但会话本身继续跑（§12.2） */
  private readonly listeners = new Map<string, Set<(event: AgentStreamEvent) => void>>();
  /** 正在跑的那一轮。同一会话同时只允许一轮（§16 串行） */
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly detachRunner: () => void;
  private readonly batch: BatchExecutor;
  private readonly brain: BrainRunner;

  constructor(
    private readonly db: AppDatabase,
    private readonly runner: TaskRunner,
    private readonly sessionKeys: KeyStore,
  ) {
    this.batch = new BatchExecutor({
      db: this.db,
      executeTool: (conversation, plan, controller, options, turnAttachmentIds) =>
        this.executeTool(conversation, plan, controller, options, turnAttachmentIds),
      toolContext: (conversation, controller, options, turnAttachmentIds) =>
        this.toolContext(conversation, controller, options, turnAttachmentIds),
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
    });
    this.brain = new BrainRunner({
      db: this.db,
      sessionKeys: this.sessionKeys,
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
    });
    this.detachRunner = runner.onTaskEvent((event) => handleTaskEvent(this.taskEventHost(), event));
  }

  private taskEventHost() {
    return {
      db: this.db,
      broadcast: (conversationId: string, event: AgentStreamEvent) => this.broadcast(conversationId, event),
      hasActiveTurn: (conversationId: string) => this.activeTurns.has(conversationId),
      startTurn: (conversationId: string, text: null, trigger: "task_finished") =>
        this.startTurn(conversationId, text, trigger),
      reportTurnFailure: (conversationId: string, error: unknown) =>
        this.reportTurnFailure(conversationId, error),
    };
  }

  dispose() {
    this.detachRunner();
    for (const controller of this.activeTurns.values()) controller.abort();
    this.activeTurns.clear();
    this.listeners.clear();
  }

  isRunning(conversationId: string) {
    return this.activeTurns.has(conversationId);
  }

  /** 中断当前这一轮。任务已经提交出去的部分照常跑完，只是大脑不再往下规划 */
  interrupt(conversationId: string) {
    const controller = this.activeTurns.get(conversationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  subscribe(conversationId: string, listener: (event: AgentStreamEvent) => void): () => void {
    const bucket = this.listeners.get(conversationId) ?? new Set();
    bucket.add(listener);
    this.listeners.set(conversationId, bucket);
    return () => {
      bucket.delete(listener);
      if (!bucket.size) this.listeners.delete(conversationId);
    };
  }

  private broadcast(conversationId: string, event: AgentStreamEvent) {
    const bucket = this.listeners.get(conversationId);
    if (!bucket) return;
    for (const listener of bucket) {
      try {
        listener(event);
      } catch {
        // 单个客户端写失败不能拖垮这一轮
      }
    }
  }

  /** 详情页要用的完整视图 */
  buildView(conversationId: string): ConversationView | null {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return null;
    const entries = this.db.listConversationAssets(conversationId);
    const toCanvasAsset = (entry: (typeof entries)[number]) => ({
      asset: this.db.assetView(entry.asset), round: entry.round, prompt: entry.prompt, source: entry.source,
    });
    return {
      ...conversation,
      messages: this.db.listMessages(conversationId),
      // token 账本：状态行显示「上下文多大 / 这个会话一共花了多少 token」
      usage: this.db.conversationUsage(conversationId),
      // 当前画布那一组，顺序同 canvasAssetIds（不能按时间重排——第一张是画布序号 1）。
      // 走 db.canvasImages 而不是自己 map：它顺手滤掉已被删掉的产物和非图片
      canvasImages: this.db.canvasImages(conversation).map((asset) => this.db.assetView(asset)),
      // 「本会话的图」是仓库，按时间正序；只认图片——视频不给「加入画布」（§10.1 规则 2）
      sessionImages: entries.filter((entry) => isImageAsset(entry.asset)).map(toCanvasAsset),
      // 但「能点开看的」要连视频一起给——否则前端找不到视频的 mimeType，
      // 灯箱照旧当图片渲染，用户看到的就是一个裂图（需求.md 问题 3）
      mediaAssets: entries.map(toCanvasAsset),
      storyboardCount: this.db.countStoryboardShots(conversationId),
    };
  }

  // ── 对外入口 ───────────────────────────────────────────────────────────────

  /**
   * 开始一轮。**立即返回**，产出全部走 SSE（§14）。
   *
   * 抛出的异常只有「本地就能判定」的那几种（会话不存在、上一轮没结束），
   * 大脑和上游的错误一律变成 `error` 事件推给前端。
   */
  startTurn(conversationId: string, text: string | null, trigger: TurnTrigger, assetRefs: string[] = []) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (this.activeTurns.has(conversationId)) {
      throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);
    }
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    void this.turn(conversationId, text, trigger, controller, assetRefs)
      .catch((error) => this.reportTurnFailure(conversationId, error))
      .finally(() => {
        this.activeTurns.delete(conversationId);
        // 收尾时兜一下状态：正常路径都会自己设好，这里只防异常路径把会话永久卡在 running
        const latest = this.db.getConversation(conversationId);
        if (latest?.status === "running") {
          this.db.setConversationStatus(conversationId, "idle", { touch: false });
          this.broadcast(conversationId, { type: "done", status: "idle" });
        }
        /*
         * 任务比消息先结束的那种（提交即失败最快）：完成事件发出去的时候，
         * 工具消息还没落库，handleTaskEvent 找不到人接手；等消息落库了，
         * 这一轮又还没结束，会撞上它那道 `activeTurns` 的闸。
         * 现在这一轮真的结束了、闸也抬起来了——补查一次，让它照常收口。
         * 正常情况下（视频还在跑）这里是空转：任务没终态，什么都不做。
         */
        if (this.db.getConversation(conversationId)?.status === "waiting_task") {
          this.settleFinishedTasks(conversationId);
        }
      });
  }

  /**
   * §13.5 确认卡片的两个出口。
   *
   * `argsOverride` 是用户在卡片上改过的视频参数（时长/分辨率/音频/提示词扩展）。
   * 只放行这几个旋钮：模型是大脑选的、渠道是别名解析出来的，卡片上那行只是给用户看的，
   * 改它不在卡片的设计意图里，放行反而会让「显示的和生成的不一致」。
   */
  async resolveConfirmation(
    conversationId: string,
    messageId: string,
    decision: "approve" | "reject",
    argsOverride?: Record<string, unknown>,
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const message = this.db.getMessage(messageId);
    if (!message || message.conversationId !== conversationId) throw new AppError("MESSAGE_NOT_FOUND", "消息不存在", 404);
    if (message.status !== "pending" || !message.confirm) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
    if (this.activeTurns.has(conversationId)) throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);

    if (decision === "reject") {
      // 卡片收起来，并把「用户取消了」记进上下文——下次大脑开口时知道这件事
      this.db.updateMessage(messageId, { confirm: null, status: "error", errorMessage: "用户取消了这次生成" });
      const recorded = this.db.appendMessage({
        conversationId, role: "system", content: "已取消本次生成",
      });
      const updated = this.db.getMessage(messageId);
      if (updated) this.broadcast(conversationId, { type: "message", message: updated });
      this.broadcast(conversationId, { type: "message", message: recorded });
      this.db.setConversationStatus(conversationId, "idle", { touch: false });
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }

    // 批量待确认的卡上**没有** toolName——写上去 UI 会把它当成「只画一张」，
    // 整批调用存在 plan.calls 里。两条路分开走：单调用那条一个字节都不动。
    const batch = planCalls(message.plan);
    if (batch.length > 1) {
      const batchController = new AbortController();
      this.activeTurns.set(conversationId, batchController);
      // 批量里只可能是产图工具，没有时长/分辨率这类旋钮，所以卡片上不会有 argsOverride。
      // 真有也别悄悄套上去：那些字段对生图没有意义，套上去等于编造一份「用户改过的参数」
      void this.approveBatch(conversationId, message.id, batch, batchController, message.plan?.consistency)
        .catch((error) => this.reportTurnFailure(conversationId, error))
        .finally(() => this.activeTurns.delete(conversationId));
      return;
    }

    const tool = message.toolName;
    if (!tool || !(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new AppError("INVALID_PLAN", "这条待确认记录缺少工具信息", 400);
    }
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);

    // 先落库再执行：执行中途刷新页面时，用户看到的参数必须是真正拿去生成的那份
    const merged = mergeConfirmArgs(message.toolName, message.toolArgs ?? {}, argsOverride);
    // 升级前就摆在那里的视频卡片没有 videoInputs / imageRefs：
    // 按卡片上当时显示的「主图当首帧」补回去，免得用户点确认时突然被要求重选
    const args = withConfirmedVideoSelection(merged, message.confirm);
    const changed = JSON.stringify(args) !== JSON.stringify(message.toolArgs ?? {});
    if (changed) {
      this.db.updateMessage(messageId, { toolArgs: args });
      this.broadcast(conversationId, { type: "message", message: { ...message, toolArgs: args } });
    }

    void this.approve(conversationId, message.id, tool, args, controller)
      .catch((error) => this.reportTurnFailure(conversationId, error))
      .finally(() => this.activeTurns.delete(conversationId));
  }

  // ── 主循环 ─────────────────────────────────────────────────────────────────

  /**
   * 用第一条指令的前几个字当会话名（对齐 Codex）。
   *
   * 只在标题还是默认值时才动手——用户改过名字就说明这个名字是他要的，
   * 后面每一轮都去覆盖它会让「重命名」这个功能直接失效。
   * 之所以放在服务端而不是前端：会话名是库里的字段，从哪台设备、哪个入口发第一条消息都得生效。
   */
  private nameFromFirstMessage(conversationId: string, text: string) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.title !== DEFAULT_CONVERSATION_TITLE) return;
    // 消息可能是多行的，标题只取第一行的形状：折成一行再截断
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return;
    const title = line.length > AUTO_TITLE_MAX_CHARS ? `${line.slice(0, AUTO_TITLE_MAX_CHARS)}…` : line;
    this.db.updateConversation(conversationId, { title });
  }

  private async turn(
    conversationId: string,
    text: string | null,
    trigger: TurnTrigger,
    controller: AbortController,
    assetRefs: string[] = [],
  ) {
    let userMessage: ChatMessage | null = null;
    // 这一轮附带的图只算一次：工具执行到最后一条消息已经是助手计划行，
    // 再回头扫数据库找不到用户那几条，所以必须在这里锁住并一路传下去
    let turnAttachmentIds: string[] = [];
    if (text !== null) {
      // 引用的一组装在**同一条消息**上：用户拖了三张图说了句话，界面上就是一条气泡
      // 配三张缩略图，而不是四条消息
      userMessage = this.db.appendMessage({ conversationId, role: "user", content: text, assetRefs });
      turnAttachmentIds = collectTurnAttachmentIds(this.db, conversationId, userMessage.seq);
      this.broadcast(conversationId, { type: "message", message: userMessage });
      this.nameFromFirstMessage(conversationId, text);
      this.db.resetAutoContinue(conversationId);
      this.supersedePendingConfirmations(conversationId);
    }
    this.setStatus(conversationId, "running");
    try {
      await this.runLoop(conversationId, trigger, controller, 0, turnAttachmentIds);
    } catch (error) {
      // §15 直通模式。只在「这一轮什么也没发生」时才降级：如果大脑已经跑了几轮、
      // 图也画了，那问题就不在「大脑连不上」，再兜一次只会让上下文更乱。
      if (userMessage && isBrainDown(error) && !controller.signal.aborted
        && this.nothingHappenedSince(conversationId, userMessage.seq)) {
        this.offerPassthrough(conversationId, userMessage, error);
        return;
      }
      throw error;
    }
  }

  /**
   * 工具已经执行完、只是大脑接不上话时的收尾。
   *
   * 这条路的重点是**别把已经花掉的钱说成失败**：图已经生成、结果已经落库，
   * 这时候再甩一个红色报错，用户会以为没出图而重新生成一遍。
   */
  private finishAfterBrainLoss(conversationId: string, note: string) {
    const message = this.db.appendMessage({ conversationId, role: "system", content: note });
    this.broadcast(conversationId, { type: "message", message });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  /** 这一轮除了 `seq` 那条用户消息之外，还有没有落过别的消息（工具卡片、气泡、系统提示都算） */
  private nothingHappenedSince(conversationId: string, seq: number): boolean {
    return !this.db.listMessages(conversationId).some((message) => message.seq > seq && message.role !== "user");
  }

  /**
   * 大脑不可用时的退化出口（§15）。
   *
   * 计划里写的是「直接按原话生成」，落地时改成**先问一句**：这个工作区的提示词是
   * 给大脑看的（「把这张的手改一下」），原话当 prompt 拿去生成，轻则画出一张无关的图，
   * 重则白花一笔钱——而 §16 的全部精神就是不让任何东西替用户决定花钱。
   * 所以能力保留，决定权交回用户：卡片上就是他的原话，点一下才生成。
   */
  private offerPassthrough(conversationId: string, userMessage: ChatMessage, error: unknown) {
    const raw = (userMessage.content ?? "").trim();
    const aliases = buildCapabilityAliases(this.db.listChannels());
    const resolution = resolveAlias(aliases, undefined, "image", this.defaultAliases().image);
    const channel = resolution ? this.db.getChannel(resolution.channelId) : null;

    // 原话直接当 prompt：太长多半是整段需求而不是一句描述，截断总比把请求撑爆好
    const prompt = raw.length > 1000 ? raw.slice(0, 1000) : raw;

    const preview: ConfirmPreview = {
      reason: "brain_down",
      prompt,
      model: resolution?.model ?? "（还没有配置图片渠道）",
      channelName: channel?.name ?? "",
      message: `大脑用不了了（${describeBrainFailure(error)}）。要不要先按你这句话直接生成一张图？`,
    };

    const message = this.db.appendMessage({
      conversationId, role: "assistant", status: "pending",
      content: "我没有理解这句话的能力了，但生成还能用。确认的话，我就拿这句话当提示词画一张。",
      toolName: "generate_image", toolArgs: { prompt }, confirm: preview,
    });
    this.broadcast(conversationId, { type: "message", message });
    this.setStatus(conversationId, "awaiting_confirmation");
    this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
  }

  /** 用户点了「确认生成」：直接执行存下来的参数，不让大脑重新规划一遍（§13.5） */
  private async approve(
    conversationId: string,
    messageId: string,
    tool: AgentToolName,
    args: Record<string, unknown>,
    controller: AbortController,
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return;
    this.setStatus(conversationId, "running");
    const outcome = await this.executeTool(conversation, { tool, args }, controller, {
      existingMessageId: messageId,
      confirmed: true,
    });
    if (outcome.terminal) {
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    try {
      await this.runLoop(conversationId, "confirmation", controller, 1);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  /**
   * 用户确认了一整批（§16 + 需求.md 问题 2b）。
   *
   * 和 `approve` 的差别只有一处：那张确认卡上记的是 N 个调用，不是「工具 + 参数」。
   * `existingMessageId` 同样传下去——卡片所在的那行就地变成这轮的表头气泡，
   * 而不是在它下面再冒一个内容一模一样的新气泡。展开出来的 N 对行
   * （表头 + N 条工具行）由 `executeParallel` 按批量的写法补齐。
   */
  private async approveBatch(
    conversationId: string,
    messageId: string,
    calls: PlannedCall[],
    controller: AbortController,
    consistency?: "character" | "style",
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return;
    this.setStatus(conversationId, "running");
    // `say` 不给：表头行就是那张卡片，它上面的话一个字都不用重写
    const outcome = await this.batch.executeBatch(conversation, {
      calls,
      ...(consistency ? { consistency } : {}),
    }, controller, {
      existingMessageId: messageId,
      confirmed: true,
    });
    if (outcome.terminal) {
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    try {
      await this.runLoop(conversationId, "confirmation", controller, 1);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  /**
   * 补上「任务比消息先结束」那个时间窗。
   *
   * 提交即失败是最常见的例子（渠道没配 key、上游直接拒、参数不合法）：
   * `runner.create()` 把任务排进微任务，`run()` 立刻失败并发出 `finished` 事件，
   * 而那时工具消息还没落库——`handleTaskEvent` 按 taskId 找不到人接手，事情就彻底丢了：
   * 消息停在 pending、会话卡在 waiting_task，用户等不到任何回音（实测就是这样）。
   *
   * 所以要在**状态已经设成 waiting_task 之后**再自查一次（`handleTaskEvent` 开头那道
   * 状态门就是这么要求的），让它照常跑一遍收口。和 `TaskRunner.waitFor` 里那句
   * 「订阅之前任务可能已经结束，必须再查一次」是同一个道理。
   */
  /**
   * 启动时收拾上一进程留下的「进行中」会话尸体。
   *
   * 只收拾 `running`：`waiting_task` 要留着——那条视频可能还在上游跑，`runner.resume()`
   * 会接着轮询；`awaiting_confirmation` 也留着，那是在等用户点头。
   */
  recoverStaleConversations(): number {
    return this.db.resetConversationsStuckInRunning();
  }

  private settleFinishedTasks(conversationId: string) {
    for (const message of this.db.listPendingMessages(conversationId)) {
      if (!message.taskId || message.toolResult?.async !== true) continue;
      const task = this.db.getTaskView(message.taskId);
      if (task && isTerminalStatus(task.status)) handleTaskEvent(this.taskEventHost(), { kind: "finished", task });
    }
  }

  private async runLoop(
    conversationId: string,
    trigger: TurnTrigger,
    controller: AbortController,
    startRound: number,
    turnAttachmentIds: string[] = [],
  ) {
    for (let round = startRound; round < MAX_ROUNDS; round += 1) {
      if (controller.signal.aborted) return this.finishInterrupted(conversationId);
      const conversation = this.db.getConversation(conversationId);
      if (!conversation) return;

      const outcome = await this.runOneRound(conversation, trigger, round, controller, turnAttachmentIds);
      if (outcome === "stop") return;
    }

    // 轮次用尽：大脑在循环里转圈，收尾说一句实话而不是让它一直烧钱
    const note = this.db.appendMessage({
      conversationId, role: "system", status: "error",
      content: `这一轮已经尝试了 ${MAX_ROUNDS} 次，我先停下来了。可以换个说法再试，或者直接说明你想要的结果。`,
    });
    this.broadcast(conversationId, { type: "message", message: note });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  /** 返回 "stop" 表示这一轮结束（正常收尾 / 等任务 / 等确认），"continue" 表示继续下一轮 */
  private async runOneRound(
    conversation: Conversation,
    trigger: TurnTrigger,
    round: number,
    controller: AbortController,
    turnAttachmentIds: string[],
  ): Promise<"continue" | "stop"> {
    const built = await this.brain.buildBrainMessages(conversation, turnAttachmentIds);
    return this.runRoundWithMessages(conversation, trigger, round, controller, built, turnAttachmentIds, 0);
  }

  /**
   * 一轮里的「问大脑 → 解析 → 执行」。
   *
   * 单独拆出来是为了支持 `view_images`：大脑要求看图时，把缩略图作为一条临时
   * user 消息接在 `built.messages` 后面，再问一次——**不落库、不占轮次**。
   * 否则要么看不到图，要么得把「看过哪些图」永久写进上下文，每轮都重复付费。
   */
  private async runRoundWithMessages(
    conversation: Conversation,
    trigger: TurnTrigger,
    round: number,
    controller: AbortController,
    built: BuiltContext,
    turnAttachmentIds: string[],
    visionReads: number,
  ): Promise<"continue" | "stop"> {
    const conversationId = conversation.id;
    let result = await this.brain.callBrainWithRecovery(conversation, built, controller);

    /**
     * 身份被上游提示词盖住时纠正一次（见 `looksLikeIdentityDrift`）。
     *
     * 只在这一轮的原话里真的出现跑偏信号时才多花一次调用；纠正失败就把原文
     * 交给下面的解析/兜底，不再反复重试——中转站不听话时来回重试只是烧钱。
     */
    if (looksLikeIdentityDrift(result.content)) {
      this.broadcast(conversationId, { type: "reset" });
      try {
        result = await this.brain.callBrainRaw(conversation, [
          ...built.messages,
          { role: "assistant", content: result.content.slice(0, 2000) },
          { role: "user", content: IDENTITY_CORRECTION },
        ], controller, conversationId, { silent: true });
      } catch (error) {
        // 用户叫停时照常抛出；别的错误保留第一次的内容，让用户至少看到发生了什么
        if (controller.signal.aborted) throw error;
      }
    }

    let plan = parsePlan(result.content);
    for (let attempt = 0; !plan && attempt < MAX_PARSE_RETRY; attempt += 1) {
      // §15：模型偶尔会夹带解释文字或代码块，纠正一次而不是直接报错
      const corrected: BrainMessage[] = [
        ...built.messages,
        { role: "assistant", content: result.content.slice(0, 2000) },
        {
          role: "user",
          content: '你上面的输出不是合法 JSON。请只输出一个 JSON 对象，形如 {"tool": "工具名", "args": {...}, "say": "一句话"}，不要输出任何其他文字、不要用代码块包裹。',
        },
      ];
      this.broadcast(conversationId, { type: "reset" });
      result = await this.brain.callBrainRaw(conversation, corrected, controller, conversationId, { silent: true });
      plan = parsePlan(result.content) ?? salvagePlan(result.content) ?? repairPlan(result.content);
    }

    if (!plan) {
      // 实在解析不出来：把模型原话当成回答显示，用户至少看得到发生了什么
      const fallback = result.content.trim();
      const message = this.db.appendMessage({
        conversationId, role: "assistant", content: fallback || "（大脑没有返回内容）",
        status: fallback ? "ok" : "error",
        errorMessage: fallback ? null : "大脑返回了空内容",
      });
      this.broadcast(conversationId, { type: "message", message });
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return "stop";
    }

    /**
     * 大脑要求看画布。
     *
     * 这是「按指令选图」的关键：没有附带图时，它不该凭猜测默认主图，
     * 而是先看一眼。看图不生成、不花钱，但每看一次要多一趟大脑请求，
     * 所以有次数上限；超了就停下让用户重说，而不是无限循环。
     */
    if (plan.tool === "view_images") {
      if (visionReads >= MAX_VISION_READS_PER_ROUND) {
        const note = this.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: `这一轮已经看了 ${MAX_VISION_READS_PER_ROUND} 次图，我先停下来了。可以直接说要改哪一张（例如「画布第 2 张」），或把图拖进输入框再发一次。`,
        });
        this.broadcast(conversationId, { type: "message", message: note });
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }
      const observed = await this.observeImages(conversation, plan, built, controller);
      // 刚才那串 view_images 的原始 JSON 不能留在输入框/流式气泡里
      this.broadcast(conversationId, { type: "reset" });
      return this.runRoundWithMessages(
        conversation, trigger, round, controller, observed, turnAttachmentIds, visionReads + 1,
      );
    }

    // 纯文本工具：落库就是模型的原话，不需要执行任何东西
    if (plan.tool === "reply" || plan.tool === "ask") {
      let text = extractPlanText(plan, result.content);

      /**
       * 空 reply 的自救。
       *
       * 模型只输出 `{"tool":"reply","args":{}}` 时，以前会原样落一条空消息——
       * 用户看到的就是「第一句话被吞了」。这里先纠正一次；纠正后仍然是空，
       * 就留一句系统提示，绝不落空气泡。
       */
      if (!text) {
        this.broadcast(conversationId, { type: "reset" });
        try {
          const retried = await this.brain.callBrainRaw(conversation, [
            ...built.messages,
            { role: "assistant", content: result.content.slice(0, 2000) },
            { role: "user", content: EMPTY_REPLY_CORRECTION },
          ], controller, conversationId, { silent: true });
          const retriedPlan = parsePlan(retried.content) ?? salvagePlan(retried.content) ?? repairPlan(retried.content);
          if (retriedPlan) {
            plan = retriedPlan;
            result = retried;
            text = extractPlanText(retriedPlan, retried.content);
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
      }

      if (!text) {
        const note = this.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: "助手这次没有返回正文（模型给了个空的回复），请再说一次。",
        });
        this.broadcast(conversationId, { type: "message", message: note });
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }

      // 把正文写回 plan：下一轮回放时，模型能看到自己上一条到底说了什么
      const normalizedPlan: AgentPlan = plan.tool === "ask"
        ? { ...plan, args: { ...plan.args, question: text } }
        : { ...plan, args: { ...plan.args, text } };
      const message = this.db.appendMessage({ conversationId, role: "assistant", content: text, plan: normalizedPlan });
      this.broadcast(conversationId, { type: "message", message });
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return "stop";
    }

    // §13 / §16：确认闸门。链条上的视频、以及超额度的任何生成都先问一句。
    // 闸门看的是 `resolveBatch` 之后**真正要跑的那几个**——卡片上问 N 张、
    // 实际提交 M 张是这里最不能出的错
    const resolvedBatch = resolveBatch(planCalls(plan));
    // 把「这一轮附带的图」固化成显式 imageRefs / mode：
    // 确认卡审批、跨轮续跑时附件集合已经没了，参数里必须已经写清楚用哪几张
    const prepared = resolvedBatch.calls.map((call) => this.materializeCall(conversation, call, turnAttachmentIds));
    const calls = prepared.map((item) => item.call);
    // 只跑了第一个 / 超上限被截断：在这里说，只此一处。放在执行器里说会漏掉
    // 「额度超了、这一批要用户先确认」那条路——那条路上执行器根本还没跑
    this.batch.announceNote(conversationId, resolvedBatch.note);
    const isContinuation = trigger !== "user" || round > 0;
    const generating = calls.filter((call) => GENERATION_TOOLS.includes(call.tool));
    // 批量只有额度这一道闸门：里面全是产图工具，`shouldConfirm` 对它们恒为 false
    const overTaskLimit = generating.length > 0 && conversation.taskCount + generating.length > MAX_SESSION_TASKS;
    const videoSelection = calls.length === 1 && calls[0]!.tool === "generate_video"
      ? this.resolveVideoForCall(conversation, calls[0]!.args, turnAttachmentIds)
      : null;
    // 生图/改图也可能因为「画布多于一张又没选图」注定失败。那种情况同样先别摆确认卡：
    // 让工具把选图要求回灌给大脑，比让用户点一次「确认生成」再看到失败要好。
    const canvasCount = this.db.canvasImages(conversation).length;
    const imageSelectionMissing = canvasCount > 1 && turnAttachmentIds.length === 0
      && prepared.some(({ call }) => {
        if (call.tool !== "edit_image" && call.tool !== "generate_image") return false;
        if (call.tool === "generate_image" && call.args.fromScratch === true) return false;
        const refs = call.args.imageRefs;
        return !Array.isArray(refs) || refs.length === 0;
      });
    // 选图本身就不成立时先别摆确认卡：卡片上写不出「用哪几张」，
    // 用户点了确认也只会得到一个失败。直接执行，让工具把原因回灌给大脑去 ask / 重选。
    const needsConfirm = !videoSelection?.error && !imageSelectionMissing && (overTaskLimit
      || (calls.length === 1 && shouldConfirm(calls[0]!.tool, isContinuation, conversation.videoConfirmPolicy)));
    if (needsConfirm) {
      const preview = buildConfirmPreview(
        this.db, conversation, calls, overTaskLimit ? "session_limit" : "video_policy",
        videoSelection?.selection, plan.consistency, this.defaultAliases(),
      );
      // 待确认的是**整批**，所以 toolName 留空、calls 存在 plan 里：
      // 写一个 toolName 上去只会让 UI 把它当成「只画一张」，确认后也只知道要跑那一个
      const pendingPlan: AgentPlan = {
        tool: calls[0]!.tool, args: calls[0]!.args,
        ...(plan.say ? { say: plan.say } : {}),
        ...(calls.length > 1 ? { calls } : {}),
        // 一致性要跟着确认卡片一起落库，否则用户点头之后批量就退化成普通并行了
        ...(calls.length > 1 && plan.consistency ? { consistency: plan.consistency } : {}),
      };
      const message = this.db.appendMessage({
        conversationId, role: "assistant", content: plan.say ?? "", plan: pendingPlan,
        ...(calls.length === 1 ? { toolName: calls[0]!.tool, toolArgs: calls[0]!.args } : {}),
        confirm: preview, status: "pending",
      });
      this.broadcast(conversationId, { type: "plan", messageId: message.id, plan: pendingPlan });
      this.broadcast(conversationId, { type: "message", message });
      this.broadcast(conversationId, { type: "confirm", messageId: message.id, preview });
      this.setStatus(conversationId, "awaiting_confirmation");
      this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
      return "stop";
    }

    const outcome = await this.batch.executeBatch(conversation, {
      calls,
      ...(plan.say ? { say: plan.say } : {}),
      ...(plan.consistency ? { consistency: plan.consistency } : {}),
    }, controller, {}, turnAttachmentIds);
    if (outcome.terminal) {
      // 视频这类异步任务：交给 TaskRunner 的完成事件续跑（§12.2）
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return "stop";
    }
    return "continue";
  }

  /**
   * 执行 `view_images`：把大脑点名的（或整组画布）缩略图接在上下文后面。
   *
   * 只看图、不落库、不生成。返回一份新的 `BuiltContext`——调用方拿它再问一次大脑。
   */
  private async observeImages(
    conversation: Conversation,
    plan: AgentPlan,
    built: BuiltContext,
    _controller: AbortController,
  ): Promise<BuiltContext> {
    return observeImages({ db: this.db }, conversation, plan, built);
  }

  /**
   * 把这一轮附带的图 / 已解析好的视频模式固化进参数。
   *
   * 这一步必须在**确认卡落库之前**做：用户过一会儿才点确认，那时
   * 「本条消息附带的图」早就无从查起，只有参数里的 imageRefs 还能复现。
   */
  private materializeCall(
    conversation: Conversation,
    call: PlannedCall,
    turnAttachmentIds: string[],
  ): { call: PlannedCall; selection?: VideoSelection } {
    if (call.tool === "generate_video") {
      const resolved = this.resolveVideoForCall(conversation, call.args, turnAttachmentIds);
      if (!resolved.selection) return { call };
      const selection = resolved.selection;
      const args: Record<string, unknown> = { ...call.args };
      if (selection.mode !== "text-to-video") args.mode = selection.mode;
      if (selection.assets.length) args.imageRefs = selection.assets.map((asset) => asset.id);
      return { call: { tool: call.tool, args }, selection };
    }
    if ((call.tool === "edit_image" || call.tool === "generate_image") && turnAttachmentIds.length) {
      const hasRefs = Array.isArray(call.args.imageRefs) && call.args.imageRefs.length > 0;
      const fromScratch = call.tool === "generate_image" && call.args.fromScratch === true;
      if (!hasRefs && !fromScratch) {
        return { call: { tool: call.tool, args: { ...call.args, imageRefs: [...turnAttachmentIds] } } };
      }
    }
    return { call };
  }

  /** 解析视频渠道并算出这次到底用哪几张图。确认卡和执行器共用这一份结果 */
  private resolveVideoForCall(
    conversation: Conversation,
    args: Record<string, unknown>,
    turnAttachmentIds: string[],
  ): { selection?: VideoSelection; error?: string } {
    const aliases = buildCapabilityAliases(this.db.listChannels());
    const resolution = resolveAlias(aliases, asString(args.modelHint), "video", this.defaultAliases().video);
    if (!resolution) return { error: "还没有可用的视频渠道，请先到「渠道配置」添加" };
    const channel = this.db.getChannel(resolution.channelId);
    if (!channel) return { error: "解析到的视频渠道不存在" };
    return resolveVideoSelection(
      this.db, conversation, args as unknown as GenerateVideoArgs, channel.adapterType, turnAttachmentIds,
      resolution.model,
    );
  }

  /**
   * 用户在设置里挑的默认生图 / 生视频模型（需求.md 问题 5），存的是 alias。
   *
   * 只在**大脑没点名**时才起作用（见 `resolveAlias`），空串按「没设」处理。
   * 存 alias 的代价是渠道被停用后它会失效，但那是正常情况而不是错误——
   * `resolveAlias` 会如实退回并标记出来，不假装一切正常。
   */
  private defaultAliases(): { image?: string; video?: string; audio?: string } {
    return {
      ...(this.db.getSetting("agentDefaultImageAlias") ? { image: this.db.getSetting("agentDefaultImageAlias")! } : {}),
      ...(this.db.getSetting("agentDefaultVideoAlias") ? { video: this.db.getSetting("agentDefaultVideoAlias")! } : {}),
      ...(this.db.getSetting("agentDefaultAudioAlias") ? { audio: this.db.getSetting("agentDefaultAudioAlias")! } : {}),
    };
  }

  /**
   * 执行这一轮的调用（需求.md 问题 2：需要多张图时并行，等一个总时长而不是 N 个）。
   *
   * 单调用就是 `calls.length === 1` 的那个特例，**原样走 `executeTool`**——
   * 确认批准、被动直通、绝大多数普通回合都是它，所以它必须和批量之前一模一样。
   * 只有真的多个调用时才走 `executeParallel`。
   *
   * 收进来的 `calls` 必须**已经过 `resolveBatch`**（`runOneRound` 和 `approveBatch`
   * 都是这么传的）。这里不再自己截断一遍：截断这件事只发生在一个地方，
   * 「卡片上问几个」和「实际提交几个」才不可能分家。
   */
  /**
   * 批量的公共开头：**一条**表头助手行 + **N 条** pending 工具行。
   *
   * 表头 `toolName` 特意留空：写上的话 `buildRows` 会把它和后面某一条工具行
   * 折成同一张卡，N 张就少一张。N 条工具行先一次写完，用户立刻看到 N 张卡一起转。
   */
  private toolContext(
    conversation: Conversation,
    controller: AbortController,
    options: { confirmed?: boolean },
    turnAttachmentIds: string[] = [],
  ): ToolContext {
    const conversationId = conversation.id;
    // 一轮之内可能是确认后再执行，那时候要用最新的那一份（画布、开关都可能刚被改过）
    const effective = options.confirmed ? conversation : this.db.getConversation(conversationId) ?? conversation;
    return {
      db: this.db,
      runner: this.runner,
      sessionKeys: this.sessionKeys,
      conversation: effective,
      aliases: buildCapabilityAliases(this.db.listChannels()),
      defaultAliases: this.defaultAliases(),
      // 开了「原话直发」就把用户那句话的原文带上；工具层会用它替换掉大脑写的 prompt
      verbatimPrompt: effective.verbatimPrompt ? this.db.lastUserText(conversationId) : null,
      turnAttachmentIds,
      emit: (event) => this.broadcast(conversationId, event),
      signal: controller.signal,
    };
  }

  /**
   * 执行一个工具并落库。
   *
   * `existingMessageId` 用于「确认后执行」：复用那张确认卡片所在的行，
   * 卡片就地变成结果卡片，而不是再冒出来一条。
   */
  private async executeTool(
    conversation: Conversation,
    plan: { tool: AgentToolName; args: Record<string, unknown>; say?: string },
    controller: AbortController,
    options: { existingMessageId?: string; confirmed?: boolean },
    turnAttachmentIds: string[] = [],
  ): Promise<ToolOutcome> {
    const conversationId = conversation.id;
    let callMessage: ChatMessage;
    if (options.existingMessageId) {
      this.db.updateMessage(options.existingMessageId, { confirm: null, toolResult: null, status: "pending" });
      callMessage = this.db.getMessage(options.existingMessageId)!;
    } else {
      callMessage = this.db.appendMessage({
        conversationId, role: "assistant", content: plan.say ?? null,
        plan: { tool: plan.tool, args: plan.args, ...(plan.say ? { say: plan.say } : {}) },
        toolName: plan.tool, toolArgs: plan.args,
      });
      this.broadcast(conversationId, { type: "plan", messageId: callMessage.id, plan: callMessage.plan! });
    }
    this.broadcast(conversationId, { type: "message", message: callMessage });

    const ctx = this.toolContext(conversation, controller, options, turnAttachmentIds);
    const outcome = await this.batch.callToolSafely({ tool: plan.tool, args: plan.args }, ctx);

    // §10.1 规则 1：产出图片的工具成功后，画布自动换成新产物
    const nextCanvas = canvasAfterProducing(conversation.canvasAssetIds, plan.tool, outcome.producedAssetId);
    if (!sameCanvasIds(nextCanvas, conversation.canvasAssetIds)) {
      this.db.updateConversation(conversationId, { canvasAssetIds: nextCanvas });
    }

    const toolMessage = this.db.appendMessage({
      conversationId, role: "tool", content: outcome.result.summary,
      toolName: plan.tool, toolResult: outcome.result,
      taskId: outcome.result.taskId ?? null, assetId: outcome.result.assetId ?? null,
      // 异步任务先挂 pending，等完成事件再定稿（§12.2）
      status: outcome.terminal ? "pending" : outcome.result.ok ? "ok" : "error",
      errorMessage: outcome.result.ok ? null : outcome.result.summary,
    });
    this.broadcast(conversationId, { type: "message", message: toolMessage });
    if (outcome.result.taskId) {
      this.broadcast(conversationId, {
        type: "progress", taskId: outcome.result.taskId,
        status: outcome.terminal ? "queued" : "succeeded", progress: outcome.terminal ? 0 : 100,
      });
    }
    return outcome;
  }

  // ── 大脑调用 ───────────────────────────────────────────────────────────────

  // ── 收尾 ───────────────────────────────────────────────────────────────────

  private supersedePendingConfirmations(conversationId: string) {
    for (const message of this.db.listPendingMessages(conversationId)) {
      if (!message.confirm) continue;
      this.db.updateMessage(message.id, { confirm: null, status: "error", errorMessage: "已被用户的新消息取代" });
      const updated = this.db.getMessage(message.id);
      if (updated) this.broadcast(conversationId, { type: "message", message: updated });
    }
  }

  private finishInterrupted(conversationId: string) {
    const note = this.db.appendMessage({ conversationId, role: "system", content: "已中断本轮处理" });
    this.broadcast(conversationId, { type: "message", message: note });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  private setStatus(conversationId: string, status: Conversation["status"]) {
    this.db.setConversationStatus(conversationId, status, { touch: false });
    this.broadcast(conversationId, { type: "status", status });
  }

  private reportTurnFailure(conversationId: string, error: unknown) {
    // 大脑这一侧的报错原样透传会把上游返回体（可能含 Base URL、请求片段）落进
    // SQLite 和界面，所以这类只留下翻译过的一句话，本地校验类错误才用原文
    const message = isBrainDown(error)
      ? `助手用不了了：${describeBrainFailure(error)}。检查一下「渠道配置」里的对话渠道。`
      : error instanceof AppError
        ? error.message
        : error instanceof Error ? error.message : "处理这一轮时出错了";
    const note = this.db.appendMessage({
      conversationId, role: "system", status: "error", content: message, errorMessage: message,
    });
    this.broadcast(conversationId, { type: "message", message: note });
    this.broadcast(conversationId, { type: "error", message });
    this.db.setConversationStatus(conversationId, "idle", { touch: false });
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }
}

