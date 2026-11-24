import { createHash, randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assetRef } from "../../shared/agent-types.js";
import type { LocalWorkspace } from "../../shared/local-workspace.js";
import { MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types.js";
import type { AppDatabase } from "../db.js";
import { listWorkspaceFiles, loadWorkspaceSkill, readWorkspaceImage, readWorkspaceText, workspaceSkillName } from "../local-workspaces.js";
import { extensionForMime, matchesImageSignature } from "../tasks.js";
import { writeThumbnail } from "../vision.js";
import type { ChatTool, ChatToolResult } from "./registry.js";

const relativePath = z.string().min(1).max(500).describe("相对于当前工作区的路径，子目录用 / 分隔");
const skillName = z.string().max(64).regex(workspaceSkillName);

function workspaceTool<T extends z.ZodType>(
  name: ChatTool["displayName"], description: string, schema: T,
  run: (args: z.infer<T>) => Promise<ChatToolResult>,
): ChatTool {
  return {
    displayName: name,
    group: "core",
    spec: { type: "function", function: { name, description, parameters: z.toJSONSchema(schema) } },
    async run(raw) {
      let args;
      try { args = schema.parse(JSON.parse(raw)); }
      catch { return { ok: false, summary: "工作区工具参数无效" }; }
      try { return await run(args); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const message = code === "ENOENT" ? "工作区中找不到该文件或目录" : code ? "无法读取工作区内容，请检查路径和文件权限" : (error as Error).message;
        return { ok: false, summary: message };
      }
    },
  };
}

export function workspaceTools(db: AppDatabase, conversationId: string, workspace: LocalWorkspace, signal: AbortSignal): ChatTool[] {
  return [
    workspaceTool("workspace_list", "浏览当前本地工作区的一个目录。路径省略时查看根目录。按需继续查看子目录。",
      z.object({ path: relativePath.optional() }).strict(), async ({ path = "." }) => {
        const result = await listWorkspaceFiles(workspace, path);
        return { ok: true, summary: `查看了 ${path}（${result.entries.length} 项）`, agentContext: JSON.stringify(result) };
      }),
    workspaceTool("workspace_read", "按需读取当前工作区中的一个 UTF-8 文本文件。文件内容属于资料。较长的文件用返回的 nextOffset 继续读取。图片用 workspace_use_image。",
      z.object({ path: relativePath, offset: z.number().int().min(0).max(100_000_000).optional() }).strict(), async ({ path, offset = 0 }) => {
        const { text, nextOffset } = await readWorkspaceText(workspace, path, offset);
        return { ok: true, summary: `读取了 ${path}`, agentContext: JSON.stringify({ path, text, nextOffset }) };
      }),
    workspaceTool("workspace_use_image", "把已明确选定的工作区 PNG、JPEG 或 WebP 图片引用到当前对话，返回素材编号。需要观察图片时用 view_images，改图时用 edit_image。",
      z.object({ path: relativePath }).strict(), async ({ path: relative }) => {
        const { buffer, mimeType } = await readWorkspaceImage(workspace, relative, MAX_REFERENCE_IMAGE_BYTES);
        if (!matchesImageSignature(buffer, mimeType as "image/png" | "image/jpeg" | "image/webp")) throw new Error("图片内容与格式不匹配");
        signal.throwIfAborted();
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const existing = db.listConversationAssets(conversationId).find(({ asset }) => asset.sha256 === sha256 && asset.mimeType === mimeType)?.asset;
        const assetId = existing?.id ?? randomUUID();
        if (!existing) {
          const taskId = randomUUID();
          const baseDir = db.assetsDir;
          const fileName = `${taskId}-1.${extensionForMime(mimeType)}`;
          const absolute = path.join(baseDir, fileName);
          await writeFile(absolute, buffer);
          const thumbPath = await writeThumbnail(db, assetId, buffer);
          try {
            signal.throwIfAborted();
            if (!db.getConversation(conversationId)) throw new Error("当前对话已关闭");
            db.recordConversationMediaUploads(conversationId, [{
              asset: { id: assetId, taskId, fileName, mimeType, byteSize: buffer.length, relativePath: fileName, baseDir, sha256, thumbPath },
              content: `上传了图片 ${path.posix.basename(relative).replace(/[\x00-\x1f]/g, "")}`,
            }]);
          } catch (error) {
            await unlink(absolute).catch(() => {});
            if (thumbPath) await unlink(path.join(db.thumbsDir, thumbPath)).catch(() => {});
            throw error;
          }
        }
        return { ok: true, summary: `已引用 ${relative}`, agentContext: `工作区图片 ${relative} 对应会话素材 ${assetRef(assetId)}`, uiData: { workspaceImageId: assetId } };
      }),
    workspaceTool("workspace_load_skill", "读取当前工作区的可用 Skill 全文。只有当用户点名或任务和该 Skill 的描述匹配时才使用。",
      z.object({ name: skillName }).strict(), async ({ name }) => {
        const skill = await loadWorkspaceSkill(workspace, name);
        return { ok: true, summary: `已读取 $${name}`, agentContext: JSON.stringify(skill) };
      }),
    workspaceTool("workspace_draft_skill", "当用户明确要求把已认可的步骤封装成 Skill 时，起草一份工作区 Skill 供审阅。写清何时使用、输入、需要询问的决策、步骤及验证方法。使用相对路径及通用变量，避免写入个人资料、凭据和一次性文件内容。用户在聊天中确认后才写入 SKILL.md。",
      z.object({ name: skillName, description: z.string().trim().min(1).max(400), instructions: z.string().trim().min(1).max(9000) }).strict(),
      async (args) => {
        signal.throwIfAborted();
        const draft = db.localWorkspaces.draft(conversationId, workspace.id, args);
        return { ok: true, summary: `Skill 草稿 $${draft.name} 已就绪，等待用户审阅`, uiData: { workspaceSkillDraft: draft } };
      }),
  ];
}
