/**
 * 动图 GIF 的抽帧解码。
 *
 * 聊天模型的 `image_url` 一次只能拿到一张静态图；直接把 GIF 传上去，
 * 多数上游只解码第一帧。图片模型生成的“GIF”也常常只有一帧，
 * 模型看不到这一点就会笼统地说“图在动”或“图没动”。
 *
 * 这里用 omggif 逐帧解码、按 GIF 的 disposal 规则合成画布，再按时间均匀抽样，
 * 交给大脑多张带时间戳的 JPEG。纯 JS，不依赖 ffmpeg，也不影响 Tauri 打包。
 *
 * 视频（mp4/webm）不在这里处理：没有内置解码器，无法可靠抽帧。
 */
import { Jimp, JimpMime } from "jimp";
import { GifReader } from "omggif";

/** 一张图最多回灌几帧；再多既贵又会挤掉别的图片 */
export const GIF_VISION_MAX_FRAMES = 6;
/** 抽样帧的长边；和缩略图同一档，足够判断动作 */
const GIF_VISION_MAX_EDGE = 512;

export interface GifSampleFrame {
  /** 在原 GIF 里的帧序号（从 0 开始） */
  index: number;
  /** 这一帧开始显示的时间，毫秒 */
  timeMs: number;
  jpeg: Buffer;
}

export interface GifAnimation {
  width: number;
  height: number;
  frameCount: number;
  /** 所有帧延迟之和，毫秒。部分生成器的延迟为 0，此时为 0 */
  durationMs: number;
  frames: GifSampleFrame[];
}

function sampleIndices(frameCount: number, maxFrames: number) {
  const limit = Math.max(1, Math.min(frameCount, Math.floor(maxFrames) || 1));
  if (frameCount <= limit) return Array.from({ length: frameCount }, (_, index) => index);
  const picked = new Set<number>();
  for (let slot = 0; slot < limit; slot += 1) {
    picked.add(Math.round((slot * (frameCount - 1)) / (limit - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

function clearRect(canvas: Uint8Array, width: number, rect: { x: number; y: number; width: number; height: number }) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    const start = (y * width + rect.x) * 4;
    canvas.fill(0, start, start + rect.width * 4);
  }
}

async function encodeFrame(canvas: Uint8Array, width: number, height: number): Promise<Buffer> {
  // JPEG 没有 alpha。GIF 的透明像素按白底铺开，比默认的黑底更接近用户看到的画面。
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    const alpha = canvas[offset + 3]! / 255;
    rgba[offset] = Math.round(canvas[offset]! * alpha + 255 * (1 - alpha));
    rgba[offset + 1] = Math.round(canvas[offset + 1]! * alpha + 255 * (1 - alpha));
    rgba[offset + 2] = Math.round(canvas[offset + 2]! * alpha + 255 * (1 - alpha));
    rgba[offset + 3] = 255;
  }
  const image = Jimp.fromBitmap({ data: rgba, width, height });
  if (Math.max(width, height) > GIF_VISION_MAX_EDGE) {
    image.scaleToFit({ w: GIF_VISION_MAX_EDGE, h: GIF_VISION_MAX_EDGE });
  }
  return image.getBuffer(JimpMime.jpeg, { quality: 80 });
}

/**
 * 解码 GIF 并抽样。失败（损坏、非 GIF、空帧）返回 null，由调用方退回单帧缩略图。
 *
 * 为了正确合成，必须顺序解码每一帧；只对抽样帧做 JPEG 编码，因此帧数很多时
 * 主要成本是 LZW 解码，而不是编码和内存里的图片。
 */
export async function readGifAnimation(bytes: Buffer, maxFrames = GIF_VISION_MAX_FRAMES): Promise<GifAnimation | null> {
  let reader: GifReader;
  try {
    reader = new GifReader(bytes);
  } catch {
    return null;
  }
  const frameCount = reader.numFrames();
  if (!frameCount) return null;

  const width = reader.width;
  const height = reader.height;
  if (!width || !height) return null;

  const wanted = new Set(sampleIndices(frameCount, maxFrames));
  const canvas = new Uint8Array(width * height * 4);
  const frames: GifSampleFrame[] = [];
  let elapsedMs = 0;
  let previousDisposal = 0;
  let previousRect = { x: 0, y: 0, width: 0, height: 0 };
  let savedCanvas: Uint8Array | null = null;

  try {
    for (let index = 0; index < frameCount; index += 1) {
      if (index > 0) {
        if (previousDisposal === 2) clearRect(canvas, width, previousRect);
        else if (previousDisposal === 3 && savedCanvas) canvas.set(savedCanvas);
      }
      const info = reader.frameInfo(index);
      // disposal 3 要恢复“画这一帧之前”的画面
      savedCanvas = info.disposal === 3 ? canvas.slice() : null;
      reader.decodeAndBlitFrameRGBA(index, canvas);
      if (wanted.has(index)) {
        frames.push({ index, timeMs: elapsedMs, jpeg: await encodeFrame(canvas, width, height) });
      }
      previousDisposal = info.disposal;
      previousRect = { x: info.x, y: info.y, width: info.width, height: info.height };
      elapsedMs += Math.max(0, info.delay) * 10;
    }
  } catch {
    return null;
  }

  if (!frames.length) return null;
  return { width, height, frameCount, durationMs: elapsedMs, frames };
}
