import { BRAND } from "../shared/brand.generated";
/**
 * 语布的产品标。
 *
 * 母版是 `design` 里定稿的 ChatCanvas 图标（黑色 mark + 右下角的「画布」块），
 * `public/brand-mark.png` 是从设计稿裁出来的透明底版本。
 *
 * 用 CSS 蒙版（mask）填 `--ink`：浅色主题是黑、深色主题是暖白，
 * 和侧栏文字同色。品牌色只留给创作内容那一侧（示例作品、生成动画）。
 * 换 Logo 只需要替换 png，不用重画任何矢量。
 *
 * 同一份图标的 App 版本（黑底圆角方块）在 `public/app-icon.png`，Tauri 的各尺寸图标
 * 由 `npx tauri icon` 从同一个源生成。
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  if (!BRAND.web.monochromeMark) {
    return <img src={BRAND.web.mark} alt={BRAND.displayName} width={size} height={size} style={{ objectFit: "contain" }} />;
  }
  return (
    <span
      className="brand-mark-img"
      style={{ width: size, height: size }}
      role="img"
      aria-label={BRAND.displayName}
    />
  );
}
