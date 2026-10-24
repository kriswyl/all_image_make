/**
 * Midjourney 的 U/V/R 按钮组。
 *
 * MJ 一次出的是四宫格，U1–U4 / V1–V4 分别对应原图的四个象限。这里把按钮也排成
 * 2×2：左上是 U1/V1，右上是 U2/V2，依此类推。重绘没有象限，单独放在下面一行。
 *
 * 对话创作和图片生成共用这一份，避免两处样式/含义再次走偏。
 */
import { LoaderCircle } from "lucide-react";
import {
  groupMidjourneyButtons, midjourneyActionTooltip, midjourneyButtonLabel,
  type MidjourneyButton,
} from "../../shared/midjourney";

export function MidjourneyActions({
  buttons,
  busy = false,
  activeId = null,
  onAct,
  className = "",
}: {
  buttons: MidjourneyButton[];
  /** 整组禁用（提交中） */
  busy?: boolean;
  /** 正在执行的那个按钮，用于显示转圈 */
  activeId?: string | null;
  onAct: (button: MidjourneyButton) => void;
  className?: string;
}) {
  const { quadrants, extras } = groupMidjourneyButtons(buttons);

  const renderButton = (button: MidjourneyButton) => (
    <button
      key={button.customId}
      type="button"
      data-tooltip={midjourneyActionTooltip(button)}
      disabled={busy}
      onClick={() => onAct(button)}
    >
      {activeId === button.customId
        ? <LoaderCircle className="spin" size={13} />
        : button.emoji ? <span aria-hidden="true">{button.emoji}</span> : null}
      {midjourneyButtonLabel(button)}
    </button>
  );

  return (
    <div className={`mj-quad-actions ${className}`.trim()} aria-label="Midjourney 后续操作">
      {quadrants.size ? (
        <div className="mj-quad-grid">
          {[1, 2, 3, 4].map((index) => {
            const cell = quadrants.get(index);
            if (!cell) return null;
            return (
              <div
                key={index}
                className="mj-quad"
                // 和原图象限对应；缺哪张就空着，不把其他格子挤乱
                style={{ gridArea: `${index <= 2 ? 1 : 2} / ${index % 2 ? 1 : 2}` }}
              >
                {[cell.upscale, cell.variation].filter(Boolean).map((button) => renderButton(button as MidjourneyButton))}
              </div>
            );
          })}
        </div>
      ) : null}
      {extras.length ? (
        <div className="mj-quad-extras">{extras.map(renderButton)}</div>
      ) : null}
    </div>
  );
}
