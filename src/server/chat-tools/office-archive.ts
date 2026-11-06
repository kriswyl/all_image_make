import JSZip from "jszip";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);
type ArchiveEntry = JSZip.JSZipObject;
type CompressedPart = { uncompressedSize: number; compression: { magic: string }; compressedContent: Uint8Array };

function entryData(file: ArchiveEntry) {
  return (file as unknown as { _data: CompressedPart | Promise<unknown> })._data;
}

/** Check the ZIP directory before inflating any Office parts. */
export async function openOfficeArchive(bytes: Buffer, mainPart: string, label: string) {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); }
  catch { throw new Error(`无法读取 ${label} 文件，文件可能已损坏或加密`); }
  if (!zip.file(mainPart)) throw new Error(`文件不是有效的 ${label} 文档`);
  const files = Object.values(zip.files).filter(entry => !entry.dir);
  let total = 0;
  if (files.length > 2_000) throw new Error(`${label} 文件包含过多组件，请拆分后重试`);
  for (const file of files) {
    // Loaded empty entries become a resolved Promise. Other entries retain compressed data and a declared size.
    const data = entryData(file);
    const size = data instanceof Promise ? 0 : data?.uncompressedSize;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) throw new Error(`${label} 文件组件过大或已损坏`);
    total += size;
    if (total > 96 * 1024 * 1024) throw new Error(`${label} 文件解压后过大，请拆分后重试`);
    if (/\/vbaProject\.bin$/i.test(file.name)) throw new Error(`含宏的 ${label} 文件请先另存为无宏版本`);
  }
  return zip;
}

export async function readOfficePart(file: ArchiveEntry) {
  const data = entryData(file);
  if (data instanceof Promise) return Buffer.alloc(0);
  const expected = data.uncompressedSize;
  // Bound actual inflation even when the ZIP advertises a false uncompressed size.
  let bytes: Buffer;
  if (data.compression.magic === "\0\0") bytes = Buffer.from(data.compressedContent);
  else if (data.compression.magic === "\x08\0") bytes = await inflate(data.compressedContent, { maxOutputLength: Math.max(1, expected) });
  else throw new Error("Office 文件使用了不支持的压缩格式");
  if (bytes.length !== expected) throw new Error("Office 文件组件长度不正确");
  return bytes;
}
