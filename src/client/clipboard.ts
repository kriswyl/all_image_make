/** 复制一段文字；老 WebView 没有 clipboard.writeText 时退回 textarea + execCommand */
export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("当前环境不支持复制文本");
}

/**
 * 把图片写进系统剪贴板。
 *
 * WebView2 / 现代浏览器只稳定支持 PNG 的 ClipboardItem，所以 jpeg/webp 先转 PNG。
 * 复制图片必须由用户手势触发（按钮点击或 Ctrl+C 快捷键），这里只负责写。
 */
export async function copyImageToClipboard(blob: Blob) {
  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    throw new Error("当前环境不支持复制图片到剪贴板");
  }
  const png = blob.type === "image/png" ? blob : await toPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

async function toPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("图片解码失败，无法复制"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法转换图片格式");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片转换失败")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
