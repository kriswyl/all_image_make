/**
 * 参数核对与补救（需求.md 问题 1）。
 *
 * 现场是：对话里大脑写了 `size: "2K"`，而 gemini-content 适配器只认
 * `generationConfig.imageConfig.imageSize`，`size` 被静默丢弃 → 上游回 400
 * `Unsupported resolution: check the imageSize parameter`。
 * 用户在界面上完全看不出参数丢在哪一步，只能反复提示助手「记得带上尺寸」。
 *
 * 所以这里做两件事，都是纯函数、无 IO、好测：
 *  1. `auditParameters`：把「请求时写的」和「真正出网的 body」对账成几条人话，
 *     渲染在工具卡片上，让参数丢失/被默认值补全**看得见**。
 *  2. `isParameterRejection` + `planParameterSalvage`：给自动补救重试提供判据。
 *
 * 输入的 body 来自 `task.effectiveParameters`——那是**发送前**就落库的脱敏请求体
 * （tasks.ts 的 `requestForDiagnostic`），所以核对用的是既有的现成原料，
 * 不新增采集、不新增接口。
 */
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "../shared/types.js";
import type { AdapterType } from "../shared/types.js";
import type { ParamNote, ParamStatus } from "../shared/agent-types.js";

// 类型定义在 shared/agent-types.ts（前端卡片也要用），这里转出去方便服务端按模块引用
export type { ParamNote, ParamStatus };

type ParamKey = "size" | "aspectRatio" | "imageSize" | "resolution" | "duration";

interface ParamMapEntry {
  param: ParamKey;
  label: string;
  /** 该参数在出网 body 里的位置；null 表示这个适配器根本没有它的位置（写多少都白写） */
  path: string[] | null;
}

/**
 * gemini 的映射。注意最后两行——它们就是问题 1 的现场：
 * 适配器把 `size` 丢掉了，而告诉大脑「gemini 尺寸=1K|2K|4K」的能力清单
 * 又让人以为写 `size` 有用。`path: null` 会在卡片上标成 dropped。
 */
const GEMINI_MAP: ParamMapEntry[] = [
  { param: "aspectRatio", label: "宽高比", path: ["generationConfig", "imageConfig", "aspectRatio"] },
  { param: "imageSize", label: "尺寸", path: ["generationConfig", "imageConfig", "imageSize"] },
  { param: "size", label: "尺寸(size)", path: null },
];

/** OpenAI 系（images / chat-image / 兜底）都走 openAiImageParameters，位置就是顶层 */
const OPENAI_MAP: ParamMapEntry[] = [
  { param: "size", label: "尺寸", path: ["size"] },
  { param: "aspectRatio", label: "宽高比", path: null },
  { param: "imageSize", label: "尺寸(imageSize)", path: null },
];

const VIDEO_MAPS: Partial<Record<AdapterType, ParamMapEntry[]>> = {
  "wan-video": [
    { param: "resolution", label: "分辨率", path: ["parameters", "resolution"] },
    { param: "duration", label: "时长", path: ["parameters", "duration"] },
  ],
  "seedance-video": [
    { param: "resolution", label: "分辨率", path: ["resolution"] },
    { param: "duration", label: "时长", path: ["duration"] },
  ],
  "grok-video": [
    { param: "resolution", label: "分辨率", path: ["resolution"] },
    { param: "duration", label: "时长", path: ["duration"] },
  ],
  "kling-video": [
    { param: "resolution", label: "清晰度", path: ["size"] },
    { param: "duration", label: "时长", path: ["duration"] },
  ],
};

function paramMap(adapterType: AdapterType): ParamMapEntry[] {
  // MJ 的宽高比/负面词是提示词里的原生参数，没有独立字段，别报成“未发出”
  if (adapterType === "midjourney") return [];
  if (adapterType === "gemini-content") return GEMINI_MAP;
  const video = VIDEO_MAPS[adapterType];
  if (video) return video;
  return OPENAI_MAP;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 按路径取值，任何一层不是对象就当作没有 */
function readPath(body: unknown, path: string[]): unknown {
  let current: unknown = body;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** 只认「非空」，因为适配器都用 compact() 把 undefined / "" 剔掉 */
function present(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * 把「请求的参数」和「真正出网的 body」对账。
 *
 * @param adapterType 决定用哪张映射表
 * @param requested 请求时写的参数（**补默认值之前**的那份），只需带 size / aspectRatio / imageSize / resolution / duration
 * @param body 真正出网的请求体（`task.effectiveParameters`）
 */
export function auditParameters(
  adapterType: AdapterType,
  requested: Record<string, unknown>,
  body: Record<string, unknown> | null | undefined,
): ParamNote[] {
  const payload = isRecord(body) ? body : {};
  const notes: ParamNote[] = [];

  for (const entry of paramMap(adapterType)) {
    const asked = present(requested[entry.param]);
    const sent = entry.path ? present(readPath(payload, entry.path)) : undefined;

    if (asked !== undefined) {
      if (entry.path === null) {
        notes.push({ label: entry.label, value: asked, status: "dropped", hint: `这个适配器不认 ${entry.param}，写多少都发不出去` });
      } else if (sent === undefined) {
        notes.push({ label: entry.label, value: asked, status: "dropped", hint: "请求体里没有这个字段" });
      } else {
        // 用 body 里的值而不是请求值：rawParameters 可能把它盖掉，如实显示最终发出去的
        notes.push({ label: entry.label, value: sent, status: "applied" });
      }
      continue;
    }

    // 没请求却有值 = 被默认值补上的。这正是要显式说出来的一类（「尺寸：2K（默认）」）
    if (sent !== undefined) notes.push({ label: entry.label, value: sent, status: "defaulted" });
  }

  return notes;
}

/**
 * 上游因为参数问题拒绝的判据。
 *
 * **只认参数类的具体措辞**，5xx / 超时 / 网络错误一律不认——补救重试会真的再发一次
 * 请求、再花一次钱，所以宁可漏判也不能误判。另外几个「定义上就不该重试」的错误码
 * 直接排除：超时再发一次大概率还是超时，断流是我们自己没解析出来而非上游拒绝。
 */
const NEVER_SALVAGE_CODES = new Set([
  "REQUEST_TIMEOUT",
  "TASK_WAIT_TIMEOUT",
  "TASK_ABORTED",
  "RESPONSE_PARSE_FAILED",
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "CHANNEL_NOT_FOUND",
  "MODEL_NOT_FOUND",
  "NO_IMAGE_CHANNEL",
]);

const PARAM_REJECTION_PATTERN = new RegExp([
  "unsupported\\s+(resolution|image[_ ]?size|aspect)",
  "invalid\\s+(image[_ ]?size|aspect[_ ]?ratio|resolution|param)",
  "image[_ ]?size\\s+parameter",
  "aspect[_ ]?ratio.{0,20}(must|invalid|unsupported|error)",
  "不支持的?\\s*(分辨率|尺寸|宽高比|参数)",
  "参数.{0,4}(无效|不合法|错误)",
].join("|"), "i");

export function isParameterRejection(errorCode: string | null | undefined, errorMessage: string | null | undefined): boolean {
  if (errorCode && NEVER_SALVAGE_CODES.has(errorCode)) return false;
  if (!errorMessage) return false;
  return PARAM_REJECTION_PATTERN.test(errorMessage);
}

export interface ParameterSalvage {
  /** 打回 GenerationInput 的补丁 */
  patch: { imageSize?: string; aspectRatio?: string };
  /** 卡片上要写清楚「这一次是补了什么重试的」 */
  note: string;
}

/**
 * 决定「参数被上游拒绝后，能补什么再试一次」。
 *
 * 目前只有一处补法：gemini 的 `imageSize` 必须带，而大脑极可能自己编一个
 * `8K` / `1024x1024` 之类的值。补成设置里的默认值（2K）再试一次是有意义的；
 * 其它参数（宽高比、OpenAI 的 size）没有安全的兜底值——替用户决定画面形状
 * 比失败更糟，所以返回 null 让它老老实实失败。
 *
 * 判据只看**真正出网的 body**，不看请求参数：补的价值在于「发出去的那个值不对」，
 * 而请求参数在被 compact() 剔掉之后已经不代表实际情况了。
 *
 * @param defaultSize 设置里的默认尺寸；等于已经发出去的值时说明补也白补，返回 null
 */
export function planParameterSalvage(
  adapterType: AdapterType,
  body: Record<string, unknown> | null | undefined,
  defaultSize: string | null | undefined,
): ParameterSalvage | null {
  if (adapterType !== "gemini-content") return null;
  // 兜底值本身也得是合法的，否则补进去只是把「缺失」换成「非法」，白花一次钱
  const fallback = normalizeImageSize(defaultSize) ?? DEFAULT_IMAGE_SIZE;
  const sent = present(readPath(isRecord(body) ? body : {}, ["generationConfig", "imageConfig", "imageSize"]));
  // 发出去的就是兜底值，再发一次不会有不同结果
  if (sent !== undefined && sent === fallback) return null;
  return {
    patch: { imageSize: fallback },
    note: sent === undefined
      ? `请求体里没有尺寸，已补上 ${fallback} 重试一次`
      : `尺寸 ${sent} 被上游拒绝，已改用 ${fallback} 重试一次`,
  };
}
