import { constants, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { WORKSPACE_MEDIA_DIRECTORY } from "../shared/local-workspace.js";
import type { LocalWorkspace, WorkspaceImageReview, WorkspaceSkillDraft, WorkspaceSkillInfo } from "../shared/local-workspace.js";

const maxTextBytes = 48 * 1024;
const maxSkillBytes = 32 * 1024;
const pendingMediaCopies = new Map<string, Promise<void>>();
const imageTypes = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);
export const workspaceSkillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class LocalWorkspaceStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): LocalWorkspace[] {
    return this.db.prepare("SELECT id, name, directory FROM local_workspaces ORDER BY rowid DESC").all() as unknown as LocalWorkspace[];
  }

  get(id: string): LocalWorkspace | undefined {
    return this.db.prepare("SELECT id, name, directory FROM local_workspaces WHERE id = ?").get(id) as LocalWorkspace | undefined;
  }

  remove(id: string): boolean {
    return Boolean(this.db.prepare("DELETE FROM local_workspaces WHERE id = ?").run(id).changes);
  }

  async add(directory: string): Promise<LocalWorkspace> {
    if (!path.isAbsolute(directory) || directory.startsWith("\\\\")) throw new Error("请选择本机的绝对目录");
    const resolved = await realpath(directory).catch(() => null);
    if (!resolved || !(await stat(resolved)).isDirectory()) throw new Error("找不到选中的目录");
    const existing = this.list().find((entry) => path.relative(entry.directory, resolved) === "");
    if (existing) return existing;
    const workspace = { id: crypto.randomUUID(), name: path.basename(resolved) || resolved, directory: resolved };
    this.db.prepare("INSERT INTO local_workspaces(id, name, directory) VALUES (?, ?, ?)").run(workspace.id, workspace.name, workspace.directory);
    return workspace;
  }

  draft(conversationId: string, workspaceId: string, input: Omit<WorkspaceSkillDraft, "id">): WorkspaceSkillDraft {
    const draft = { ...input, id: crypto.randomUUID() };
    this.db.prepare("INSERT INTO workspace_skill_drafts(id, conversation_id, workspace_id, payload) VALUES (?, ?, ?, ?)")
      .run(draft.id, conversationId, workspaceId, JSON.stringify(draft));
    return draft;
  }

  getDraft(conversationId: string, workspaceId: string, id: string): { draft: WorkspaceSkillDraft; saved: boolean } | undefined {
    const row = this.db.prepare("SELECT payload, saved FROM workspace_skill_drafts WHERE id = ? AND conversation_id = ? AND workspace_id = ?")
      .get(id, conversationId, workspaceId);
    return row ? { draft: JSON.parse(String(row.payload)) as WorkspaceSkillDraft, saved: Boolean(row.saved) } : undefined;
  }

  markSaved(id: string) {
    this.db.prepare("UPDATE workspace_skill_drafts SET saved = 1 WHERE id = ?").run(id);
  }

  imageReview(conversationId: string, workspaceId: string): WorkspaceImageReview | undefined {
    const row = this.db.prepare("SELECT payload FROM workspace_image_reviews WHERE conversation_id = ? AND workspace_id = ?")
      .get(conversationId, workspaceId);
    return row ? JSON.parse(String(row.payload)) as WorkspaceImageReview : undefined;
  }

  saveImageReview(conversationId: string, workspaceId: string, review: WorkspaceImageReview) {
    this.db.prepare(`INSERT INTO workspace_image_reviews(conversation_id,workspace_id,payload) VALUES (?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET workspace_id=excluded.workspace_id,payload=excluded.payload`)
      .run(conversationId, workspaceId, JSON.stringify(review));
  }
}

function inaccessible(name: string) {
  return name.startsWith(".") || /^(?:node_modules|__pycache__)$/i.test(name) || /\.(?:pem|key|pfx|p12|keystore)$/i.test(name);
}

async function resolveWorkspacePath(workspace: LocalWorkspace, relative: string, internal = false) {
  const segments = relative === "." ? [] : relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\:\x00-\x1f]/.test(segment)
    || /[. ]$/.test(segment) || (!internal && inaccessible(segment)))) throw new Error("请使用工作区内的相对路径");
  const root = workspace.directory;
  if (path.relative(root, await realpath(root)) !== "" || (await lstat(root)).isSymbolicLink()) throw new Error("工作区位置已经改变，请检查原目录");
  let current = root;
  let info = await stat(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("工作区文件须位于真实目录中");
  }
  if (path.relative(current, await realpath(current)) !== "") throw new Error("工作区路径已经改变");
  return { current, info };
}

/** Only write underneath the registered directory, never through a symlink or junction. */
export async function copyWorkspaceMedia(workspace: LocalWorkspace, group: "上传" | "生成" | "引用", fileName: string, source: string, byteSize: number) {
  const folder = WORKSPACE_MEDIA_DIRECTORY;
  const groupPath = `${folder}/${group}`;
  if (!fileName || path.basename(fileName) !== fileName) throw new Error("素材文件名无效");
  if (!(await lstat(source)).isFile()) throw new Error("素材源文件无效");
  let parent = (await resolveWorkspacePath(workspace, ".")).current;
  for (const [name, relative] of [[folder, folder], [group, groupPath]] as const) {
    await mkdir(path.join(parent, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const { current, info } = await resolveWorkspacePath(workspace, relative);
    if (!info.isDirectory()) throw new Error("素材目录不可用");
    parent = current;
  }
  const target = path.join(parent, fileName);
  const pending = pendingMediaCopies.get(target);
  if (pending) return pending;
  const copy = copyFile(source, target, constants.COPYFILE_EXCL).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const { info } = await resolveWorkspacePath(workspace, `${groupPath}/${fileName}`);
    if (!info.isFile() || info.size !== byteSize) throw new Error("工作区已有同名素材，请检查文件");
  });
  pendingMediaCopies.set(target, copy);
  try { await copy; }
  finally { pendingMediaCopies.delete(target); }
}

export async function resolveWorkspaceDirectory(workspace: LocalWorkspace) {
  const { current, info } = await resolveWorkspacePath(workspace, ".");
  if (!info.isDirectory()) throw new Error("工作区目录不可用");
  return current;
}

async function entries(workspace: LocalWorkspace, relative: string, limit: number, internal = false) {
  const { current, info } = await resolveWorkspacePath(workspace, relative, internal);
  if (!info.isDirectory()) throw new Error("请选择一个目录");
  const dir = await opendir(current);
  const result: Dirent[] = [];
  let scanned = 0;
  for await (const entry of dir) {
    if (++scanned > 1000 || result.length > limit) break;
    if (!inaccessible(entry.name) && (entry.isFile() || entry.isDirectory())) result.push(entry);
  }
  return { items: result.slice(0, limit).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true })), truncated: scanned > 1000 || result.length > limit };
}

export async function listWorkspaceFiles(workspace: LocalWorkspace, relative: string) {
  const { items, truncated } = await entries(workspace, relative, 150);
  return {
    entries: items.map((entry) => ({ path: relative === "." ? entry.name : `${relative}/${entry.name}`, type: entry.isDirectory() ? "目录" : "文件" })),
    truncated,
  };
}

export async function listWorkspaceReviewImages(workspace: LocalWorkspace, directory: string, signal: AbortSignal) {
  const images: string[] = [];
  const folders = [directory];
  let scanned = 0;
  while (folders.length) {
    signal.throwIfAborted();
    const parent = folders.pop()!;
    const { current, info } = await resolveWorkspacePath(workspace, parent);
    if (!info.isDirectory()) throw new Error("请选择要看图的工作区目录");
    for await (const entry of await opendir(current)) {
      signal.throwIfAborted();
      if (++scanned > 4000) throw new Error("此目录包含太多文件，请指定一个素材子目录");
      if (inaccessible(entry.name)) continue;
      const relative = parent === "." ? entry.name : `${parent}/${entry.name}`;
      if (entry.isDirectory()) folders.push(relative);
      if (entry.isFile() && imageTypes.has(path.extname(entry.name).toLowerCase())) {
        images.push(relative);
        if (images.length > 96) throw new Error("一次最多分析 96 张图片，请指定一个素材子目录");
      }
    }
  }
  return images.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

async function readBytes(workspace: LocalWorkspace, relative: string, limit: number, internal = false, offset = 0) {
  const { current, info } = await resolveWorkspacePath(workspace, relative, internal);
  if (!info.isFile()) throw new Error("请选择普通文件");
  const file = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    const verified = await resolveWorkspacePath(workspace, relative, internal);
    if (!opened.isFile() || opened.ino !== verified.info.ino || opened.dev !== verified.info.dev) throw new Error("文件已移动，请重读");
    const buffer = Buffer.alloc(Math.min(Math.max(0, opened.size - offset), limit));
    let read = 0;
    while (read < buffer.length) {
      const result = await file.read(buffer, read, buffer.length - read, offset + read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    return { buffer: buffer.subarray(0, read), size: opened.size };
  } finally { await file.close(); }
}

export async function readWorkspaceText(workspace: LocalWorkspace, relative: string, offset: number) {
  const { buffer, size } = await readBytes(workspace, relative, maxTextBytes, false, offset);
  if (buffer.includes(0) || (!offset && buffer.toString("utf8").slice(0, 400).split("\uFFFD").length > 4)) throw new Error("当前支持读取 UTF-8 文本，图片请用工作区图片工具");
  return { text: buffer.toString("utf8"), nextOffset: offset + buffer.length < size ? offset + buffer.length : null };
}

export async function readWorkspaceImage(workspace: LocalWorkspace, relative: string, limit: number) {
  const mimeType = imageTypes.get(path.extname(relative).toLowerCase());
  if (!mimeType) throw new Error("工作区图片支持 PNG、JPEG 和 WebP");
  const { buffer, size } = await readBytes(workspace, relative, limit);
  if (!buffer.length || buffer.length !== size) throw new Error("图片为空或超过大小限制");
  return { buffer, mimeType };
}

const skillDirectory = ".agents/skills";

function parseSkill(source: string) {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!header) return;
  const value = (key: "name" | "description") => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)(?:\\r?\\n((?:[ \\t]+[^\\r\\n]*\\r?\\n?)*))?`, "m").exec(header[1]!);
    const raw = match?.[1]?.trim() ?? "";
    if (/^[>|][-+]?$/.test(raw)) return match?.[2]?.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join(" ") ?? "";
    if (raw.startsWith("\"")) {
      try { return String(JSON.parse(raw)); } catch { return ""; }
    }
    return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
  };
  const name = value("name");
  const description = value("description");
  if (name.length <= 64 && workspaceSkillName.test(name) && description) {
    return { name, description: description.slice(0, 400), bodyStart: header[0].length };
  }
}

export async function loadWorkspaceSkill(workspace: LocalWorkspace, name: string) {
  if (name.length > 64 || !workspaceSkillName.test(name)) throw new Error("Skill 名称无效");
  const { buffer, size } = await readBytes(workspace, `${skillDirectory}/${name}/SKILL.md`, maxSkillBytes, true);
  const source = buffer.toString("utf8");
  const skill = buffer.length === size && parseSkill(source);
  if (!skill || skill.name !== name) throw new Error("SKILL.md 无效或与目录名称不一致");
  const instructions = source.slice(skill.bodyStart).trim();
  if (!instructions) throw new Error("SKILL.md 没有工作步骤");
  return { name, description: skill.description, instructions };
}

export async function discoverWorkspaceSkills(workspace: LocalWorkspace): Promise<WorkspaceSkillInfo[]> {
  const directory = await entries(workspace, skillDirectory, 60, true).catch(() => null);
  if (!directory) return [];
  const loaded = await Promise.allSettled(directory.items.filter(entry => entry.isDirectory() && workspaceSkillName.test(entry.name))
    .map(async ({ name }) => {
      const { buffer, size } = await readBytes(workspace, `${skillDirectory}/${name}/SKILL.md`, 4096, true);
      const skill = size <= maxSkillBytes && parseSkill(buffer.toString("utf8"));
      return skill && skill.name === name ? { name, description: skill.description } : [];
    }));
  return loaded.flatMap(result => result.status === "fulfilled" ? result.value : []);
}

export async function saveWorkspaceSkill(workspace: LocalWorkspace, draft: WorkspaceSkillDraft) {
  if (!workspaceSkillName.test(draft.name) || draft.name.length > 64) throw new Error("Skill 名称无效");
  const source = `---\nname: ${draft.name}\ndescription: ${JSON.stringify(draft.description)}\n---\n\n${draft.instructions}\n`;
  if (Buffer.byteLength(source) > maxSkillBytes) throw new Error("Skill 内容过长");
  for (const directory of [".agents", skillDirectory]) {
    const parent = directory.includes("/") ? ".agents" : ".";
    await resolveWorkspacePath(workspace, parent, true);
    await mkdir(path.join(workspace.directory, directory)).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (!(await resolveWorkspacePath(workspace, directory, true)).info.isDirectory()) throw new Error("Skill 目录不可用");
  }
  const rel = `${skillDirectory}/${draft.name}`;
  const target = path.join(workspace.directory, rel);
  try { await mkdir(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("已有同名 Skill，请换名称后重试"); throw error; }
  let wrote = false;
  const filePath = path.join(target, "SKILL.md");
  try {
    await resolveWorkspacePath(workspace, rel, true);
    const file = await open(filePath, "wx");
    wrote = true;
    try { await file.writeFile(source, "utf8"); } finally { await file.close(); }
  } catch (error) {
    const safe = await resolveWorkspacePath(workspace, rel, true).catch(() => null);
    if (safe) {
      if (wrote) await unlink(filePath).catch(() => {});
      await rmdir(target).catch(() => {});
    }
    throw error;
  }
  return `${rel}/SKILL.md`;
}
