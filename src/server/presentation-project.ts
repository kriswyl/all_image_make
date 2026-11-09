import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { z } from "zod";
import { aiPresentationSchema, type AiPresentation } from "./mind-document.js";
import { designSchema } from "./presentation-elements.js";

const MANIFEST = "chatcanvas/presentation.json";
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false });
/** 只对 ppt/ 部件算指纹：ZIP 时间戳、条目顺序和压缩结果不参与。 */
export async function contentFingerprint(zip: JSZip): Promise<string> {
  const hash = createHash("sha256");
  for (const name of Object.keys(zip.files).filter((name) => name.startsWith("ppt/") && !zip.files[name]!.dir).sort()) {
    hash.update(name).update("\0").update(await zip.file(name)!.async("nodebuffer")).update("\0");
  }
  return hash.digest("hex");
}
async function archiveOf(bytes: Buffer) {
  if (bytes.length > 20 * 1024 * 1024) throw new Error("PPT 文件超过 20 MB");
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 5000 || entries.some((entry) => /(?:^|\/)\.\.(?:\/|$)/.test(entry.name) || /vbaProject\.bin$/i.test(entry.name))) throw new Error("PPT 包含不支持的内容");
  let total = 0;
  for (const entry of entries.filter((item) => !item.dir)) {
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > 25 * 1024 * 1024 || (total += size) > 80 * 1024 * 1024) throw new Error("PPT 解压内容过大");
  }
  if (!zip.file("ppt/presentation.xml")) throw new Error("不是有效的 PPTX 文件");
  return zip;
}

/** Store editable source alongside OOXML; reuse media bytes instead of duplicating base64 payloads. */
export async function packPresentationProject(bytes: Buffer, plan: AiPresentation, images: Array<{ title: string; data: string }>): Promise<Buffer> {
  const zip = await archiveOf(bytes);
  const byHash = new Map<string, string>();
  for (const entry of Object.values(zip.files).filter((file) => /^ppt\/media\/.+\.(?:png|jpe?g)$/i.test(file.name))) byHash.set(createHash("sha256").update(await entry.async("nodebuffer")).digest("hex"), entry.name);
  const assets = images.map((image, index) => {
    const match = /^(?:data:)?image\/(png|jpeg);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(image.data);
    if (!match) throw new Error("PPT 项目图片格式不受支持");
    const data = Buffer.from(match[2]!, "base64"), hash = createHash("sha256").update(data).digest("hex");
    let media = byHash.get(hash);
    if (!media) { media = `ppt/media/chatcanvas-source-${index}.${match[1] === "png" ? "png" : "jpg"}`; zip.file(media, data); byHash.set(hash, media); }
    return { title: image.title.slice(0, 2000), path: media };
  });
  zip.file(MANIFEST, JSON.stringify({ version: 1, fingerprint: await contentFingerprint(zip), plan: aiPresentationSchema.parse(plan), images: assets }));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function readPresentationProject(bytes: Buffer): Promise<{ plan: AiPresentation; images: Array<{ title: string; data: string }> } | null> {
  const zip = await archiveOf(bytes), file = zip.file(MANIFEST);
  if (!file) return null;
  const value = z.object({ version: z.literal(1), fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(), plan: aiPresentationSchema, images: z.array(z.object({ title: z.string().max(2000), path: z.string().regex(/^ppt\/media\/[A-Za-z0-9_.-]+\.(?:png|jpe?g)$/i) })).max(200) }).parse(JSON.parse(await file.async("string")));
  if (value.fingerprint && value.fingerprint !== await contentFingerprint(zip)) throw new Error("PPT 已在外部修改，可编辑源方案可能过期；为避免丢失手工修改，已停止自动重建");
  let total = 0;
  const images = [];
  for (const image of value.images) {
    const entry = zip.file(image.path); if (!entry) throw new Error("PPT 项目图片缺失");
    const data = await entry.async("nodebuffer"); total += data.length;
    const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if ((!png && !jpeg) || data.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error("PPT 项目图片无效或过大");
    images.push({ title: image.title, data: `image/${png ? "png" : "jpeg"};base64,${data.toString("base64")}` });
  }
  return { plan: value.plan, images };
}

/** Theme-only import: no macros, relationships, external resources or master objects are executed/copied. */
export async function readPresentationStyle(bytes: Buffer) {
  const zip = await archiveOf(bytes);
  const themeFile = zip.file("ppt/theme/theme1.xml");
  if (!themeFile) throw new Error("参考 PPT 没有可读取的主题");
  const theme = parser.parse(await themeFile.async("string"))?.["a:theme"]?.["a:themeElements"];
  const scheme = theme?.["a:clrScheme"];
  const get = (key: string): string | undefined => {
    const node = scheme?.[`a:${key}`]; const value = node?.["a:srgbClr"]?.["@_val"] ?? node?.["a:sysClr"]?.["@_lastClr"];
    return typeof value === "string" && /^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined;
  };
  const fonts = theme?.["a:fontScheme"]?.["a:minorFont"];
  const alternate = Array.isArray(fonts?.["a:font"]) ? fonts["a:font"].find((item: Record<string, string>) => item["@_script"] === "Hans")?.["@_typeface"] : undefined;
  const font = alternate || fonts?.["a:ea"]?.["@_typeface"] || "Microsoft YaHei";
  const presentation = parser.parse(await zip.file("ppt/presentation.xml")!.async("string"))?.["p:presentation"]?.["p:sldSz"];
  const width = Number(presentation?.["@_cx"]) / 914400, height = Number(presentation?.["@_cy"]) / 914400;
  let embedded = {};
  const source = zip.file(MANIFEST);
  if (source) {
    try {
      const metadata = JSON.parse(await source.async("string"));
      if (!metadata.fingerprint || metadata.fingerprint === await contentFingerprint(zip)) embedded = designSchema.parse(metadata.plan?.design ?? {});
    } catch { /* Reference can still use its actual OOXML theme, never stale editable source. */ }
  }
  return { design: designSchema.parse({ accent: get("accent1"), text: get("dk1"), background: get("lt1"), fontFace: String(font).slice(0, 80), ...embedded }), sourceSize: Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null, warning: "仅参考主题颜色和字体；输出保持16:9，不复制原母版、动画和页面布局。" };
}
