/**
 * 语布的产品标。
 *
 * 母版是 `design` 里定稿的 ChatCanvas 图标（黑色 mark + 右下角的「画布」块），
 * 上面的 `brand-mark.png` 是从设计稿裁出来的透明底版本：白底去掉、四周留白收紧，
 * 22px 侧栏尺寸下仍然是清楚的。**不要再用文字/描边现画一个**——和 logo 母版会比不上。
 *
 * 同一份图标的 App 版本（黑底圆角方块）在 `public/app-icon.png`，Tauri 的各尺寸图标
 * 由 `npx tauri icon` 从同一个源生成。
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <img
      className="brand-mark-img"
      src="/brand-mark.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
      decoding="async"
    />
  );
}
