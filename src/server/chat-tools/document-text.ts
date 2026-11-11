

export function decodeText(bytes: Buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件不是有效的 UTF-8 文本，不能安全读取或修改"); }
}

export function editTextDocument(originalBytes: Buffer, edits: Array<{ find: string; replace: string }>, ext: string) {
  if (originalBytes.length > 2_000_000) throw new Error("文本文件超过 2 MB，当前无法安全修改");
  let text = decodeText(originalBytes);
  for (const [index, edit] of edits.entries()) {
    const first = text.indexOf(edit.find);
    if (first < 0) throw new Error(`第 ${index + 1} 处修改未找到原文，请重新读取文件`);
    if (text.indexOf(edit.find, first + 1) !== -1) throw new Error(`第 ${index + 1} 处原文匹配多次，请提供更多上下文以确定位置`);
    text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
    if (Buffer.byteLength(text, "utf8") > 2_000_000) throw new Error("修改后的文本超过 2 MB");
  }
  if (ext === "json") { try { JSON.parse(text); } catch { throw new Error("修改后的 JSON 无效，未创建文件"); } }
  const bom = originalBytes.length >= 3 && originalBytes[0] === 0xef && originalBytes[1] === 0xbb && originalBytes[2] === 0xbf;
  const bytes = Buffer.from(`${bom ? "\uFEFF" : ""}${text}`, "utf8");
  return bytes;
}
