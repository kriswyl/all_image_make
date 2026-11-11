import type { Channel, ImageSizeValue } from "../../shared/types.js";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "../../shared/types.js";
import type { AppDatabase, DbChannel } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { AppError } from "../tasks.js";

export function publicChannel(channel: DbChannel, sessionKeys: KeyStore): Channel {
  return {
    ...channel,
    // mj_edits 不再作为可选模型展示：有参考图时 mj_imagine 会自动走图生图接口
    ...(channel.adapterType === "midjourney"
      ? { models: channel.models.filter((model) => model !== "mj_edits") }
      : {}),
    hasKey: channel.authType === "none" || Boolean(sessionKeys.get(channel.id) || (channel.secretEnv && process.env[channel.secretEnv])),
  };
}

export function readGeminiImageSize(db: AppDatabase): ImageSizeValue {
  return normalizeImageSize(db.getSetting("geminiImageSize")) ?? DEFAULT_IMAGE_SIZE;
}

export function resolveChannelKey(channel: DbChannel, sessionKeys: KeyStore) {
  if (channel.authType === "none") return "";
  const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
  if (!key) throw new AppError("CHANNEL_AUTH_FAILED", "该渠道没有可用的 API Key", 400);
  return key;
}
