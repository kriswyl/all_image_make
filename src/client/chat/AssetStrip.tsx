/**
 * 画布条（瘦身版）。
 *
 * 只展示「画布里的图」和「最近几张」，不再把本会话 30 张图全铺成一条传送带。
 * 全部素材在右侧的素材库抽屉里找；这里的序号直接翻译成生视频时看得懂的角色：
 * ① 首帧、② 尾帧、③ 以后是参考图。
 */
import { ImageOff, Layers, Upload, X } from "lucide-react";
import { assetRef, type CanvasAsset } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";
import { api } from "../api";
import { ASSET_DRAG_TYPE } from "../useFileDrop";

/** 缩略图 404 时退回原图；缩略图只是省流量，不该成为图裂的原因 */
function fallbackToFull(event: React.SyntheticEvent<HTMLImageElement>, asset: Asset) {
  const image = event.currentTarget;
  if (image.dataset.fallback === "1") return;
  image.dataset.fallback = "1";
  image.src = api.assetUrl(asset.url);
}

function Thumb({ asset, size }: { asset: Asset; size: number }) {
  const source = asset.thumbUrl ?? asset.url;
  return (
    <img
      src={api.assetUrl(source)}
      alt={asset.fileName}
      width={size}
      height={size}
      loading="lazy"
      onError={(event) => {
        if (asset.thumbUrl) fallbackToFull(event, asset);
      }}
    />
  );
}

function roleLabel(position: number): string {
  if (position === 0) return "首帧";
  if (position === 1) return "尾帧";
  return "参考";
}

const RECENT_WHEN_CANVAS = 3;
const RECENT_WITHOUT_CANVAS = 6;

export function AssetStrip({
  assets,
  canvasIds,
  onToggle,
  onPreview,
  onPromote,
  onClear,
  onOpenLibrary,
}: {
  assets: CanvasAsset[];
  /** 画布里的图 id，**有序**——下标就是缩略图上的序号，`[0]` 是第 1 张 */
  canvasIds: string[];
  onToggle: (assetId: string) => void;
  onPreview: (assetId: string) => void;
  onPromote: (assetId: string) => void;
  onClear: () => void;
  onOpenLibrary: () => void;
}) {
  const positions = new Map(canvasIds.map((id, index) => [id, index]));
  const canvasCount = canvasIds.length;
  const canvasEntries = canvasIds
    .map((id) => assets.find((entry) => entry.asset.id === id))
    .filter((entry): entry is CanvasAsset => Boolean(entry));
  const recentEntries = assets
    .filter((entry) => !positions.has(entry.asset.id))
    .slice(-(canvasCount ? RECENT_WHEN_CANVAS : RECENT_WITHOUT_CANVAS))
    .reverse();
  const shown = [...canvasEntries, ...recentEntries];
  const hiddenCount = assets.length - shown.length;
  const primaryRef = canvasCount ? assetRef(canvasIds[0]!) : "";

  function renderEntry(entry: CanvasAsset) {
    const position = positions.get(entry.asset.id) ?? -1;
    const inCanvas = position >= 0;
    const uploaded = entry.source === "upload";
    const origin = uploaded ? "你自己传的"
      : entry.source === "storyboard" ? `分镜第 ${entry.round} 镜`
        : entry.source === "setting" ? "角色 / 场景设定图"
          : `第 ${entry.round} 轮`;
    const role = inCanvas ? roleLabel(position) : "";
    const action = inCanvas
      ? `画布第 ${position + 1} 张（${role}） · 单击移出，双击看大图`
      : "单击加入画布，双击看大图";
    return (
      <div key={entry.asset.id} className={`asset-strip-item ${inCanvas ? "is-in-canvas" : ""} ${position === 0 ? "is-primary" : ""}`}>
        <button
          type="button"
          className="asset-strip-thumb"
          title={`${assetRef(entry.asset.id)} · ${origin} · ${action}（也可以直接拖到下面的输入框）`}
          onClick={() => onToggle(entry.asset.id)}
          onDoubleClick={() => onPreview(entry.asset.id)}
          draggable
          onDragStart={(event) => event.dataTransfer.setData(ASSET_DRAG_TYPE, entry.asset.id)}
        >
          <Thumb asset={entry.asset} size={48} />
          {uploaded ? <span className="asset-strip-origin" title="你自己上传的图"><Upload size={9} /></span> : null}
          {inCanvas ? (
            <span className="asset-strip-order" title={`画布第 ${position + 1} 张`}>
              {position + 1}
            </span>
          ) : null}
        </button>
        <div className="asset-strip-foot">
          <span className="asset-strip-ref">{assetRef(entry.asset.id)}</span>
          {inCanvas ? <span className={`asset-strip-role is-${role === "参考" ? "ref" : role === "尾帧" ? "last" : "first"}`}>{role}</span> : null}
          {inCanvas && position !== 0 ? (
            <button
              type="button"
              className="asset-strip-promote"
              onClick={() => onPromote(entry.asset.id)}
              title="移到画布第 1 张（首帧）"
            >
              移前
            </button>
          ) : null}
          {inCanvas ? (
            <button
              type="button"
              className="asset-strip-remove"
              onClick={() => onToggle(entry.asset.id)}
              title="移出画布（图还在本会话里）"
            >
              <X size={11} />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section className="canvas-section">
      <div className="canvas-section-head">
        <span className="canvas-section-title">
          <Layers size={13} />
          素材 {assets.length} 张{canvasCount ? ` · 画布 ${canvasCount} 张` : ""}
        </span>
        {canvasCount ? (
          <span
            className="canvas-section-summary"
            title={`画布顺序就是生视频时的角色：① 首帧、② 尾帧、③ 以后是参考图。${canvasCount > 1 ? `当前用 ${primaryRef} 当首帧。` : ""}`}
          >
            {Array.from({ length: Math.min(canvasCount, 4) }, (_, index) => `${"①②③④"[index]}${roleLabel(index)}`).join(" · ")}
            {canvasCount > 4 ? ` · 其余参考` : ""}
          </span>
        ) : null}
        <button type="button" className="canvas-section-library" onClick={onOpenLibrary}>
          查看全部
        </button>
        {canvasCount ? (
          <button type="button" className="canvas-section-clear" onClick={onClear} title="把画布清空（图都还在本会话里）">
            清空
          </button>
        ) : null}
      </div>
      {assets.length ? (
        <div className="asset-strip-row">
          {shown.map(renderEntry)}
          <button type="button" className="asset-strip-more" onClick={onOpenLibrary}
            title={`打开素材库，查看全部 ${assets.length} 张`}>
            <Layers size={17} />
            <span>全部</span>
            <small>{assets.length}</small>
          </button>
          {hiddenCount > 0 ? <span className="asset-strip-more-hint">还有 {hiddenCount} 张在素材库</span> : null}
        </div>
      ) : (
        <p className="canvas-section-empty">
          <ImageOff size={13} />
          <span>还没有图。让助手画一张，或者自己传一张进来，之后就能说「把这张的手换成…」</span>
        </p>
      )}
    </section>
  );
}
