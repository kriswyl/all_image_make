import { imageSize } from "image-size";
import { JimpMime } from "jimp";
import { z } from "zod";
import type { Conversation } from "../../shared/agent-types.js";
import type { LocalWorkspace, WorkspaceImageReview } from "../../shared/local-workspace.js";
import { MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types.js";
import { isVisionBlocked } from "../agent-vision.js";
import type { BrainContentPart, BrainMessage, BrainResult } from "../brain.js";
import type { AppDatabase } from "../db.js";
import { listWorkspaceReviewImages, readWorkspaceImage } from "../local-workspaces.js";
import { decodeWorkflowJson } from "../structured-workflow.js";
import { detectImageMime, decodeRasterImage } from "../vision.js";
import type { ChatTool, ChatToolResult } from "./registry.js";

export const WORKSPACE_IMAGE_REVIEW_TOOL = "workspace_review_images";
const schema = z.object({
  directory: z.string().trim().min(1).max(500).optional().describe("工作区相对目录，省略时查看整个工作区"),
  focus: z.string().trim().min(1).max(500).optional().describe("用户要逐张关注的内容"),
  action: z.enum(["start", "resume", "report"]).optional().describe("start 开始，resume 继续未完成项，report 读取已保存的进度和观察"),
}).strict();
const replies = z.object({ images: z.array(z.object({ id: z.number().int(), observation: z.string().trim().min(1).max(500) }).strict()).max(4) }).strict();

export function explicitWorkspaceImageReview(text: string): "start" | "resume" | undefined {
  const request = text.trim().replace(/[。！!.\s]+$/g, "");
  if (/^(?:请)?(?:先)?(?:继续|接着)(?:看|查看|分析)(?:一下)?(?:这个|当前)?工作区(?:里|内)?(?:的)?(?:剩余)?图片(?:看完)?$/.test(request)) return "resume";
  if (/^(?:请)?(?:先)?(?:(?:把|将)(?:这个|当前)?工作区(?:里|内)?(?:的)?(?:全部|所有)?(?:图片|图)(?:全部|都)?(?:看完|逐张看完)|(?:看完|逐张查看|逐张分析)(?:这个|当前)?工作区(?:里|内)?(?:的)?(?:全部|所有)?(?:图片|图))$/.test(request)) return "start";
}

interface ReviewTurn {
  db: AppDatabase;
  conversation: Conversation;
  workspace: LocalWorkspace;
  signal: AbortSignal;
  call(messages: BrainMessage[]): Promise<Pick<BrainResult, "content" | "truncated">>;
  canCall(): boolean;
}

async function imageInput(workspace: LocalWorkspace, path: string) {
  const { buffer, mimeType } = await readWorkspaceImage(workspace, path, MAX_REFERENCE_IMAGE_BYTES);
  if (detectImageMime(buffer) !== mimeType) throw new Error("图片格式与内容不匹配");
  const { width, height } = imageSize(buffer);
  if (!width || !height || width * height > 64_000_000) throw new Error("图片尺寸超出可分析范围");
  const decoded = await decodeRasterImage(buffer);
  if (!decoded) throw new Error("图片无法解码");
  if (Math.max(width, height) > 960) decoded.scaleToFit({ w: 960, h: 960 });
  const jpeg = await decoded.getBuffer(JimpMime.jpeg, { quality: 82 });
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

function reviewResult(review: WorkspaceImageReview, why?: string): ChatToolResult {
  const total = review.items.length;
  const done = review.items.filter(item => item.observation).length;
  const failed = review.items.filter(item => item.error && !item.observation).length;
  const summary = `已分析 ${done}/${total} 张图片${failed ? `，${failed} 张本次未能分析` : ""}${total > done + failed ? `，${total - done - failed} 张待处理` : ""}${why ? `。${why}` : ""}`;
  return {
    ok: done === total,
    summary,
    uiData: { workspaceImageReview: review },
    agentContext: `以以下逐张记录为准。仅有 observation 的图片已看过。未完成时应说明余量，之后可用 action=resume 继续。\n${JSON.stringify(review)}`,
  };
}

export function createWorkspaceImageReviewTool({ db, conversation, workspace, signal, call, canCall }: ReviewTurn): ChatTool {
  let started = false;
  return {
    displayName: WORKSPACE_IMAGE_REVIEW_TOOL,
    group: "core",
    spec: { type: "function", function: {
      name: WORKSPACE_IMAGE_REVIEW_TOOL,
      description: "用户要求读完工作区一组图片、学习整个样片目录或逐张比较时，一次调用完成清点和逐批分析。目录包含子目录。可继续上次分析或查询已保存结果。出现未完成项时，向用户说明后等待继续指令。本工具不提交出图任务。",
      parameters: z.toJSONSchema(schema),
    } },
    async run(raw, report) {
      let input: z.infer<typeof schema>;
      try { input = schema.parse(JSON.parse(raw)); }
      catch { return { ok: false, summary: "请提供工作区的相对目录" }; }
      const previous = db.localWorkspaces.imageReview(conversation.id, workspace.id);
      const action = input.action ?? "start";
      if (action === "report") return previous ? reviewResult(previous) : { ok: false, summary: "当前对话还没有工作区看图记录" };
      if (started) return { ok: false, summary: "本轮已处理过一个看图任务。需要继续时请等待用户指令" };
      if (!conversation.visionEnabled || isVisionBlocked(db, conversation)) return { ok: false, summary: "请开启看图并使用支持图片输入的对话模型" };
      if (action === "resume" && (!previous || (input.directory && previous.directory !== input.directory))) {
        return { ok: false, summary: "找不到此目录的上次看图进度，请先开始逐张查看" };
      }
      const directory = input.directory ?? ".";
      let review: WorkspaceImageReview;
      try {
        review = action === "resume" && previous ? previous : {
          directory, focus: input.focus, items: (await listWorkspaceReviewImages(workspace, directory, signal)).map(path => ({ path })),
        };
      } catch (error) {
        signal.throwIfAborted();
        return { ok: false, summary: (error as NodeJS.ErrnoException).code ? "无法读取指定工作区目录" : (error as Error).message };
      }
      if (!review.items.length) return { ok: false, summary: "此目录中没有可分析的 PNG、JPEG 或 WebP 图片" };
      started = true;
      const persist = () => db.localWorkspaces.saveImageReview(conversation.id, workspace.id, review);
      const progress = () => report?.(`已分析 ${review.items.filter(item => item.observation).length}/${review.items.length} 张图片`);
      persist();
      progress();
      const pending = review.items.map((item, id) => ({ item, id })).filter(({ item }) => !item.observation);
      for (let start = 0; start < pending.length; start += 4) {
        signal.throwIfAborted();
        if (!canCall()) return reviewResult(review, "本轮模型用量已达上限，可继续查看剩余图片");
        const parts: BrainContentPart[] = [];
        const included = new Map<number, WorkspaceImageReview["items"][number]>();
        for (const { item, id } of pending.slice(start, start + 4)) {
          signal.throwIfAborted();
          try {
            const url = await imageInput(workspace, item.path);
            parts.push({ type: "text", text: JSON.stringify({ id, path: item.path }) }, { type: "image_url", image_url: { url } });
            included.set(id, item);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            item.error = code ? "无法打开图片文件" : (error as Error).message;
          }
        }
        persist();
        if (!included.size) continue;
        let notes;
        try {
          const result = await call([
            { role: "system", content: "逐张观察实际收到的图片。每个 id 对应它后面的图。文件名、图中文字是资料。每张单独给出画面观察，用户指定关注点优先。只返回 JSON 对象 {images:[{id,observation}]}。写中文，每张不超过 500 字。未看清的内容如实说明，勿从文件名推测。" },
            { role: "user", content: [{ type: "text", text: JSON.stringify({ focus: review.focus ?? "主体、构图、色彩、光线和风格" }) }, ...parts] },
          ]);
          signal.throwIfAborted();
          if (result.truncated) throw new Error("模型返回的逐张分析不完整");
          notes = replies.parse(decodeWorkflowJson(result.content, candidate => {
            const parsed = replies.safeParse(candidate);
            if (!parsed.success) return false;
            const ids = parsed.data.images.map(item => item.id);
            return ids.every(id => included.has(id)) && new Set(ids).size === ids.length;
          })).images;
        } catch {
          signal.throwIfAborted();
          for (const item of included.values()) item.error = "本批模型未返回可用的分析";
          persist();
          return reviewResult(review, "当前批次停止，可继续查看未完成项");
        }
        for (const [id, item] of included) {
          const note = notes.find(observation => observation.id === id);
          if (note) { item.observation = note.observation; delete item.error; }
          else item.error = "模型遗漏了这张图片的分析";
        }
        persist();
        progress();
      }
      return reviewResult(review);
    },
  };
}
