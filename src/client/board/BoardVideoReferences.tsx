import { useState } from "react";
import { createPortal } from "react-dom";
import { AudioLines, FileText, Image as ImageIcon, Video, X } from "lucide-react";
import type { BoardEdgeRole, BoardInputLink } from "../../shared/board";
import type { Asset } from "../../shared/types";
import { api } from "../api";
import { BoardComposerPopover } from "./BoardComposerPopover";
import { boardMentionLabel } from "../../shared/board-mentions";
import { useAnchoredPanelStyle } from "../video/useAnchoredPanel";

export interface VideoReference {
  link: BoardInputLink;
  label: string;
  warning?: boolean;
  asset?: Asset;
}

export function BoardVideoReferences({ entries, onPreview, onLocate, onRemove, onChangeRole, onOpen }: {
  entries: VideoReference[];
  onPreview: (asset: Asset) => void;
  onLocate: (nodeId: string) => void;
  onRemove: (link: BoardInputLink) => void;
  onChangeRole?: (edgeId: string, role?: BoardEdgeRole) => void;
  onOpen: () => void;
}) {
  const [opened, setOpened] = useState<{ edgeId: string; anchor: HTMLButtonElement } | null>(null);
  const [hovered, setHovered] = useState<{ edgeId: string; anchor: HTMLElement } | null>(null);
  const current = entries.find(({ link }) => link.edge.id === opened?.edgeId);
  const hoverEntry = entries.find(({ link }) => link.edge.id === hovered?.edgeId);
  const previewStyle = useAnchoredPanelStyle(Boolean(hoverEntry?.asset && !opened), hovered?.anchor ?? null, 208, 172);
  const remove = (link: BoardInputLink) => {
    setOpened(null);
    setHovered(null);
    onRemove(link);
  };
  return <>
    {entries.map(({ link: { node, edge }, label, warning, asset }) => {
      const Icon = node.type === "text" ? FileText : node.type === "video" ? Video : node.type === "audio" ? AudioLines : ImageIcon;
      const name = node.title && node.title !== "文本" && node.title !== "图片"
        ? node.title : node.type === "text" ? node.text.trim() || "空文本" : asset?.title || asset?.fileName || node.ref;
      const mention = boardMentionLabel(node);
      return <div key={edge.id} className="board-reference-tile"
        onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered({ edgeId: edge.id, anchor: event.currentTarget }); }}
        onPointerLeave={() => setHovered(null)}>
      <button type="button" className="board-video-reference" aria-expanded={opened?.edgeId === edge.id}
        aria-label={[mention, label, name].filter(Boolean).join(" · ")} onClick={(event) => {
          onOpen();
          setOpened(opened?.edgeId === edge.id ? null : { edgeId: edge.id, anchor: event.currentTarget });
        }} onDoubleClick={(event) => {
          event.stopPropagation();
          setOpened(null);
          setHovered(null);
          onLocate(node.id);
        }}>
        {node.type === "image" && asset
          ? <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} alt="" />
          : node.type === "video" && asset
            ? <video src={`${api.assetUrl(asset.url)}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" />
            : <Icon size={16} />}
        <span><small className={warning ? "is-warn" : undefined}>{label}</small><strong>{mention ?? name}</strong></span>
      </button>
      <button type="button" className="board-reference-remove" aria-label={`移除引用 ${mention ?? name}`}
        onClick={() => remove({ node, edge })}><X size={12} /></button>
      </div>;
    })}
    {hoverEntry?.asset && previewStyle && !opened && createPortal(
      <div className="board-reference-hover" aria-hidden="true" style={previewStyle}>
        {hoverEntry.link.node.type === "image"
          ? <img src={api.assetUrl(hoverEntry.asset.url)} alt="" />
          : hoverEntry.link.node.type === "video"
            ? <video src={`${api.assetUrl(hoverEntry.asset.url)}#t=0.1`} preload="metadata" muted playsInline />
            : <AudioLines size={30} />}
        <span>{hoverEntry.link.node.title || hoverEntry.asset.fileName}</span>
      </div>, document.body,
    )}
    {opened && current && (
      <BoardComposerPopover anchor={opened.anchor} label="引用详情" width={300} onClose={() => setOpened(null)}>
        <div className="board-inspector-more-body">
          <div className="board-inspector-label"><span>{current.label}</span><em>{current.link.node.ref}</em></div>
          {current.link.node.type === "text" && <p className="board-video-reference-text">{current.link.node.text}</p>}
          {current.link.node.type === "image" && onChangeRole && (
            <label className="board-field"><span>用作</span>
              <select value={current.link.edge.role ?? ""} onChange={(event) => onChangeRole(current.link.edge.id, (event.target.value || undefined) as BoardEdgeRole | undefined)}>
                <option value="">自动</option><option value="first-frame">首帧</option><option value="last-frame">尾帧</option><option value="reference">参考图</option>
              </select>
            </label>
          )}
          <div className="board-inspector-actions">
            {current.asset && <button type="button" className="secondary-button compact" onClick={() => onPreview(current.asset!)}>预览</button>}
            <button type="button" className="secondary-button compact" onClick={() => { setOpened(null); onLocate(current.link.node.id); }}>定位来源</button>
            <button type="button" className="secondary-button compact is-danger" onClick={() => remove(current.link)}>移除引用</button>
          </div>
        </div>
      </BoardComposerPopover>
    )}
  </>;
}
