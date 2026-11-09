import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Film, Image as ImageIcon, Music } from "lucide-react";
import { useAnchoredPanelStyle, usePanelDismiss } from "./useAnchoredPanel";

/**
 * 「@ 引用素材」浮层。
 *
 * 与截图一致：顶部是「全部 / 视频 / 图片 / 音频」四个页签，下面是带缩略图的素材
 * 列表。选中后往提示词里插一个 `@图片1` 这样的记号，顺序与提交时素材数组一致，
 * 所以提示词里说「参考 @图片2 的配色」时，指向的就是第 2 张图。
 *
 * 同样是 portal：开关浮层不会重新挂载创作框里的 textarea。
 */

export interface MentionItem {
  /** 插进提示词的记号，如 图片1 / 视频1 / 音频1 */
  label: string;
  kind: "视频" | "图片" | "音频";
  previewUrl?: string;
}

const TABS = ["全部", "视频", "图片", "音频"] as const;
type Tab = typeof TABS[number];

export interface VideoMentionPanelProps {
  open: boolean;
  anchor: HTMLElement | null;
  items: MentionItem[];
  onClose: () => void;
  onSelect: (label: string) => void;
}

export function VideoMentionPanel({ open, anchor, items, onClose, onSelect }: VideoMentionPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("全部");
  // @ 按钮在创作框右上角：面板右缘对齐按钮右缘（收进窗口），
  // 左对齐会把面板推到窗口最右边，一半悬在窗外。
  const style = useAnchoredPanelStyle(open, anchor, 268, 380, "end");
  usePanelDismiss(open, onClose, panelRef, anchor);

  // 每次打开都回到「全部」，不继承上一次的筛选
  useEffect(() => { if (open) setTab("全部"); }, [open]);

  if (!open || !style) return null;
  const list = tab === "全部" ? items : items.filter((item) => item.kind === tab);

  return createPortal(
    <div className="vstudio-panel vstudio-mention-panel" ref={panelRef} style={style} role="dialog" aria-label="引用素材">
      <div className="vstudio-mention-tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? "is-active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {list.length ? (
        <div className="vstudio-mention-list">
          {list.map((item) => (
            <button
              key={item.label}
              type="button"
              className="vstudio-mention-item"
              onClick={() => onSelect(item.label)}
            >
              <span className="vstudio-mention-thumb">
                {item.previewUrl && item.kind === "视频" ? (
                  // 视频的 objectURL 不能直接喂给 <img>，用 <video> 取首帧当缩略图
                  <video src={`${item.previewUrl}#t=0.1`} muted playsInline preload="metadata" />
                ) : item.previewUrl
                  ? <img src={item.previewUrl} alt="" />
                  : item.kind === "音频" ? <Music size={16} /> : item.kind === "视频" ? <Film size={16} /> : <ImageIcon size={16} />}
              </span>
              <span className="vstudio-mention-label">{item.label}</span>
              <span className="vstudio-mention-kind">{item.kind}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="vstudio-hint">当前生成方式还没有素材。先上传图片、参考视频或参考音频，再来 @ 引用。</p>
      )}
    </div>,
    document.body,
  );
}
