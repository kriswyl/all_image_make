import type { DatabaseSync } from "node:sqlite";
import { isAudioAsset, isImageAsset, type Asset } from "../shared/types.js";
import { now, type DbRow } from "./db-row.js";

export interface AssetRow {
  id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string;
  /** 该产物所在目录：用户换过素材目录后，老记录仍指向写入时的目录 */
  baseDir: string;
  sha256: string; duration: number | null;
  /** 相对 thumbs/ 的缩略图文件名，空串表示还没生成 */
  thumbPath: string;
  /** 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频为空串 */
  title: string;
  lyrics: string;
  tags: string;
  remoteClipId: string;
  createdAt: string;
}

/** 待清理的落盘文件：目录随记录走，不能用当前素材目录去猜 */
export interface StoredFileRef {
  baseDir: string;
  relativePath: string;
}

export type InsertAssetInput = {
  id: string; taskId: string; fileName: string; mimeType: string; byteSize: number;
  relativePath: string; baseDir: string; sha256: string; duration?: number | null;
  /** 相对 thumbs/ 的文件名。缩略图生成失败时留空，Agent 那边会现缩现存 */
  thumbPath?: string | null;
  /** 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频留空 */
  title?: string | null;
  lyrics?: string | null;
  tags?: string | null;
  remoteClipId?: string | null;
};

export class AssetRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly defaultAssetsDir: string,
    private readonly thumbsDir: string,
  ) {}

  /** 删除单个公共素材，保留生成记录和同任务的其他产物。 */
  deletePublicAsset(assetId: string): StoredFileRef[] {
    const asset = this.getAsset(assetId);
    if (!asset) return [];
    this.db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
    const files = [{ baseDir: asset.baseDir, relativePath: asset.relativePath }];
    if (asset.thumbPath) files.push({ baseDir: this.thumbsDir, relativePath: asset.thumbPath });
    return files;
  }

  assetHasOtherConversationReferences(assetId: string, conversationId: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM messages WHERE conversation_id <> ? AND (asset_id = ? OR asset_refs LIKE ?) LIMIT 1`).get(conversationId, assetId, `%${assetId}%`)) return true;
    if (this.db.prepare(`SELECT 1 FROM conversations WHERE id <> ? AND (current_asset_id = ? OR canvas_asset_ids LIKE ? OR storyboard_reference_asset_id = ?) LIMIT 1`).get(conversationId, assetId, `%${assetId}%`, assetId)) return true;
    if (this.db.prepare(`SELECT 1 FROM conversation_shots WHERE conversation_id <> ? AND (first_frame_asset_id = ? OR last_frame_asset_id = ? OR reference_asset_ids LIKE ?) LIMIT 1`).get(conversationId, assetId, assetId, `%${assetId}%`)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_characters WHERE conversation_id <> ? AND asset_id = ? UNION ALL SELECT 1 FROM conversation_scenes WHERE conversation_id <> ? AND asset_id = ? LIMIT 1`).get(conversationId, assetId, conversationId, assetId));
  }

  insertAsset(asset: InsertAssetInput) {
    this.db.prepare(`
      INSERT INTO assets (id, task_id, file_name, mime_type, byte_size, relative_path, base_dir, sha256, duration, thumb_path, title, lyrics, tags, remote_clip_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.taskId, asset.fileName, asset.mimeType, asset.byteSize, asset.relativePath,
      asset.baseDir, asset.sha256, asset.duration ?? null, asset.thumbPath ?? "", asset.title ?? "",
      asset.lyrics ?? "", asset.tags ?? "", asset.remoteClipId ?? "", now(),
    );
  }

  /** 懒生成缩略图后回填（§11.4 的「使用时懒生成」），老产物走这条 */
  setAssetThumbPath(assetId: string, thumbPath: string) {
    this.db.prepare("UPDATE assets SET thumb_path = ? WHERE id = ?").run(thumbPath, assetId);
  }

  listAssets(taskId: string): AssetRow[] {
    const rows = this.db.prepare("SELECT * FROM assets WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[];
    return rows.map((row) => this.assetFromRow(row));
  }

  /** 按主键取单个产物：媒体请求（每个缩略图一次）用它，别走 listTaskRows */
  getAsset(id: string): AssetRow | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.assetFromRow(row) : null;
  }

  /** AssetRow → 前端用的 Asset。Agent 的画布徽章、附件条也走这一份，别各写一遍 */
  assetView(asset: AssetRow): Asset {
    return {
      id: asset.id, taskId: asset.taskId, fileName: asset.fileName, mimeType: asset.mimeType, byteSize: asset.byteSize,
      url: `/api/assets/${asset.id}/file`,
      thumbUrl: isImageAsset(asset) || (isAudioAsset(asset) && Boolean(asset.thumbPath))
        ? `/api/assets/${asset.id}/thumb`
        : null,
      duration: asset.duration,
      title: asset.title || null,
      lyrics: asset.lyrics || null,
      tags: asset.tags || null,
      remoteClipId: asset.remoteClipId || null,
      createdAt: asset.createdAt,
    };
  }

  assetFromRow(row: DbRow): AssetRow {
    return {
      id: String(row.id), taskId: String(row.task_id), fileName: String(row.file_name), mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size), relativePath: String(row.relative_path),
      baseDir: row.base_dir == null || row.base_dir === "" ? this.defaultAssetsDir : String(row.base_dir),
      sha256: String(row.sha256),
      duration: row.duration == null ? null : Number(row.duration),
      thumbPath: row.thumb_path == null ? "" : String(row.thumb_path),
      title: row.title == null ? "" : String(row.title),
      lyrics: row.lyrics == null ? "" : String(row.lyrics),
      tags: row.tags == null ? "" : String(row.tags),
      remoteClipId: row.remote_clip_id == null ? "" : String(row.remote_clip_id),
      createdAt: String(row.created_at),
    };
  }
}
