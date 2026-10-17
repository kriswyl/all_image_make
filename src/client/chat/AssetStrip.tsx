/**
 * 画布条（AGENT_PLAN.md §10）。
 *
 * **每张图只出现一次**：一行放着本会话的全部图，点一下给它打上「在画布里」的记号，
 * 记号带序号，① 是**主图**（生视频的首帧、发给大脑看的那张、确认卡上的缩略图都用它）。
 * 副标题那枚浅紫药丸说清这一行和画布的关系——「画布 3 张 · 一起当参考图 · 生视频用 #c904 当首帧」。
 *
 * 为什么不再分上下两段：一开始是「上段当前画布 / 下段本会话的图」两个框，好处是
 * 「哪几张参与下一步」一眼可见，代价是**同一张图会同时出现在两段里**（截图里 3 张图
 * 上下各一份），点了之后行会跳、还要在两处之间来回看。用户的原话是
 * 「所有图只展示一次，点一下，被标记的就是当前画布的」——记号和序号能做到同样的事，
 * 而且不重复占位。画布和本会话的区别仍然说得明明白白：计数分成「全部 N 张」和
 * 「画布 N 张」两个词，谁是谁不会读错。
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

export function AssetStrip({
  assets,
  canvasIds,
  onToggle,
  onPreview,
  onPromote,
  onClear,
}: {
  assets: CanvasAsset[];
  /** 画布里的图 id，**有序**——下标就是缩略图上的序号，`[0]` 是主图 */
  canvasIds: string[];
  /** 点一下：不在画布里就加到末尾，在画布里就移出 */
  onToggle: (assetId: string) => void;
  onPreview: (assetId: string) => void;
  /** 把某张提到 `[0]`：主图决定视频首帧，必须能改 */
  onPromote: (assetId: string) => void;
  onClear: () => void;
}) {
  // 序号从这张表里查，而不是数「前面有几张在画布里」——画布顺序是用户点选顺序，
  // 和 assets 的时间顺序无关，数出来的序号会和药丸上写的对不上
  const positions = new Map(canvasIds.map((id, index) => [id, index]));
  const canvasCount = canvasIds.length;
  const primaryRef = canvasCount ? assetRef(canvasIds[0]!) : "";

  return (
    <section className="canvas-section">
      <div className="canvas-section-head">
        <span className="canvas-section-title">
          <Layers size={13} />
          本会话的图（全部 {assets.length} 张）
        </span>
        {canvasCount ? (
          <span
            className="canvas-section-summary"
            title={`这 ${canvasCount} 张会一起作为参考图发给改图模型；生视频用 ${primaryRef} 当首帧${canvasCount > 1 ? "，其余几张不发给视频模型" : ""}。`}
          >
            画布 {canvasCount} 张 · 一起当参考图 · 生视频用 {primaryRef} 当首帧
          </span>
        ) : assets.length ? (
          <span className="canvas-section-hint">点一下加入画布 · 双击看大图</span>
        ) : null}
        {canvasCount ? (
          <button type="button" className="canvas-section-clear" onClick={onClear} title="把画布清空（图都还在本会话里）">
            清空
          </button>
        ) : null}
      </div>
      {assets.length ? (
        <div className="asset-strip-row">
          {assets.map(({ asset, round, source }) => {
            const position = positions.get(asset.id) ?? -1;
            const inCanvas = position >= 0;
            const primary = position === 0;
            const uploaded = source === "upload";
            // 上传的图没有「第几轮」，写成第 N 轮会让用户以为它也是生成出来的
            const origin = uploaded ? "你自己传的" : `第 ${round} 轮`;
            // 动作说明挂在缩略图自己的 tooltip 上：指到哪张就说哪张，比在标题行写一句
            // 「点一下加入/移出画布」更容易在**想动手的那一刻**被看见
            const action = inCanvas
              ? `画布第 ${position + 1} 张${primary ? "（主图）" : ""} · 单击移出，双击看大图`
              : "单击加入画布，双击看大图";
            return (
              <div
                key={asset.id}
                className={`asset-strip-item ${inCanvas ? "is-in-canvas" : ""} ${primary ? "is-primary" : ""}`}
              >
                <button
                  type="button"
                  className="asset-strip-thumb"
                  title={`${assetRef(asset.id)} · ${origin} · ${action}（也可以直接拖到下面的输入框）`}
                  onClick={() => onToggle(asset.id)}
                  onDoubleClick={() => onPreview(asset.id)}
                  // 拖进输入框：带的是产物 id，不是文件——它已经在会话里了，不必再传一遍
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)}
                >
                  <Thumb asset={asset} size={44} />
                  {/* 来源标记：上传的和生成的放在一起，不给标记就分不出哪张是要花钱的产物 */}
                  {uploaded ? <span className="asset-strip-origin" title="你自己上传的图"><Upload size={9} /></span> : null}
                  {/* 序号 = 画布里的位置，① 就是主图；不在画布里就没有序号，这也就是「标记」本身 */}
                  {inCanvas ? (
                    <span className="asset-strip-order" title={primary ? "画布主图（第 1 张）" : `画布第 ${position + 1} 张`}>
                      {position + 1}
                    </span>
                  ) : null}
                  {primary ? <span className="asset-strip-primary">主图</span> : null}
                </button>
                <div className="asset-strip-foot">
                  <span className="asset-strip-ref">{assetRef(asset.id)}</span>
                  {inCanvas && !primary ? (
                    <button
                      type="button"
                      className="asset-strip-promote"
                      onClick={() => onPromote(asset.id)}
                      title="设为主图：生视频的首帧、给助手看的那张都用它"
                    >
                      设为主图
                    </button>
                  ) : null}
                  {inCanvas ? (
                    <button
                      type="button"
                      className="asset-strip-remove"
                      onClick={() => onToggle(asset.id)}
                      title="移出画布（图还在本会话里）"
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
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
