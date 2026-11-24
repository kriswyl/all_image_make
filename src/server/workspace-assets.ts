import path from "node:path";
import type { AppDatabase } from "./db.js";
import type { InsertAssetInput } from "./db-assets.js";
import { copyWorkspaceMedia } from "./local-workspaces.js";
import { safeName } from "./workspace-paths.js";

type AssetStore = Pick<AppDatabase, "getConversation" | "localWorkspaces" | "appendMessage">;
type Media = Pick<InsertAssetInput, "id" | "mimeType" | "fileName" | "title" | "baseDir" | "relativePath" | "byteSize">;

export async function archiveConversationAssets(db: AssetStore, conversationId: string, group: "上传" | "生成" | "引用", assets: Media[]) {
  if (!assets.length) return;
  const workspaceId = db.getConversation(conversationId)?.workspaceId;
  const workspace = workspaceId && db.localWorkspaces.get(workspaceId);
  if (!workspace) return;

  let missed = 0;
  for (const asset of assets) {
    const kind = asset.mimeType.split("/")[0];
    const label = kind === "image" ? "图片" : kind === "video" ? "视频" : kind === "audio" ? "音频" : null;
    if (!label) continue;
    const extension = path.extname(asset.fileName).slice(1);
    const source = path.resolve(asset.baseDir, asset.relativePath);
    const relative = path.relative(path.resolve(asset.baseDir), source);
    const title = asset.title || label;
    const name = path.basename(safeName(title, extension), `.${extension}`);
    const fileName = safeName(`${[...name].slice(0, 28).join("")}-${asset.id}`, extension);
    try {
      if (!/^[a-z0-9]+$/i.test(extension) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("素材路径无效");
      await copyWorkspaceMedia(workspace, group, fileName, source, asset.byteSize);
    } catch {
      missed++;
    }
  }
  if (missed && db.getConversation(conversationId)) {
    db.appendMessage({
      conversationId, role: "system", content: `${missed} 个素材未能保存到工作区，仍可从对话使用。请检查工作区目录和写入权限。`,
    });
  }
}
