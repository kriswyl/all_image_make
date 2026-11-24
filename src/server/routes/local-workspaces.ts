import type { Express, Request } from "express";
import { z } from "zod";
import type { AppDatabase } from "../db.js";
import { discoverWorkspaceSkills, resolveWorkspaceDirectory, saveWorkspaceSkill } from "../local-workspaces.js";
import { AppError } from "../tasks.js";
import { revealFolder } from "./files.js";
import { asyncHandler, ok, routeParam } from "./http.js";

export function requireWorkspaceClient(req: Request) {
  const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
  const origin = req.get("Origin");
  const ownOrigin = !origin || origin === "tauri://localhost" || origin === "http://tauri.localhost"
    || (origin.startsWith("http://") && localHost.test(origin.slice(7)));
  if (!localHost.test(req.get("Host") ?? "") || !ownOrigin) throw new AppError("WORKSPACE_LOCAL_ONLY", "本地工作区仅向本机应用开放", 403);
}

export function registerLocalWorkspaceRoutes(app: Express, db: AppDatabase, isRunning: (id: string) => boolean) {
  app.use("/api/local-workspaces", (req, _res, next) => { requireWorkspaceClient(req); next(); });
  app.get("/api/local-workspaces", (_req, res) => res.json(ok(db.localWorkspaces.list())));
  app.post("/api/local-workspaces", asyncHandler(async (req, res) => {
    if (!req.is("application/json")) throw new AppError("WORKSPACE_INPUT", "请从应用选择工作区目录", 400);
    const { directory } = z.object({ directory: z.string().min(1).max(4096) }).strict().parse(req.body);
    try { res.status(201).json(ok(await db.localWorkspaces.add(directory))); }
    catch { throw new AppError("WORKSPACE_INPUT", "无法访问选中的本机目录", 400); }
  }));

  app.post("/api/local-workspaces/:id/reveal", asyncHandler(async (req, res) => {
    if (!req.is("application/json")) throw new AppError("WORKSPACE_INPUT", "请从应用打开工作区目录", 400);
    const workspace = db.localWorkspaces.get(routeParam(req.params.id));
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "找不到本地工作区", 404);
    const directory = await resolveWorkspaceDirectory(workspace).catch(() => {
      throw new AppError("WORKSPACE_DIRECTORY_UNAVAILABLE", "无法访问工作区文件夹，请检查原目录是否移动或删除", 404);
    });
    await revealFolder(directory).catch(() => {
      throw new AppError("WORKSPACE_REVEAL_FAILED", "无法启动系统文件管理器", 500);
    });
    res.json(ok({ opened: directory }));
  }));

  app.get("/api/local-workspaces/:id/skills", asyncHandler(async (req, res) => {
    const workspace = db.localWorkspaces.get(routeParam(req.params.id));
    if (!workspace) throw new AppError("WORKSPACE_NOT_FOUND", "找不到本地工作区", 404);
    res.json(ok(await discoverWorkspaceSkills(workspace)));
  }));
  const saving = new Map<string, string>();
  app.delete("/api/local-workspaces/:id", (req, res) => {
    if (!req.is("application/json")) throw new AppError("WORKSPACE_INPUT", "请从应用移除工作区", 400);
    const id = routeParam(req.params.id);
    if ([...saving.values()].includes(id) || db.listConversations().some((conversation) => conversation.workspaceId === id && isRunning(conversation.id))) {
      throw new AppError("WORKSPACE_BUSY", "请等工作区的对话或 Skill 保存完成后再移除", 409);
    }
    if (!db.localWorkspaces.remove(id)) throw new AppError("WORKSPACE_NOT_FOUND", "找不到本地工作区", 404);
    res.json(ok({ detached: true }));
  });
  function skillDraft(id: string, draftId: string) {
    const conversation = db.getConversation(id);
    const workspace = conversation?.workspaceId && db.localWorkspaces.get(conversation.workspaceId);
    const entry = workspace && db.localWorkspaces.getDraft(id, workspace.id, draftId);
    if (!workspace || !entry) throw new AppError("SKILL_DRAFT_NOT_FOUND", "找不到此 Skill 草稿", 404);
    return { workspace, entry, relativePath: `.agents/skills/${entry.draft.name}/SKILL.md` };
  }
  app.get("/api/conversations/:id/workspace-skills/:draftId", (req, res) => {
    requireWorkspaceClient(req);
    const { entry, relativePath } = skillDraft(routeParam(req.params.id), routeParam(req.params.draftId));
    res.json(ok({ path: entry.saved ? relativePath : null }));
  });
  app.post("/api/conversations/:id/workspace-skills/:draftId/save", asyncHandler(async (req, res) => {
    requireWorkspaceClient(req);
    if (!req.is("application/json")) throw new AppError("WORKSPACE_INPUT", "请从对话中的 Skill 草稿确认保存", 400);
    const id = routeParam(req.params.id);
    const draftId = routeParam(req.params.draftId);
    const { workspace, entry, relativePath } = skillDraft(id, draftId);
    if (!entry.saved) {
      if (saving.has(draftId)) throw new AppError("SKILL_SAVING", "Skill 正在保存", 409);
      saving.set(draftId, workspace.id);
      try {
        await saveWorkspaceSkill(workspace, entry.draft);
        db.localWorkspaces.markSaved(draftId);
      } catch (error) {
        const message = (error as NodeJS.ErrnoException).code ? "写入 Skill 失败，请检查工作区目录权限" : (error as Error).message;
        throw new AppError("SKILL_SAVE_FAILED", message, 409);
      } finally { saving.delete(draftId); }
    }
    res.json(ok({ path: relativePath }));
  }));
}
