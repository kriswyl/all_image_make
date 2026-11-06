import { createRequire } from "node:module";
import path from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist";

async function withPdf<T>(bytes: Buffer, operation: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("文件不是有效的 PDF 文档");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");
  const task = getDocument({ data: new Uint8Array(bytes), useWasm: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    cMapUrl: `${root}/cmaps/`, standardFontDataUrl: `${root}/standard_fonts/` });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 1000) throw new Error("PDF 超过 1000 页，请拆分后上传");
    return await operation(pdf);
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("PDF 已加密，请先解密再上传");
    throw error;
  } finally {
    await task.destroy();
  }
}

export function inspectPdf(bytes: Buffer) {
  return withPdf(bytes, async (pdf) => pdf.numPages);
}

export function readPdfPage(bytes: Buffer, page: number) {
  return withPdf(bytes, async (pdf) => {
    if (!Number.isInteger(page) || page < 1 || page > pdf.numPages) throw new Error(`PDF 页码应在 1 到 ${pdf.numPages} 之间`);
    const source = await pdf.getPage(page);
    try {
      const { items } = await source.getTextContent();
      const text = items.flatMap(item => "str" in item ? [item.str, item.hasEOL ? "\n" : " "] : []).join("").trim();
      return { text, page, totalPages: pdf.numPages, nextPage: page < pdf.numPages ? page + 1 : null,
        warning: text ? undefined : "这一页没有可提取的文字，可能是扫描件或图片，需要 OCR。" };
    } finally {
      source.cleanup();
    }
  });
}
