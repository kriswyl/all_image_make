import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Film, Image as ImageIcon, Music, Upload } from "lucide-react";
import { useAnchoredPanelStyle, usePanelDismiss, type PanelAnchorRect } from "./useAnchoredPanel";

/**
 * 「@ 引用素材」浮层。
 *
 * 与设计稿一致：顶部是「全部 / 视频 / 图片 / 音频」四个页签，下面是带缩略图的素材
 * 列表。选中后往提示词里插一个 `@图片1` 这样的记号，顺序与提交时素材数组一致，
 * 所以提示词里说「参考 @图片2 的配色」时，指向的就是第 2 张图。
 *
 * 页面没有「粘贴公网地址」的输入，素材入口就在这里：底部的上传键按当前模式能给
 * 的素材类型列出（图片 / 视频 / 音频），不能传的写明原因，而不是给个点不动的槽位。
 *
 * 同样是 portal：开关浮层不会重新挂载创作框里的 textarea。
 */

export interface MentionItem {
  /** 插进提示词的记号，如 图片1 / 视频1 / 音频1 */
  label: string;
  kind: "视频" | "图片" | "音频";
  previewUrl?: string;
}

export interface MentionUpload {
  kind: "视频" | "图片" | "音频";
  /** 当前不能传（比如渠道没配上传服务、图片已到上限） */
  disabled?: boolean;
  /** 说明：能传时写格式与大小，不能传时写原因 */
  hint?: string;
}

const TABS = ["全部", "视频", "图片", "音频"] as const;
type Tab = typeof TABS[number];

export interface VideoMentionPanelProps {
  open: boolean;
  /** 元素（@ 按钮）或光标矩形：敲 @ 时面板跟着 @ 符号走 */
  anchor: HTMLElement | PanelAnchorRect | null;
  items: MentionItem[];
  /** 生图只使用图片时可省略媒体类型页签。 */
  imagesOnly?: boolean;
  /** 当前模式下可上传的素材类型；没传就只显示列表 */
  uploads?: MentionUpload[];
  onUpload?: (kind: MentionUpload["kind"]) => void;
  onClose: () => void;
  onSelect: (label: string) => void;
}

export function VideoMentionPanel({ open, anchor, items, imagesOnly = false, uploads = [], onUpload, onClose, onSelect }: VideoMentionPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("全部");
  // 跟着光标时左缘贴光标（面板朝右下展开）；挂在按钮上时右对齐，收进窗口
  const caretAnchored = Boolean(anchor && !("getBoundingClientRect" in anchor));
  const style = useAnchoredPanelStyle(open, anchor, 280, 400, caretAnchored ? "start" : "end");
  usePanelDismiss(open, onClose, panelRef, anchor && "getBoundingClientRect" in anchor ? anchor : null);

  // 每次打开都回到「全部」，不继承上一次的筛选
  useEffect(() => { if (open) setTab("全部"); }, [open]);

  if (!open || !style) return null;
  const list = tab === "全部" ? items : items.filter((item) => item.kind === tab);
  const uploadHere = tab === "全部" ? uploads : uploads.filter((item) => item.kind === tab);

  return createPortal(
    <div className="vstudio-panel vstudio-mention-panel" ref={panelRef} style={style} role="dialog" aria-label="引用素材">
      {!imagesOnly ? <div className="vstudio-mention-tabs" role="tablist">
        {TABS.map((item) => {
          const count = item === "全部" ? items.length : items.filter((entry) => entry.kind === item).length;
          return (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={tab === item ? "is-active" : ""}
              onClick={() => setTab(item)}
            >
              {item}
              {count ? <em>{count}</em> : null}
            </button>
          );
        })}
      </div> : null}

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
        <p className="vstudio-mention-empty">{imagesOnly ? "还没有参考图" : `还没有${tab === "全部" ? "" : tab}素材`}</p>
      )}

      {uploadHere.length && onUpload ? (
        <div className="vstudio-mention-uploads">
          {uploadHere.map((item) => (
            <button
              key={item.kind}
              type="button"
              className="vstudio-mention-upload"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => onUpload(item.kind)}
            >
              <Upload size={14} />
              <span>上传{item.kind}</span>
              {item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
