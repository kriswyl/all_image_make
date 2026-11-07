import type { AppDatabase } from "../db.js";
import {
  parsePageCountIntent, totalize, type PresentationSpec, type StructureRequirement,
} from "../../shared/presentation-spec.js";
import type { ChatToolResult } from "./registry.js";

const FORK_PATTERN = /另做一份|新做一份|重新做一份|另起一份/i;
/**
 * 「重新做整份资料」是另一个任务，不能继承上一份的页数约束。
 * 注意不能只写「重做 / 重新」：用户说「重做第 3 页」时那是修改，不是新任务。
 */
const NEW_TASK_PATTERN = /重新.{0,10}(?:整份|全部)|(?:整份|全部)资料.{0,10}(?:重做|重新|另做|做成)|从头(?:再)?做一?[份个]|另有(?:一份|个)任务/i;
const START_PATTERN = /^(?:请)?(?:开始|继续|按上面的要求|照之前|生成吧|制作吧|做个?出来)[。！!\s]*$/i;
/**
 * 过程指令不是页面内容要求。把它塞进 requiredContent 会让门禁去正文里找
 * 「先不生成」这种句子，永远匹配不到，产物就永久停在草稿。
 */
const PROCESS_INSTRUCTION = /^(?:先不生成|先别生成|先不用生成|不要生成|暂不生成|直接生成|开始|继续|换风格|换个风格|换成.{0,8}风|按上面的要求|照之前)/;
/** 「保留 N 个案例」是结构要求，由页面职责计划核对，不逐字匹配正文。 */
const CASE_COUNT_PATTERN = /(?:保留|至少|包含|要有|需要|覆盖)\s*([一二两三四五六七八九十\d]+)\s*个?\s*案例/;
/**
 * 封面要求由 Spec 的 `cover` 字段表达，不是页面上的文字。
 * 只要条目里提到封面（「含封面」「封面」「封面计入」），就按结构处理；
 * 把它当必需内容去正文找，同样会让产物永久停在草稿。
 */
const COVER_REQUIREMENT = /封面/;
/**
 * 「检查完成再交付」是交付策略，不是页面内容要求（第 6 条决策）。
 * 识别到就写进 Spec，发布层据此等待视觉检查。
 */
const BEFORE_PUBLISH_PATTERN = /(?:检查|审校|视觉检查).{0,6}(?:完成|通过).{0,6}(?:再|才)?(?:交付|发布|给我)|(?:先|必须).{0,4}(?:检查|审校).{0,4}(?:再|后)?(?:交付|发布)/;
/**
 * 整句任务指令（「把这份 18 章文档整理成 10 页 PPT」）描述的是要做什么，
 * 不是页面必须逐字出现的内容。模型常把这类句子填进 requiredContent，
 * 而它当然「逐字出现在用户消息里」，所以逐字回读挡不住它。
 */
const TASK_INSTRUCTION = /(?:做成|整理成|整理为|生成|输出|制作|转成|转换为|改成|改为|换成|删掉|删除|增加一页)/;
const LEADING_COMMAND = /^(?:把|请|帮我|麻烦|需要|我想|给我|这份|这个)/;
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function parseCountToken(token: string): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  if (token === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + (CN_DIGITS[token[1]!] ?? 0);
  if (/^[一二两三四五六七八九]十$/.test(token)) return (CN_DIGITS[token[0]!] ?? 0) * 10;
  return CN_DIGITS[token];
}

/**
 * 真实链路暴露的跨轮缺口：用户第一轮说「做成 10 页，先不生成」，下一轮只说「开始」，
 * 此时模型才调用契约工具，当前消息里没有任何页数。只看当前消息会生成一个
 * 「未指定页数」的 Spec，页数就退化成模型自己靠大纲维持。
 * 这里在会话尚无 PPT 产物时，回溯最近的用户消息取最后一个明确页数，证据绑定原消息 id。
 */
export function resolvePageIntentFromHistory(
  db: AppDatabase, conversationId: string, text: string, sourceMessageId: string,
) {
  const direct = parsePageCountIntent(text, sourceMessageId);
  if (direct) return direct;
  if (db.listWorkspaceDocuments(conversationId).some(file => /\.pptx$/i.test(file.name))) return undefined;
  const history = db.listMessages(conversationId)
    .filter(message => message.role === "user" && typeof message.content === "string" && message.content.trim())
    .slice(-5).reverse();
  for (const message of history) {
    const found = parsePageCountIntent(String(message.content), message.id);
    if (found) return found;
  }
  return undefined;
}

export type SpecResolution = {
  spec: PresentationSpec | null;
  /** 多个合理目标时不能盲选，交给用户明确 */
  conflict?: string;
  created?: boolean;
};

/**
 * 定位本次 PPT 任务绑定的契约。
 *
 * 优先级：断点绑定 > 显式分叉 > 唯一 prepared/active 任务 > 当前消息新建。
 * 明确「另做一份」时不继承；存在多个候选时返回 conflict，不猜最后一个。
 */
export function resolvePresentationSpec(
  db: AppDatabase, conversationId: string, text: string, sourceMessageId: string,
  resume?: { specId?: string; specRevision?: number } | null,
): SpecResolution {
  if (resume?.specId) {
    // 断点绑定的契约也必须校验归属，避免旧会话的 specId 串进来。
    const bound = resume.specRevision
      ? db.specs.ownedRevision(conversationId, resume.specId, resume.specRevision)
      : (() => { try { return db.specs.requireOwned(conversationId, resume.specId!); } catch { return null; } })();
    if (bound) return { spec: bound };
  }
  if (FORK_PATTERN.test(text) || NEW_TASK_PATTERN.test(text)) {
    // 新任务必须拿到新的 specId，并且把上一份 active/prepared 契约收尾，
    // 否则发布门禁会误用旧任务的页数去卡新产物。旧 revision 与 family 绑定仍保留。
    for (const previous of db.specs.listPrepared(conversationId)) {
      db.specs.setLifecycleOwned(conversationId, previous.specId, "completed");
    }
    const intent = parsePageCountIntent(text, sourceMessageId);
    const spec = db.specs.create({
      conversationId,
      ...(intent ? {
        pageCount: { ...intent.constraint, evidence: intent.evidence },
        pageCountBasis: intent.basis,
      } : {}),
      sourceMessageId, origin: "user",
      reason: FORK_PATTERN.test(text) ? "用户要求另做一份" : "用户发起新的制作任务",
    });
    return { spec, created: true };
  }
  const intent = parsePageCountIntent(text, sourceMessageId);
  const candidates = db.specs.listPrepared(conversationId);
  // 多个候选时连「开始」也不能猜：做错一份比多问一句代价大得多。
  if (candidates.length > 1) {
    return {
      spec: null,
      conflict: START_PATTERN.test(text.trim())
        ? "当前会话有多份待制作的 PPT 要求，请指明要继续哪一份，或说明「另做一份」。"
        : "当前会话有多份待制作的 PPT 要求，请指明要修改哪一份，或说明「另做一份」。",
    };
  }
  if (candidates.length === 1) {
    const target = candidates[0]!;
    // 本轮显式页数是修订，不能因为「已有一份契约」就把它丢掉。
    if (intent && JSON.stringify(target.pageCount) !== JSON.stringify({ ...intent.constraint, evidence: intent.evidence })) {
      return {
        spec: db.specs.updateOwned(conversationId, target.specId, {
          pageCount: { ...intent.constraint, evidence: intent.evidence },
          pageCountBasis: intent.basis,
        }, "用户在本轮修改页数要求", sourceMessageId),
        created: false,
      };
    }
    return { spec: target };
  }
  const spec = createSpecFromMessage(db, conversationId, text, sourceMessageId);
  return { spec, created: Boolean(spec) };
}

function createSpecFromMessage(db: AppDatabase, conversationId: string, text: string, sourceMessageId: string): PresentationSpec | null {
  const intent = resolvePageIntentFromHistory(db, conversationId, text, sourceMessageId);
  if (!intent && !/必需|必须保留|一定要|不能少/.test(text)) return null;
  return db.specs.create({
    conversationId,
    ...(intent ? {
      pageCount: { ...intent.constraint, evidence: intent.evidence },
      pageCountBasis: intent.basis,
    } : {}),
    sourceMessageId,
    reason: intent ? "从当前消息解析页数要求" : "从当前消息解析必需内容要求",
  });
}

export type SpecUpdateArgs = {
  intent?: "create" | "update" | "fork";
  specId?: string;
  prepareOnly?: boolean;
  pageCountText?: string;
  requiredContent?: string[];
  styleText?: string;
};

/**
 * 轻量原生工具：只保存/更新任务契约，不触发生成，也不发起额外意图模型请求。
 * 证据由服务端从当前用户消息回读，模型提供的原话只用于交叉校验。
 */
export function runPresentationSpecUpdate(
  db: AppDatabase, conversationId: string, text: string, sourceMessageId: string, raw: string,
): ChatToolResult {
  let args: SpecUpdateArgs;
  try { args = JSON.parse(raw) as SpecUpdateArgs; }
  catch { return { ok: false, summary: "任务契约参数必须是有效 JSON" }; }
  if (args.pageCountText && !text.includes(args.pageCountText)) {
    return { ok: false, summary: "提供的页数原话不在当前用户消息中，未保存契约" };
  }
  // 显式的「另做一份」不从历史继承页数；其余执行消息允许回溯上一轮的明确要求。
  const intent = args.intent === "fork" ? undefined : resolvePageIntentFromHistory(db, conversationId, text, sourceMessageId);
  const pageCount = intent ? { ...intent.constraint, evidence: intent.evidence } : undefined;
  // 用户说「必须保留三个案例」时，具体案例内容在源资料里、不在用户消息里。
  // 此时用消息中确有的那句明确要求作为证据，item 只作为指向源材料的描述，
  // 不要求逐字出现在聊天文本中；没有明确要求时仍坚持逐字回读，避免模型把推断升级成硬约束。
  const explicitRequirement = /必须保留[^，。；\n]*|必需[^，。；\n]*|不能少[^，。；\n]*|一定要[^，。；\n]*/.exec(text)?.[0];
  const accepted = args.requiredContent ?? [];
  // 把「过程指令 / 数量型结构要求 / 可逐字验证的内容」分开：只有最后一类才进 requiredContent。
  const structure: StructureRequirement[] = [];
  const kept: string[] = [];
  let cover: "include" | undefined;
  const squash = (value: string) => value.replace(/[\s\p{P}]/gu, "");
  for (const raw of accepted) {
    const item = raw.trim();
    if (!item || PROCESS_INSTRUCTION.test(item)) continue;
    const counted = CASE_COUNT_PATTERN.exec(item);
    if (counted) {
      const value = parseCountToken(counted[1]!);
      if (value) {
        structure.push({ kind: "case_count", value, evidence: { sourceMessageId, text: explicitRequirement ?? item } });
        continue;
      }
    }
    if (COVER_REQUIREMENT.test(item)) { cover = "include"; continue; }
    // 只接收「用户确实说过」的文本。模型经常把自己总结的执行要点
    //（例如「18 个模块归纳压缩进 10 页」「保留免责说明：…」）当成必需内容传进来，
    // 这些句子不会逐字出现在页面上，接收它们等于让产物永久停在草稿。
    // 带引号时按引号内文本核对，便于「保留这句：『…』」这类表述。
    const quoted = /[「"“]([^」"”]{2,120})[」"”]/.exec(item)?.[1];
    const target = quoted ?? item;
    if (!text.includes(target)) continue;
    // 引号内的文本是用户明确要保留的原话，可以照收；没有引号时，
    // 整句任务指令（含「整理成/做成…」或以「把/请/帮我」开头）不是页面内容。
    if (!quoted && (squash(item) === squash(text) || TASK_INSTRUCTION.test(item) || LEADING_COMMAND.test(item))) continue;
    kept.push(target);
  }
  const requiredContent = kept.map((item, index) => ({
    id: `required-${index + 1}`,
    evidence: { sourceMessageId, text: explicitRequirement ?? item },
    description: item,
    placement: "visible" as const,
    sourceRefs: [],
    // 「N 个案例」这种数量句已在上面转成结构要求，不会走到这里；
    // 具体案例标题（如「案例 A：…」）仍应逐字核对，所以保留「案例」关键词。
    verification: /数值|单位|数字|案例|\d/.test(item) ? "deterministic" as const : "semantic" as const,
  }));

  const patch = {
    ...(pageCount ? { pageCount, pageCountBasis: intent?.basis ?? "total" as const } : {}),
    ...(requiredContent.length ? { requiredContent } : {}),
    ...(structure.length ? { structure } : {}),
    ...(cover ? { cover } : {}),
    ...(BEFORE_PUBLISH_PATTERN.test(text) ? { visualPolicy: "before_publish" as const } : {}),
    ...(args.styleText && text.includes(args.styleText) ? { styleRequest: { sourceMessageId, text: args.styleText } } : {}),
  };
  const updating = args.intent !== "fork" && args.intent !== "create" && Boolean(args.specId);
  let spec: PresentationSpec;
  try {
    spec = updating
      // 模型可以自由填写 specId，因此更新前必须校验会话归属。
      ? db.specs.updateOwned(conversationId, args.specId!, patch, "更新任务要求", sourceMessageId)
      : db.specs.create({
        conversationId, ...patch, sourceMessageId,
        reason: args.intent === "fork" ? "用户要求另做一份" : "保存任务要求",
      });
  } catch (error) {
    // 越权或不存在都当成失败的工具结果返回，不要把它抛成系统异常。
    return { ok: false, summary: error instanceof Error ? error.message : "任务契约更新失败" };
  }
  if (!args.prepareOnly) db.specs.setLifecycleOwned(conversationId, spec.specId, "active");
  const constraint = spec.pageCount ? totalize(spec.pageCount, spec.pageCountBasis) : undefined;
  return {
    ok: true,
    summary: `${args.prepareOnly ? "已保存要求，暂不生成" : "已记录任务要求"}：${constraint ? `页数 ${JSON.stringify(constraint)}` : "未指定页数"}`
      + `${requiredContent.length ? `，必需内容 ${requiredContent.length} 项` : ""}`
      + `${structure.length ? `，结构要求 ${structure.map(item => `${item.value} 个案例`).join("、")}` : ""}`
      + `${cover ? "，含封面" : ""}`
      + `${spec.visualPolicy === "before_publish" ? "，要求视觉检查完成后再交付" : ""}。`,
    data: { specId: spec.specId, specRevision: spec.revision },
  };
}
