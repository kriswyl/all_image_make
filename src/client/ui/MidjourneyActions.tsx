/**
 * Midjourney 的 U/V/R 按钮组。
 *
 * MJ 一次出的是四宫格，U1–U4 / V1–V4 分别对应原图的四个象限。这里把两组按钮
 * 各排成一个 2×2 小键盘：放大在左、变体在右，重绘单独一列。每个小键盘的格子
 * 和原图象限一一对应，看一眼就知道按的是哪张图。
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

  const content = (button: MidjourneyButton) => (
    <>
      {activeId === button.customId
        ? <LoaderCircle className="spin" size={13} />
        : button.emoji ? <span aria-hidden="true">{button.emoji}</span> : null}
      {midjourneyButtonLabel(button)}
    </>
  );

  /**
   * 一组 2×2 小键盘。格子的 gridArea 跟着象限走：1=左上、2=右上、3=左下、4=右下；
   * 缺哪张就空着，不把其他格子挤乱。
   */
  const renderGrid = (kind: "upscale" | "variation") => {
    const cells = [1, 2, 3, 4]
      .map((index) => ({ index, button: quadrants.get(index)?.[kind] }))
      .filter((cell): cell is { index: number; button: MidjourneyButton } => Boolean(cell.button));
    if (!cells.length) return null;
    return (
      <div className={`mj-quad-grid mj-quad-grid-${kind}`}>
        {cells.map(({ index, button }) => (
          <button
            key={button.customId}
            type="button"
            data-tooltip={midjourneyActionTooltip(button)}
            aria-label={midjourneyButtonLabel(button)}
            style={{ gridArea: `${index <= 2 ? 1 : 2} / ${index % 2 ? 1 : 2}` }}
            disabled={busy}
            onClick={() => onAct(button)}
          >
            {/* 小键盘里只写 U1/V1，动作由左右两列区分，省出空间也更好对照原图 */}
            {activeId === button.customId ? <LoaderCircle className="spin" size={13} /> : null}
            {kind === "upscale" ? "U" : "V"}{index}
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className={`mj-quad-actions ${className}`.trim()} aria-label="Midjourney 后续操作">
      <div className="mj-quad-blocks">
        {renderGrid("upscale")}
        {renderGrid("variation")}
        {extras.length ? (
          <div className="mj-quad-extras">
            {extras.map((button) => (
              <button
                key={button.customId}
                type="button"
                data-tooltip={midjourneyActionTooltip(button)}
                disabled={busy}
                onClick={() => onAct(button)}
              >
                {content(button)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
