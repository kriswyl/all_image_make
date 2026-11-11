import { referenceMediaType } from "../shared/reference-media";

/**
 * 给本地选中的素材补一个规范 MIME 再往下传。
 *
 * `.m4a` 在 Windows 上经常拿不到 `File.type`（空串），表单会以
 * `application/octet-stream` 发出去，服务端的类型白名单会直接拒掉。这里按扩展名
 * 把类型补齐；类型已经对得上的文件原样返回，不复制字节。
 */
export function withReferenceMediaType(file: File): File {
  const detected = referenceMediaType(file);
  if (!detected || file.type === detected.mime) return file;
  try {
    return new File([file], file.name, { type: detected.mime, lastModified: file.lastModified });
  } catch {
    // 极老的运行环境不支持 File 构造：退回原文件，服务端还有扩展名兜底
    return file;
  }
}
