import { z } from "zod";
import type { BrainToolSpec } from "../brain.js";
import { CHAT_TOOL_GROUPS, type ChatTool, type ChatToolGroup, type ChatToolRegistry } from "./registry.js";

/**
 * 能力发现。
 *
 * 统一入口不再把所有工具一次性塞给模型：每轮只装「这一轮大概率用得上」的组，
 * 其余能力通过 capability_search 查找，查到后下一轮注入。
 *
 * 这样做不是省几个字符，而是减少相邻工具选错：模型面前同时有 15 个工具时，
 * `generate_image` / `edit_image` / `doc_convert` 之间误选的概率明显上升。
 */

const searchSchema = z.object({
  query: z.string().trim().min(1).max(200).describe("用户目标或能力关键词，例如「做一份 PPT」「给视频配字幕」"),
  groups: z.array(z.enum(CHAT_TOOL_GROUPS)).max(CHAT_TOOL_GROUPS.length).optional().describe("已知能力组时直接指定，可跳过关键词匹配"),
}).strict();

export const capabilitySearchSpec: BrainToolSpec = {
  type: "function",
  function: {
    name: "capability_search",
    description: "当前工具组不足时使用：按用户目标查找并开启下一轮可用的能力（文档、图片、视频、音乐、配音、模板、画布工具）。只查目录，不执行任务、不产生费用。拿到结果后，下一轮直接调用被开启的工具。",
    parameters: z.toJSONSchema(searchSchema),
  },
};

const GROUP_LABELS: Record<ChatToolGroup, string> = {
  core: "基础",
  docs: "文档与 PPT",
  image: "图片生成与编辑",
  video: "视频生成",
  audio: "音乐与配音",
  templates: "画布模板与分镜",
  utility: "画布指针与提示词",
};

const GROUP_HINTS: Record<Exclude<ChatToolGroup, "core">, RegExp> = {
  docs: /(word|docx|excel|xlsx|ppt|pptx|文档|表格|报告|周报|方案|大纲|导图|xmind|markdown|csv|json|文件|总结|改写|排版)/i,
  image: /(图片|照片|海报|插画|封面|生图|改图|绘图|画一|画个|画张|画两|参考图|抠图|修图|这张图|那张图|这几张图|画面|图中|图里)/i,
  video: /(视频|动起来|首帧|尾帧|镜头|运镜|字幕)/i,
  audio: /(音乐|歌曲|写一首|一首歌|配乐|配音|朗读|旁白|音效|翻唱|混音|口播|歌|唱|曲)/i,
  templates: /(模板|分镜|工作流|流程图)/i,
  utility: /(设为画布|设为参考|提示词|润色|优化提示词)/i,
};

export interface InitialToolContext {
  /** 这一轮用户原话；恢复轮传 null，由 checkpoint 的 activeTools 决定 */
  text: string | null;
  hasAttachments: boolean;
  hasDocuments: boolean;
  hasImages: boolean;
}

/**
 * 首轮预加载。只做确定性判断，不额外调用模型：
 * - 有附件/图片 → 图片组；
 * - 有文件或文档动词 → 文档组；
 * - 视频/音频/模板/画布动词 → 对应组；
 * - 其余情况只给 core，让模型用 capability_search 发现。
 */
export function initialToolGroups(context: InitialToolContext): Set<ChatToolGroup> {
  const groups = new Set<ChatToolGroup>(["core"]);
  const text = context.text ?? "";
  if (context.hasDocuments || GROUP_HINTS.docs.test(text)) groups.add("docs");
  if (context.hasAttachments || context.hasImages || GROUP_HINTS.image.test(text)) groups.add("image");
  if (GROUP_HINTS.video.test(text)) groups.add("video");
  if (GROUP_HINTS.audio.test(text)) groups.add("audio");
  if (GROUP_HINTS.templates.test(text)) groups.add("templates");
  if (GROUP_HINTS.utility.test(text)) groups.add("utility");
  return groups;
}

function summaryOf(tool: ChatTool): string {
  if (tool.summary?.trim()) return tool.summary.trim();
  return tool.spec.function.description.length > 90
    ? `${tool.spec.function.description.slice(0, 90)}…`
    : tool.spec.function.description;
}

function matches(tool: ChatTool, tokens: string[]): boolean {
  const haystack = `${tool.spec.function.name} ${tool.group ?? "core"} ${summaryOf(tool)}`.toLowerCase();
  return tokens.some((token) => token.length > 1 && haystack.includes(token));
}

export function createCapabilitySearchTool(registry: ChatToolRegistry): ChatTool {
  return {
    spec: capabilitySearchSpec,
    displayName: "capability_search",
    group: "core",
    run: async (raw) => {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return { ok: false, summary: "能力查找参数不是有效 JSON" }; }
      const parsed = searchSchema.safeParse(value);
      if (!parsed.success) return { ok: false, summary: "请提供 query，或在 groups 里指定能力组" };

      const groups = new Set<ChatToolGroup>(parsed.data.groups ?? []);
      // 关键词里出现明确能力时，只补对应组；用户点名 groups 时以 groups 为准。
      if (!groups.size) {
        for (const group of CHAT_TOOL_GROUPS) {
          if (group === "core") continue;
          if (GROUP_HINTS[group].test(parsed.data.query)) groups.add(group);
        }
      }
      const tokens = parsed.data.query.toLowerCase().split(/[\s,，。；;、/]+/).filter(Boolean);
      const candidates = registry.all().filter((tool) => {
        const group = tool.group ?? "core";
        if (group === "core") return false;
        if (groups.size) return groups.has(group);
        return matches(tool, tokens);
      }).slice(0, 8);

      if (!candidates.length) {
        const catalog = CHAT_TOOL_GROUPS.filter((group) => group !== "core")
          .map((group) => `${group}=${GROUP_LABELS[group]}`).join("；");
        return {
          ok: true,
          summary: `没有匹配到更具体的能力。可以指定 groups 重新查找：${catalog}。`,
          data: { activate: [] as string[], groups: [...groups] },
        };
      }

      const names = candidates.map((tool) => tool.spec.function.name);
      const detail = candidates.map((tool) => `${tool.spec.function.name}（${summaryOf(tool)}）`).join("；");
      return {
        ok: true,
        summary: `已开启 ${names.length} 个能力：${detail}。下一轮可以直接调用。`,
        data: { activate: names, groups: [...new Set(candidates.map((tool) => tool.group ?? "core"))] },
        uiData: { capabilitySearch: { activated: names } },
      };
    },
  };
}

/** 供系统提示词列出「当前没装、但可以查找」的能力组 */
export function unloadedGroupHint(groups: ReadonlySet<ChatToolGroup>): string {
  const missing = CHAT_TOOL_GROUPS.filter((group) => group !== "core" && !groups.has(group))
    .map((group) => `${group}=${GROUP_LABELS[group]}`);
  return missing.length ? `当前未加载：${missing.join("；")}。需要时先调用 capability_search 查找，下一轮再调用。` : "";
}
