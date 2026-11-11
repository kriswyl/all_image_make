/**
 * 参考素材（视频 / 音频）的类型判定。
 *
 * 浏览器的 `File.type` 来自系统注册表，同一个文件在不同机器上可能是
 * `audio/mp4`、`audio/x-m4a`，也可能干脆是空串——`.m4a` 在 Windows 上就常常
 * 拿不到类型，表单里会以 `application/octet-stream` 发出去，服务端按 MIME
 * 白名单一拦就变成「上传不上去」。所以这里统一按**扩展名优先**判：扩展名认得
 * 就按扩展名给一个规范 MIME，认不得再看 MIME 前缀。
 *
 * 客户端用它挑输入框、补 MIME；服务端用同一份规则校验上传，两边不会各说一套。
 */

export type ReferenceMediaKind = "video" | "audio";

/** 扩展名（小写）→ 规范 MIME。上游只收这些容器。 */
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
};

const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
};

export interface ReferenceMediaType {
  kind: ReferenceMediaKind;
  /** 规范化后的 MIME：上传时用它，别把空类型原样传给服务端 */
  mime: string;
}

/** 文件扩展名，统一小写——`.M4A` 和 `.m4a` 是同一种文件 */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * 判断一个文件属于哪类参考素材。
 *
 * @param file 只要带 `name` 与 `type` 即可：浏览器给的是 File，服务端给的是
 *   `{ name: originalname, type: mimetype }`。
 * @returns 不接受的类型返回 null（由调用方给出提示文案）。
 */
export function referenceMediaType(file: { name: string; type: string }): ReferenceMediaType | null {
  const extension = fileExtension(file.name);
  if (VIDEO_TYPES[extension]) return { kind: "video", mime: VIDEO_TYPES[extension] };
  if (AUDIO_TYPES[extension]) return { kind: "audio", mime: AUDIO_TYPES[extension] };

  // 没有扩展名（或扩展名不认识）时退回 MIME：拖拽进来的 blob 常常只有类型
  const mime = (file.type || "").toLowerCase();
  if (mime === "video/mp4" || mime === "video/quicktime") return { kind: "video", mime };
  if (mime.startsWith("audio/")) return { kind: "audio", mime };
  return null;
}
