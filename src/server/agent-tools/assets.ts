import { assetRef } from "../../shared/agent-types.js";
import { MAX_CANVAS_IMAGES } from "../../shared/types.js";
import type { AppDatabase, AssetRow } from "../db.js";

/** 会话里的产物引用解析：`#a3f1` / `a3f1` / 完整 id / `last` */
export function resolveAssetRef(
  db: AppDatabase,
  conversationId: string,
  ref: string,
): { asset: AssetRow; round: number } | null {
  const entries = db.listConversationAssets(conversationId);
  if (!entries.length) return null;
  const normalized = ref.trim().toLowerCase().replace(/^#/, "");
  if (!normalized || ["last", "current", "最新", "当前"].includes(normalized)) {
    // 分镜产物是追加在消息产物后面的，不能直接拿数组最后一项当「最新」；
    // 按产物自己的创建时间取，才不依赖两类记录的拼接顺序
    const last = entries.reduce((newest, entry) => entry.asset.createdAt >= newest.asset.createdAt ? entry : newest);
    return { asset: last.asset, round: last.round };
  }
  const exact = entries.find((entry) => entry.asset.id.toLowerCase() === normalized);
  if (exact) return { asset: exact.asset, round: exact.round };
  // 前缀匹配可能命中多个（4 位十六进制的碰撞概率很低，但真发生时取最后一个）
  const prefixed = entries.filter((entry) => entry.asset.id.toLowerCase().startsWith(normalized));
  const hit = prefixed[prefixed.length - 1];
  return hit ? { asset: hit.asset, round: hit.round } : null;
}

/**
 * 解析一组**显式**图片引用，保持顺序、不做去重。
 *
 * 位置本身就是语义（first-last-frame 的第 1 张是首帧、第 2 张是尾帧），
 * 所以这里不能像 `resolveCanvasRefs` 那样去重、也不能静默跳过解析不出来的那张——
 * 少一张就会把「两张首尾帧」变成「一张首帧」，用户花了钱却拿到另一个东西。
 */
export function resolveImageRefs(
  db: AppDatabase,
  conversationId: string,
  refs: string[],
): { assets: AssetRow[]; error?: string } {
  const assets: AssetRow[] = [];
  const problems: string[] = [];
  for (const ref of refs) {
    const found = resolveAssetRef(db, conversationId, ref);
    if (!found) { problems.push(`找不到 ${ref}`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { problems.push(`${ref} 不是图片`); continue; }
    assets.push(found.asset);
  }
  return problems.length
    ? { assets, error: `${problems.join("；")}。请用画布或会话里的图片编号（#xxxx）重新指定` }
    : { assets };
}

/** 本条消息附带的图（已经是 assetId）。找不到/不是图片都算硬错误 */
export function attachmentAssets(db: AppDatabase, ids: string[]): { assets: AssetRow[]; error?: string } {
  const assets: AssetRow[] = [];
  for (const id of ids) {
    const asset = db.getAsset(id);
    if (!asset) return { assets, error: `本条消息附带的图片 ${assetRef(id)} 已经不在了，请让用户重新发一次` };
    if (!asset.mimeType.startsWith("image/")) continue;
    assets.push(asset);
  }
  return { assets };
}

/**
 * 把一串产物引用解析成画布 id 列表（纯函数：不碰网络、不写库，好单测）。
 *
 * 只做三件事：逐个解析、**去重保序**、把解析不出来的写进 `notes` 让人看得见。
 * 上限由 schema 挡在前面（超过 `MAX_CANVAS_IMAGES` 的调用根本进不来），
 * 这里再截一次是防着画布已经有几张、又被 append 的场景。
 */
export function resolveCanvasRefs(
  db: AppDatabase,
  conversationId: string,
  refs: string[],
  cap: number = MAX_CANVAS_IMAGES,
): { ids: string[]; notes: string[] } {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const ref of refs) {
    if (ids.length >= cap) { notes.push(`画布最多 ${cap} 张，${ref} 已跳过`); continue; }
    const found = resolveAssetRef(db, conversationId, ref);
    if (!found) { notes.push(`找不到产物 ${ref}，已跳过`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { notes.push(`${ref} 是视频，不能作为画布，已跳过`); continue; }
    if (ids.includes(found.asset.id)) continue;
    ids.push(found.asset.id);
  }
  return { ids, notes };
}
