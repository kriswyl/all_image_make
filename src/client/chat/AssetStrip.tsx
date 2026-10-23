/**
 * 画布条（极简版）。
 *
 * 只回答一件事：**现在画布里是哪几张、它们分别是什么角色**。
 * 不加来源、哈希编号、移前/删除这些小字——管理动作全部放进素材库，
 * 这里保留一行缩略图和「管理」入口就够了。
 */
import { Layers } from "lucide-react";
import type { CanvasAsset } from "../../shared/agent-types";
import { api } from "../api";
import { ASSET_DRAG_TYPE } from "../useFileDrop";

function roleLabel(position: number): string {
  if (position === 0) return "首帧";
  if (position === 1) return "尾帧";
  return "参考";
}

export function AssetStrip({
  assets,
  canvasIds,
  onPreview,
  onOpenLibrary,
  onClear,
}: {
  assets: CanvasAsset[];
  /** 画布里的图 id，有序；下标就是角色：0 首帧、1 尾帧、其余参考 */
  canvasIds: string[];
  onPreview: (assetId: string) => void;
  onOpenLibrary: () => void;
  onClear: () => void;
}) {
  const entries = canvasIds
    .map((id) => assets.find((entry) => entry.asset.id === id))
    .filter((entry): entry is CanvasAsset => Boolean(entry));

  if (!entries.length) return null;

  const referenceCount = Math.max(0, entries.length - 2);
  const roleSummary = [
    "① 首帧",
    entries.length > 1 ? "② 尾帧" : "",
    referenceCount ? `参考 ${referenceCount}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <section className="canvas-bar">
      <div className="canvas-bar-head">
        <span className="canvas-bar-title"><Layers size={13} />画布 {entries.length}</span>
        <span className="canvas-bar-roles">{roleSummary}</span>
        <button type="button" className="canvas-bar-manage" onClick={onOpenLibrary}>管理</button>
        <button type="button" className="canvas-bar-clear" onClick={onClear}>清空</button>
      </div>
      <div className="canvas-bar-items">
        {entries.map((entry, index) => (
          <button
            key={entry.asset.id}
            type="button"
            className="canvas-bar-thumb"
            title={`${roleLabel(index)} · 点开看大图（也可以拖到输入框）`}
            onClick={() => onPreview(entry.asset.id)}
            draggable
            onDragStart={(event) => event.dataTransfer.setData(ASSET_DRAG_TYPE, entry.asset.id)}
          >
            <img src={api.assetUrl(entry.asset.thumbUrl ?? entry.asset.url)} alt="" loading="lazy" />
            <span className="canvas-bar-order">{index + 1}</span>
            <span className={`canvas-bar-role is-${index === 0 ? "first" : index === 1 ? "last" : "ref"}`}>
              {roleLabel(index)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
