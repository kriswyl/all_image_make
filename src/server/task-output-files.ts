import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { AppDatabase, DbChannel } from "./db.js";
import type { KeyStore } from "./key-store.js";
import type { AsyncResult } from "./async-providers.js";
import { applyAuth, extractAudioCandidates, extractImageCandidates, type ImageCandidate } from "./adapters.js";
import { AppError } from "./app-error.js";
import { safeFetch, safeFileName } from "./security.js";
import { audioExtensionForMime, extensionForMime, videoExtensionForMime, wavDurationSeconds } from "./task-media.js";
import { detectImageMime, writeThumbnail } from "./vision.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export class TaskOutputFiles {
  constructor(
    private readonly db: Pick<AppDatabase, "assetsDir" | "thumbsDir" | "insertAsset">,
    private readonly sessionKeys: Pick<KeyStore, "get">,
  ) {}

  async saveSynchronous(taskId: string, payload: unknown, channel: DbChannel, prompt: string) {
    // 同步音频：Gemini TTS 把 WAV 以 base64 内联在 generateContent 响应里
    const audioCandidates = extractAudioCandidates(payload);
    if (audioCandidates.length) {
      await this.saveAudios(taskId, audioCandidates.map((audio, index) => ({
        ...audio,
        kind: "audio" as const,
        title: audio.title ?? speechTitle(prompt, index),
      })), channel);
      return;
    }

    // Sync response: extract images immediately
    const images = extractImageCandidates(payload);
    if (images.length) {
      await this.saveImages(taskId, images, channel);
      return;
    }

    throw new AppError("RESPONSE_PARSE_FAILED", "响应中没有找到可保存的产物", 502);
  }

  /**
   * 按产物类型落盘。
   *
   * 视频走 `saveVideos`，音乐/配音走 `saveAudios`。把分派放在这里，
   * 轮询器不用知道「视频怎么下载、音频怎么下载」。
   */
  async saveResults(taskId: string, results: AsyncResult[], channel: DbChannel) {
    const videos = results.filter((item) => item.kind === "video");
    const audios = results.filter((item) => item.kind === "audio");
    const images = results.filter((item) => item.kind === "image");
    if (videos.length) await this.saveVideos(taskId, videos, channel);
    if (audios.length) await this.saveAudios(taskId, audios, channel);
    if (images.length) await this.saveImages(taskId, images.map((item) => ({ url: item.url, mimeType: item.mimeType })), channel);
    if (!videos.length && !audios.length && !images.length) {
      throw new AppError("RESPONSE_PARSE_FAILED", "暂不支持保存这种产物", 502);
    }
  }

  private async saveVideos(taskId: string, videos: AsyncResult[], channel: DbChannel) {
    // 目录在写盘和入库之间必须保持一致，取一次而不是每次读 getter
    const baseDir = this.db.assetsDir;
    let saved = 0;
    // 一次可能返回多个结果（n>1，或上游把同一段视频放在多个字段里）；全部保存，
    // 由展示层决定主产物，别再像以前那样只看第一个。
    for (const video of videos.slice(0, 8)) {
      const { bytes, contentType } = await this.fetchAssetBytes(video.url, channel, "视频");
      if (bytes.length > MAX_VIDEO_BYTES) throw new AppError("ASSET_TOO_LARGE", "视频超过 200 MB 限制", 502);
      const mimeType = video.mimeType ?? (contentType.startsWith("video/") ? contentType : undefined)
        ?? (video.url.toLowerCase().includes(".webm") ? "video/webm" : "video/mp4");
      const extension = videoExtensionForMime(mimeType);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: bytes.length,
        relativePath: fileName, baseDir, sha256, duration: video.duration,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的视频", 502);
  }

  /**
   * 音乐一次返回多首（Suno 通常是 2 首），每首带一张封面。
   * 封面写进现有的 `thumb_path`，不再单独建一条图片 asset——否则历史里会多出
   * 一张「不是用户要的图」，删除/清空时也不好解释。
   */
  private async saveAudios(taskId: string, audios: AsyncResult[], channel: DbChannel) {
    const baseDir = this.db.assetsDir;
    let saved = 0;
    for (const audio of audios.slice(0, 8)) {
      const { bytes, contentType } = await this.fetchAssetBytes(audio.url, channel, "音频");
      if (bytes.length > MAX_AUDIO_BYTES) throw new AppError("ASSET_TOO_LARGE", "音频超过 100 MB 限制", 502);
      const mimeType = audio.mimeType ?? (contentType.startsWith("audio/") ? contentType : undefined)
        ?? (audio.url.toLowerCase().includes(".wav") ? "audio/wav"
          : audio.url.toLowerCase().includes(".mp3") ? "audio/mpeg"
            : "audio/mp4");
      // 第二道闸：图片 inlineData 被误判成音频时，宁可跳过也不写一条 .m4a 的图片
      if (!mimeType.startsWith("audio/")) continue;
      const extension = audioExtensionForMime(mimeType);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, bytes);

      // 封面失败不影响音频本身：缩略图接口会 404，前端回落到通用音乐图标
      let thumbPath: string | null = null;
      if (audio.coverUrl) {
        try {
          const cover = await this.fetchAssetBytes(audio.coverUrl, channel, "音频封面", "image/*");
          if (cover.contentType.startsWith("image/") || !cover.contentType) {
            thumbPath = await writeThumbnail(this.db, id, cover.bytes);
          }
        } catch {
          // 封面是装饰，丢了不影响听歌
        }
      }

      const duration = audio.duration ?? (mimeType.includes("wav") ? wavDurationSeconds(bytes) : undefined);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: bytes.length,
        relativePath: fileName, baseDir, sha256, duration, thumbPath,
        title: audio.title,
        lyrics: audio.lyrics,
        tags: audio.tags,
        remoteClipId: audio.remoteClipId,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的音频", 502);
  }

  private async fetchAssetBytes(
    url: string,
    channel: DbChannel,
    label: string,
    accept = "*/*",
  ): Promise<{ bytes: Buffer; contentType: string }> {
    try {
      // Gemini TTS 把音频内联成 data URI；不把它当网络地址去 fetch
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match) throw new AppError("ASSET_DOWNLOAD_FAILED", `${label}的 data URI 格式不合法`, 502);
        const contentType = match[1] ?? "";
        const bytes = match[2]
          ? Buffer.from(match[3] ?? "", "base64")
          : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
        return { bytes, contentType };
      }
      const headers = this.assetDownloadHeaders(url, channel, accept);
      const response = await safeFetch(url, { method: "GET", headers }, { allowPrivateNetwork: channel.allowPrivateNetwork });
      if (!response.ok) {
        throw new AppError(
          "ASSET_DOWNLOAD_FAILED",
          `下载${label}失败：HTTP ${response.status}。地址：${url}`,
          502,
        );
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "ASSET_DOWNLOAD_FAILED",
        `下载${label}失败：${error instanceof Error ? error.message : "未知错误"}。地址：${url}`,
        502,
      );
    }
  }


  private async saveImages(taskId: string, images: ImageCandidate[], channel: DbChannel) {
    const baseDir = this.db.assetsDir;
    let saved = 0;
    // 部分中转会把同一张图同时放在 base64 与 URL 等多个位置，按字节内容去重避免落盘重复图片
    const seenHashes = new Set<string>();
    for (const image of images.slice(0, 8)) {
      const resolved = await this.resolveImage(image, channel);
      if (resolved.bytes.length > MAX_IMAGE_BYTES) throw new AppError("ASSET_TOO_LARGE", "图片超过 30 MB 限制", 502);
      /*
       * 以字节头为准。Gemini 的 inlineData 经常把 JPEG 标成 image/png，
       * 之前按声明存成 .png 后，再把这张图当参考图发出去就会被
       * 「参考图格式与文件内容不匹配」拦住——整批分镜全挂。
       */
      const mimeType = detectImageMime(resolved.bytes) ?? resolved.mimeType;
      if (!mimeType.startsWith("image/")) throw new AppError("ASSET_INVALID", "响应内容不是图片", 502);
      const sha256 = crypto.createHash("sha256").update(resolved.bytes).digest("hex");
      if (seenHashes.has(sha256)) continue;
      seenHashes.add(sha256);
      const extension = extensionForMime(mimeType);
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, resolved.bytes);
      // 缩略图在这里就生成好（§11.4）：Agent 续跑时马上要拿它喂大脑和画布徽章，
      // 「用的时候再缩」会让每一轮都白等一次解码。失败不抛异常，静默留空
      const thumbPath = await writeThumbnail(this.db, id, resolved.bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: resolved.bytes.length,
        relativePath: fileName, baseDir, sha256, thumbPath,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的图片", 502);
  }

  /**
   * 下载产物用的请求头。
   *
   * 中转站自带的资产地址（形如 `https://gateway.example/v1/images/assets/<uuid>`）通常要带 key
   * 才肯给图，不带就是 403——用户看到的现象正是「响应体里明明有 url，却一直拿不到图片」。
   * 但 key **只能发给渠道自己那台主机**：产物地址也可能是公开的 OSS / CDN，
   * 往那儿带 Authorization 等于把密钥送给第三方。
   *
   * `query` 鉴权不在这里重放：那个类型要把 key 拼进 URL，而我们只是去取一个别人给的地址，
   * 拼错了反而会把地址弄坏。这类网关的资产地址一般本来就是公开的。
   */
  private assetDownloadHeaders(url: string, channel: DbChannel, accept: string): Record<string, string> {
    // 部分 CDN（Suno 的封面就是）对无 UA 的请求回 403，浏览器却能打开
    const headers: Record<string, string> = { Accept: accept, "User-Agent": "Mozilla/5.0" };
    if (channel.authType === "none" || channel.authType === "query") return headers;
    let host = "";
    let channelHost = "";
    try {
      host = new URL(url).host;
      channelHost = new URL(channel.baseUrl).host;
    } catch {
      return headers;
    }
    if (!host || host !== channelHost) return headers;
    const key = this.sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
    if (!key) return headers;
    applyAuth(url, headers, channel, key);
    return headers;
  }

  private async resolveImage(image: ImageCandidate, channel: DbChannel) {
    if (image.base64) {
      const clean = image.base64.replace(/^data:image\/[^;]+;base64,/, "").replace(/\s/g, "");
      return { bytes: Buffer.from(clean, "base64"), mimeType: image.mimeType ?? "image/png" };
    }
    if (!image.url) throw new AppError("ASSET_INVALID", "图片响应缺少 URL 或 Base64", 502);
    const headers = this.assetDownloadHeaders(image.url, channel, "image/*");
    const response = await safeFetch(image.url, { method: "GET", headers }, { allowPrivateNetwork: channel.allowPrivateNetwork });
    if (!response.ok) throw new AppError("ASSET_DOWNLOAD_FAILED", `图片下载失败：HTTP ${response.status}`, 502);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new AppError("ASSET_TOO_LARGE", "图片超过 30 MB 限制", 502);
    const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
  }
}

/** TTS 没有歌名，用正文第一行的前几十个字当标题，历史里才分得清 */
function speechTitle(prompt: string, index: number) {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return `语音 ${index + 1}`;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}
