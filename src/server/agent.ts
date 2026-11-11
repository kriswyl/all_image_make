/**
 * 编排对话轮次、用户确认、会话状态和 SSE 广播。
 * 客户端断开后，已经提交的任务仍可回写结果并按会话状态续跑。
 */
import {
  AUTO_TITLE_MAX_CHARS, DEFAULT_CONVERSATION_TITLE, usesPlainChat,
  type AgentStreamEvent, type AgentToolName, type ChatMessage, type ChatVideoFrames,
  type ConfirmPreview, type Conversation, type ConversationView,
} from "../shared/agent-types.js";
import { midjourneyUsableButtons } from "../shared/midjourney.js";
import { isImageAsset } from "../shared/types.js";
import { BatchExecutor } from "./agent-batch.js";
import { describeBrainFailure, isBrainDown, isBrainTimeout, isFatalBrainError } from "./agent-brain-errors.js";
import { BrainRunner } from "./agent-brain.js";
import { AgentConfirmationService } from "./agent-confirmation.js";
import { collectTurnAttachmentIds } from "./agent-context.js";
import { AgentLegacyTurnRunner } from "./agent-legacy-turn.js";
import { runNativeTurn } from "./agent-native-turn.js";
import { finishNativeTask, recoverStaleConversations, settleFinishedTasks, type RecoveryHost } from "./agent-recovery.js";
import { handleTaskEvent } from "./agent-task-events.js";
import type { ToolContext, ToolOutcome } from "./agent-tools.js";
import { isVisionBlocked } from "./agent-vision.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { AppDatabase } from "./db.js";
import type { KeyStore } from "./key-store.js";
import { PresentationCoordinator } from "./presentation-coordinator.js";
import type { PresentationAction } from "./presentation-revision.js";
import { AppError, type TaskRunner } from "./tasks.js";

// 测试和外部调用仍从 `agent.ts` 导入这些纯函数，保留原来的入口
export {
  BATCHABLE_TOOLS, extractPlanText, parsePlan, repairPlan, resolveBatch, salvagePlan,
} from "./agent-plan.js";
export {
  mergeConfirmArgs, shouldConfirm, withConfirmedVideoSelection,
} from "./agent-confirm.js";
export { buildSystemPrompt } from "./agent-prompt.js";
export { collectTurnAttachmentIds, looksLikeIdentityDrift, toBrainMessage } from "./agent-context.js";
export {
  MAX_ROUNDS, MAX_AUTO_CONTINUE, MAX_SESSION_TASKS, MAX_PARSE_RETRY,
  MAX_VISION_READS_PER_ROUND, MAX_VISION_IMAGES,
} from "./agent-constants.js";

export type TurnTrigger = "user" | "task_finished" | "confirmation" | "recovered";

export class AgentService {
  /** 每个会话的 SSE 订阅者。HTTP 断开会退订，但会话本身继续跑（§12.2） */
  private readonly listeners = new Map<string, Set<(event: AgentStreamEvent) => void>>();
  /** 正在跑的那一轮。同一会话同时只允许一轮（§16 串行） */
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly detachRunner: () => void;
  private readonly batch: BatchExecutor;
  private readonly confirmations: AgentConfirmationService;
  private readonly brain: BrainRunner;
  private readonly legacy: AgentLegacyTurnRunner;
  private readonly presentations: PresentationCoordinator;

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
    this.legacy = new AgentLegacyTurnRunner({
      db: this.db,
      batch: this.batch,
      brain: this.brain,
      defaultAliases: () => this.defaultAliases(),
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
      setStatus: (conversationId, status) => this.setStatus(conversationId, status),
      finishInterrupted: (conversationId) => this.finishInterrupted(conversationId),
      stopOnUnknownSubmission: (conversationId, outcomes) => this.stopOnUnknownSubmission(conversationId, outcomes),
    });
    this.confirmations = new AgentConfirmationService({
      db: this.db,
      batch: this.batch,
      hasActiveTurn: (conversationId) => this.isRunning(conversationId),
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
      setStatus: (conversationId, status) => this.setStatus(conversationId, status),
      launchConfirmedTurn: (conversationId, run) => this.launchConfirmedTurn(conversationId, run),
      executeTool: (conversation, plan, controller, options) => this.executeTool(conversation, plan, controller, options),
      resumeNativeTurn: (conversation, controller) => this.turn(conversation.id, null, "recovered", controller, [], conversation),
      resumeLegacyTurn: (conversationId, controller) => this.legacy.run(conversationId, "confirmation", controller, 1),
      finishInterrupted: (conversationId) => this.finishInterrupted(conversationId),
      finishAfterBrainLoss: (conversationId, note) => this.finishAfterBrainLoss(conversationId, note),
      settleFinishedTasks: (conversationId) => this.settleFinishedTasks(conversationId),
      stopOnUnknownSubmission: (conversationId, outcomes) => this.stopOnUnknownSubmission(conversationId, outcomes),
    });
    this.detachRunner = runner.onTaskEvent((event) => handleTaskEvent(this.taskEventHost(), event));
    this.presentations = new PresentationCoordinator(db, (conversationId, event) => this.broadcast(conversationId, event));
  }

  private taskEventHost(): RecoveryHost {
    const host: RecoveryHost = {
      db: this.db,
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
      hasActiveTurn: (conversationId) => this.isRunning(conversationId),
      startTurn: (conversationId, text, trigger) => this.startTurn(conversationId, text, trigger),
      startRecoveredTurn: (conversationId) => this.startTurn(conversationId, null, "recovered"),
      reportTurnFailure: (conversationId, error) => this.reportTurnFailure(conversationId, error),
      finishNativeTask: (conversation, pending, operation, result, state) =>
        finishNativeTask(host, conversation, pending, operation, result, state),
    };
    return host;
  }

  dispose() {
    this.detachRunner();
    this.presentations.dispose();
    this.db.workflows.releaseOwned();
    for (const controller of this.activeTurns.values()) controller.abort();
    this.activeTurns.clear();
    this.listeners.clear();
  }

  isRunning(conversationId: string) {
    return this.activeTurns.has(conversationId);
  }

  retryPresentationCheck(conversationId: string, fileId: string, sha256: string) {
    this.presentations.retryPresentationCheck(conversationId, fileId, sha256);
  }

  async applyPresentationAction(conversationId: string, fileId: string, sha256: string, action: PresentationAction) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (conversation.toolScope === "conversation") throw new AppError("TOOLS_DISABLED", "请在对话设置中开启工具", 409);
    if (this.activeTurns.has(conversationId) || conversation.status !== "idle") throw new AppError("TURN_IN_FLIGHT", "当前会话正在处理，请稍候", 409);
    const version = this.db.getPresentationVersion(conversationId, fileId);
    if (!version) throw new AppError("DOCUMENT_NOT_FOUND", "找不到可操作的 PPT 版本", 404);
    if (version.sha256 !== sha256) throw new AppError("DOCUMENT_CHANGED", "PPT 文件版本已变化", 409);
    if (action.kind === "review" && (!conversation.visionEnabled || isVisionBlocked(this.db, conversation))) throw new AppError("VISION_DISABLED", "请先开启看图并选择支持图片输入的对话模型", 409);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    this.setStatus(conversationId, "running");
    try {
      return await this.presentations.applyAction({
        conversation, fileId, sha256, action, signal: controller.signal,
        callModel: (messages, options) => this.brain.callBrainRaw(conversation, messages, controller, conversationId, options),
        isCurrent: () => this.activeTurns.get(conversationId) === controller,
      });
    } finally {
      if (this.activeTurns.get(conversationId) === controller) {
        this.activeTurns.delete(conversationId);
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
      }
    }
  }

  /** 中断当前这一轮。任务已经提交出去的部分照常跑完，只是大脑不再往下规划 */
  interrupt(conversationId: string) {
    const controller = this.activeTurns.get(conversationId);
    if (!controller) return false;
    this.db.clearNativeTurnCheckpoint(conversationId);
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
      visionBlocked: isVisionBlocked(this.db, conversation),
      contextSummary: this.db.getContextSummary(conversationId),
      // 老消息里没有 MJ 按钮；读视图时从任务 meta 补上，历史结果也能直接继续 U/V/R
      messages: this.db.listMessagesAfter(conversationId, 0).map((message) => this.withMidjourneyButtons(message)),
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

  /** 老 MJ 结果没有把按钮写进消息；视图层从任务 meta 补，不改库 */
  private withMidjourneyButtons(message: ChatMessage): ChatMessage {
    const result = message.toolResult;
    const taskId = result?.taskId;
    const data = result?.data;
    if (!taskId || !data || typeof data.model !== "string" || !data.model.startsWith("mj_")) return message;
    if (Array.isArray(data.midjourneyButtons)) return message;
    const task = this.db.getTaskView(taskId);
    const buttons = midjourneyUsableButtons(task?.remoteMeta?.midjourney?.buttons ?? []);
    if (!buttons.length) return message;
    return {
      ...message,
      toolResult: { ...result, data: { ...data, midjourneyButtons: buttons, midjourneyTaskId: taskId } },
    };
  }

  // ── 对外入口 ───────────────────────────────────────────────────────────────

  /**
   * 开始一轮。**立即返回**，产出全部走 SSE（§14）。
   *
   * 抛出的异常只有「本地就能判定」的那几种（会话不存在、上一轮没结束），
   * 大脑和上游的错误一律变成 `error` 事件推给前端。
   */
  startTurn(conversationId: string, text: string | null, trigger: TurnTrigger, assetRefs: string[] = [], videoFrames?: ChatVideoFrames) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (this.activeTurns.has(conversationId)) {
      throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);
    }
    if (text !== null) this.db.clearNativeTurnCheckpoint(conversationId);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    void this.turn(conversationId, text, trigger, controller, assetRefs, conversation, videoFrames)
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

  /** 手动压缩只整理历史，不启动创作循环或提交生成任务。 */
  async compressNow(conversationId: string) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (this.activeTurns.has(conversationId)) throw new AppError("TURN_IN_FLIGHT", "当前会话正在处理，请稍候", 409);
    if (conversation.status === "waiting_task") throw new AppError("TASK_IN_FLIGHT", "当前有任务等待自动续跑，请等任务结束后再手动压缩", 409);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    try {
      return await this.brain.prepareCompression(conversation, controller, [], true);
    } finally {
      this.activeTurns.delete(conversationId);
      const latest = this.db.getConversation(conversationId);
      if (latest) this.broadcast(conversationId, { type: "done", status: latest.status });
    }
  }

  resolveConfirmation(
    conversationId: string,
    messageId: string,
    decision: "approve" | "reject",
    argsOverride?: Record<string, unknown>,
  ) {
    return this.confirmations.resolveConfirmation(conversationId, messageId, decision, argsOverride);
  }

  private launchConfirmedTurn(conversationId: string, run: (controller: AbortController) => Promise<void>) {
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    void run(controller)
      .catch((error) => this.reportTurnFailure(conversationId, error))
      .finally(() => {
        this.activeTurns.delete(conversationId);
        if (this.db.getConversation(conversationId)?.status === "waiting_task") this.settleFinishedTasks(conversationId);
      });
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
    turnConversation: Conversation,
    videoFrames?: ChatVideoFrames,
  ) {
    const plain = usesPlainChat(turnConversation);
    let userMessage: ChatMessage | null = null;
    // 这一轮附带的图只算一次：工具执行到最后一条消息已经是助手计划行，
    // 再回头扫数据库找不到用户那几条，所以必须在这里锁住并一路传下去
    let turnAttachmentIds: string[] = [];
    if (text !== null) {
      // 引用的一组装在**同一条消息**上：用户拖了三张图说了句话，界面上就是一条气泡
      // 配三张缩略图，而不是四条消息
      userMessage = this.db.appendMessage({ conversationId, role: "user", content: text, assetRefs, videoFrames });
      turnAttachmentIds = collectTurnAttachmentIds(this.db, conversationId, userMessage.seq);
      this.broadcast(conversationId, { type: "message", message: userMessage });
      this.nameFromFirstMessage(conversationId, text);
      this.db.resetAutoContinue(conversationId);
      this.confirmations.supersedePendingConfirmations(conversationId, plain);
    }
    this.setStatus(conversationId, "running");
    try {
      if (trigger !== "recovered") await this.brain.prepareCompression(turnConversation, controller, turnAttachmentIds);
      if (plain) {
        return await runNativeTurn({
          db: this.db,
          brain: this.brain,
          presentations: this.presentations,
          confirmations: this.confirmations,
          toolContext: (conversation, controller) => this.toolContext(conversation, controller, {}),
          defaultAliases: () => this.defaultAliases(),
          broadcast: (conversationId, event) => this.broadcast(conversationId, event),
          setStatus: (conversationId, status) => this.setStatus(conversationId, status),
          finishInterrupted: (conversationId) => this.finishInterrupted(conversationId),
        }, { turnConversation, text, userMessage, controller, turnAttachmentIds, recovering: trigger === "recovered" });
      }
      await this.legacy.run(conversationId, trigger, controller, 0, turnAttachmentIds);
    } catch (error) {
      if (controller.signal.aborted) return this.finishInterrupted(conversationId);
      // §15 直通模式。只在「这一轮什么也没发生」时才降级：如果大脑已经跑了几轮、
      // 图也画了，那问题就不在「大脑连不上」，再兜一次只会让上下文更乱。
      if (!plain && userMessage && isBrainDown(error) && !controller.signal.aborted
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

  private stopOnUnknownSubmission(conversationId: string, outcomes: ToolOutcome[]): boolean {
    if (!outcomes.some(outcome => outcome.result.error === "SUBMISSION_UNKNOWN")) return false;
    this.finishAfterBrainLoss(conversationId, "生成提交状态待核对。请在渠道确认原请求的结果后再决定是否重新生成。");
    return true;
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

  recoverStaleConversations(): number {
    return recoverStaleConversations(this.taskEventHost());
  }

  private settleFinishedTasks(conversationId: string) {
    settleFinishedTasks(this.taskEventHost(), conversationId);
  }

  /**
   * 用户在设置里挑的默认生图 / 生视频模型（需求.md 问题 5），存的是 alias。
   *
   * 只在**大脑没点名**时才起作用（见 `resolveAlias`），空串按「没设」处理。
   * 存 alias 的代价是渠道被停用后它会失效，但那是正常情况而不是错误——
   * `resolveAlias` 会如实退回并标记出来，不假装一切正常。
   */
  private defaultAliases(): { image?: string; video?: string; music?: string; speech?: string } {
    // 旧版三个音频共用一个默认值；新键没设时把它同时交给音乐和语音，
    // 工具自己会按适配器筛掉不匹配的那个（写歌只认 suno，朗读只认 tts）。
    const legacyAudio = this.db.getSetting("agentDefaultAudioAlias") ?? "";
    // 用 ?? 而不是 ||：用户把新键显式清成空串时，不该再把旧值捡回来
    const music = this.db.getSetting("agentDefaultMusicAlias") ?? legacyAudio;
    const speech = this.db.getSetting("agentDefaultSpeechAlias") ?? legacyAudio;
    return {
      ...(this.db.getSetting("agentDefaultImageAlias") ? { image: this.db.getSetting("agentDefaultImageAlias")! } : {}),
      ...(this.db.getSetting("agentDefaultVideoAlias") ? { video: this.db.getSetting("agentDefaultVideoAlias")! } : {}),
      ...(music ? { music } : {}),
      ...(speech ? { speech } : {}),
    };
  }

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
    options: { existingMessageId?: string; confirmed?: boolean; strictSubmission?: boolean; backgroundMedia?: boolean },
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
    const outcome = await this.batch.callToolSafely({ tool: plan.tool, args: plan.args }, {
      ...ctx, operationId: callMessage.id, strictSubmission: options.strictSubmission, backgroundMedia: options.backgroundMedia,
    });

    // 新产物不自动进画布：画布是用户这一轮明确挑的图，生成结果先去素材库。
    const toolMessage = this.db.appendMessage({
      conversationId, role: "tool", content: outcome.result.summary,
      toolName: plan.tool, toolResult: { ...outcome.result, data: { ...outcome.result.data, agentOperationId: callMessage.id } },
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

  // ── 收尾 ───────────────────────────────────────────────────────────────────

  private finishInterrupted(conversationId: string) {
    this.db.clearNativeTurnCheckpoint(conversationId);
    this.db.interruptNativeToolCalls(conversationId);
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
    this.db.clearNativeTurnCheckpoint(conversationId);
    this.db.interruptNativeToolCalls(conversationId);
    // 大脑这一侧的报错原样透传会把上游返回体（可能含 Base URL、请求片段）落进
    // SQLite 和界面，所以这类只留下翻译过的一句话，本地校验类错误才用原文
    const message = isBrainTimeout(error)
      ? "对话模型思考超时了。可以把剧本拆短一点 / 少要求一些细节，或者到模型设置换一个非推理模型再试。"
      : isBrainDown(error)
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

