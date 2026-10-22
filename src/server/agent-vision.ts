/**
 * 看图（view_images）：把指定图片的缩略图附到下一轮大脑上下文。
 *
 * 不生成、不落库；只读数据库和缩略图。单独拆出来是因为它和「生成执行」
 * 是两条完全不同的链路，混在一个类里时很难单独测试。
 */
import type { BrainContentPart } from "./brain.js";
import type { AppDatabase, AssetRow } from "./db.js";
import { assetThumbDataUri } from "./vision.js";
import { modelFingerprint, readVisionUnsupported } from "./capabilities.js";
import { resolveImageRefs } from "./agent-tools.js";
import { MAX_VISION_IMAGES } from "./agent-constants.js";
import { assetRef, type AgentPlan, type Conversation } from "../shared/agent-types.js";
import type { BuiltContext } from "./agent-context.js";

export interface VisionHost {
  db: AppDatabase;
}

export function isVisionBlocked(db: AppDatabase, conversation: Conversation): boolean {
  return readVisionUnsupported(db).includes(modelFingerprint(conversation.brainChannelId, conversation.brainModel));
}

export async function observeImages(
  host: VisionHost,
  conversation: Conversation,
  plan: AgentPlan,
  built: BuiltContext,
): Promise<BuiltContext> {
  const db = host.db;
  const conversationId = conversation.id;
  const fresh = db.getConversation(conversationId) ?? conversation;
  const rawRefs = Array.isArray(plan.args.assetRefs)
    ? plan.args.assetRefs.filter((ref): ref is string => typeof ref === "string")
    : [];
  const fromCanvas = rawRefs.length === 0;
  const notes: string[] = [];
  if (plan.calls && plan.calls.length > 1) {
    notes.push("view_images 必须单独调用，这一轮没有执行其它工具");
  }

  let assets: AssetRow[];
  if (rawRefs.length) {
    const picked = resolveImageRefs(db, conversationId, rawRefs);
    if (picked.error) notes.push(picked.error);
    assets = picked.assets;
  } else {
    assets = db.canvasImages(fresh);
  }
  if (assets.length > MAX_VISION_IMAGES) {
    notes.push(`一次最多看 ${MAX_VISION_IMAGES} 张，只附了前 ${MAX_VISION_IMAGES} 张`);
    assets = assets.slice(0, MAX_VISION_IMAGES);
  }

  const canSee = fresh.visionEnabled && !isVisionBlocked(db, fresh);
  if (!canSee) {
    notes.push(fresh.visionEnabled
      ? "当前大脑模型不接受图片输入，只能按编号/描述判断"
      : "这个会话关掉了看图，只能按编号/描述判断");
  }
  if (!assets.length) notes.push("没有找到可看的图片");

  const parts: BrainContentPart[] = [];
  let attached = false;
  if (canSee && assets.length) {
    parts.push({
      type: "text",
      text: fromCanvas
        ? `[view_images] 下面是当前画布上的 ${assets.length} 张图，按顺序编号。看完再决定 imageRefs；如果用户说的画面这里看不出是哪张，用 ask 问清楚，不要猜。`
        : `[view_images] 下面是你要看的 ${assets.length} 张图。看完再决定 imageRefs；仍然拿不准就 ask。`,
    });
    for (const [index, asset] of assets.entries()) {
      const uri = await assetThumbDataUri(db, asset);
      if (!uri) { notes.push(`${assetRef(asset.id)} 的缩略图读取失败`); continue; }
      parts.push({
        type: "text",
        text: `${assetRef(asset.id)}${fromCanvas ? `（画布第 ${index + 1} 张）` : `（第 ${index + 1} 张）`}`,
      });
      parts.push({ type: "image_url", image_url: { url: uri } });
      attached = true;
    }
  }
  if (notes.length) parts.push({ type: "text", text: `[view_images 提示] ${notes.join("；")}` });
  if (!parts.length) {
    parts.push({ type: "text", text: "[view_images 结果] 没有可看的图片。请改用 ask 让用户说明要改哪一张，或先让用户上传图片。" });
  }

  return {
    messages: [
      ...built.messages,
      { role: "assistant", content: JSON.stringify({ tool: plan.tool, args: plan.args }) },
      { role: "user", content: parts },
    ],
    visionAttached: built.visionAttached || attached,
  };
}
