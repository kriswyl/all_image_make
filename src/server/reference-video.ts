import { assertSafeUrl, safeFileName } from "./security.js";
import { AppError } from "./tasks.js";
import type { DbChannel } from "./db.js";
import type { KeyStore } from "./key-store.js";

export async function uploadReferenceVideo(channel: DbChannel, keys: KeyStore, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<string> {
  if (!channel.uploadEndpoint) throw new AppError("UPLOAD_UNSUPPORTED", "该渠道未配置视频上传服务", 400);
  if (!['video/mp4', 'video/quicktime'].includes(file.mimetype) || file.buffer.length < 12 || file.buffer.subarray(4, 8).toString("ascii") !== "ftyp") throw new AppError("REFERENCE_VIDEO_INVALID", "仅支持有效的 MP4 / MOV 视频", 400);
  if (file.buffer.length > 100 * 1024 * 1024) throw new AppError("REFERENCE_VIDEO_INVALID", "视频不能超过 100 MB", 400);
  await assertSafeUrl(channel.uploadEndpoint, channel.allowPrivateNetwork);
  const headers = new Headers();
  for (const [name, value] of Object.entries(channel.uploadHeaders ?? {})) {
    if (/^(authorization|cookie|host|content-length|content-type)$/i.test(name)) throw new AppError("UPLOAD_INVALID_HEADERS", "上传附加请求头不能覆盖鉴权或文件类型", 400);
    headers.set(name, value);
  }
  const key = channel.authType === "none" ? "" : keys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
  if (channel.authType !== "none" && !key) throw new AppError("CHANNEL_AUTH_FAILED", "该渠道没有可用的 API Key", 400);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }), safeFileName(file.originalname));
  let response: Response;
  try { response = await fetch(channel.uploadEndpoint, { method: "POST", headers, body: form, redirect: "manual", signal: AbortSignal.timeout(180_000) }); }
  catch { throw new AppError("UPLOAD_FAILED", "上传视频失败，请检查上传服务和网络", 502); }
  if (!response.ok) throw new AppError("UPLOAD_FAILED", `上传视频失败：HTTP ${response.status}`, 502);
  const payload: unknown = await response.json().catch(() => null);
  const url = payload && typeof payload === "object" && "url" in payload ? (payload as { url: unknown }).url : "";
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new AppError("UPLOAD_FAILED", "上传服务没有返回有效的公网地址", 502);
  return url;
}
