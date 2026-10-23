/**
 * 会话内分镜面板。
 *
 * 它不是聊天记录的一部分：20 个镜头如果长在消息流里，用户既找不到「第 7 镜」，
 * 也没法在生成前统一改描述。这里把「拆镜」和「生成」分成两步——
 * 大脑只负责拆，真正花钱的动作由用户在这张表上确认后触发。
 */
import { Check, ChevronDown, Clapperboard, Download, Film, Image as ImageIcon, Layers, LoaderCircle, RefreshCw, Sparkles, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import {
  isStoryboardShotActive, shotNeedsCharacterReference, storyboardKindLabel, storyboardShotMissing,
  STORYBOARD_ASPECT_RATIOS, type StoryboardShot, type StoryboardView,
} from "../../shared/storyboard";
import type { CanvasAsset } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";
import { AssetLightbox } from "./AssetLightbox";

type ToastKind = "ok" | "error";

export function StoryboardPanel({
  conversationId,
  refreshKey,
  canvasIds,
  images,
  onClose,
  onToast,
  onAddToCanvas,
}: {
  conversationId: string;
  /** 消息数变化时重新拉一次：大脑刚拆完镜，面板要立刻出现 */
  refreshKey: number;
  canvasIds: string[];
  /** 本会话的全部图片产物，角色参考从这里选 */
  images: CanvasAsset[];
  onClose: () => void;
  onToast: (kind: ToastKind, text: string) => void;
  onAddToCanvas: (assetId: string) => void;
}) {
  const [data, setData] = useState<StoryboardView | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [referenceBusy, setReferenceBusy] = useState(false);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // 切换会话时旧请求可能后到；只让最后一次发出的请求回写
  const loadSeq = useRef(0);

  const shots = data?.shots ?? [];
  const active = shots.some((shot) => isStoryboardShotActive(shot.status));

  async function load(quiet = true) {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await api.storyboard(conversationId);
      if (seq !== loadSeq.current) return;
      setData(next);
      setDrafts((current) => {
        const merged: Record<string, string> = {};
        for (const shot of next.shots) merged[shot.id] = current[shot.id] ?? shot.prompt;
        return merged;
      });
      // 已经在跑的镜头不该还留在勾选里；已完成的可以留——用户可能是勾起来批量重跑
      setSelected((current) => new Set([...current].filter((id) => {
        const shot = next.shots.find((item) => item.id === id);
        return Boolean(shot) && !isStoryboardShotActive(shot!.status);
      })));
    } catch (error) {
      if (seq === loadSeq.current && !quiet) onToast("error", error instanceof Error ? error.message : "分镜表加载失败");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    setDrafts({});
    setSelected(new Set());
    void load(false);
    // conversationId 变化时必须重拉；load 是每次渲染新建的函数，故意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // 大脑刚拆完镜时消息数会变；面板开着就跟着刷新
  useEffect(() => {
    if (data) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // 有任务在跑才轮询；全都停在终态时不动，避免空转
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, conversationId]);

  useEffect(() => () => {
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
    saveTimers.current.clear();
  }, []);

  const selectable = useMemo(
    () => shots.filter((shot) => !storyboardShotMissing(shot) && shot.status !== "succeeded" && !isStoryboardShotActive(shot.status)),
    [shots],
  );
  const rerunnable = useMemo(
    () => shots.filter((shot) => !storyboardShotMissing(shot) && shot.status === "succeeded"),
    [shots],
  );
  const maxBatch = data?.maxBatch ?? 8;
  const canGenerateAny = data?.canGenerateImage || data?.canGenerateVideo;
  const reference = data?.reference;
  const referenceValue = reference?.mode === "manual" && reference.asset
    ? `asset:${reference.asset.id}`
    : reference?.mode ?? "auto";

  function imageLabel(entry: CanvasAsset): string {
    const name = entry.asset.fileName.replace(/\.[^.]+$/, "");
    if (entry.source === "storyboard") return `第 ${entry.round} 镜 · ${name.slice(0, 12)}`;
    if (entry.source === "upload") return `上传 · ${name.slice(0, 12)}`;
    return `第 ${entry.round} 轮 · ${name.slice(0, 12)}`;
  }

  async function changeReference(value: string) {
    if (referenceBusy) return;
    setReferenceBusy(true);
    try {
      const next = value.startsWith("asset:")
        ? await api.updateStoryboardReference(conversationId, { referenceMode: "manual", referenceAssetId: value.slice(6) })
        : await api.updateStoryboardReference(conversationId, { referenceMode: value as "auto" | "off" });
      setData(next);
      onToast("ok", next.reference.asset ? "角色参考已更新" : "已关闭角色参考");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "设置角色参考失败");
    } finally {
      setReferenceBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else {
        if (next.size >= maxBatch) {
          onToast("error", `一次最多提交 ${maxBatch} 个镜头`);
          return current;
        }
        next.add(id);
      }
      return next;
    });
  }

  function selectReady() {
    setSelected(new Set(selectable.slice(0, maxBatch).map((shot) => shot.id)));
  }

  function selectRerun() {
    setSelected(new Set(rerunnable.slice(0, maxBatch).map((shot) => shot.id)));
  }

  function changePrompt(shot: StoryboardShot, value: string) {
    setDrafts((current) => ({ ...current, [shot.id]: value }));
    const timer = saveTimers.current.get(shot.id);
    if (timer) clearTimeout(timer);
    saveTimers.current.set(shot.id, setTimeout(() => {
      saveTimers.current.delete(shot.id);
      void saveShot(shot.id, { prompt: value });
    }, 700));
  }

  async function saveShot(shotId: string, patch: Partial<Pick<StoryboardShot, "prompt" | "kind" | "aspectRatio">>): Promise<boolean> {
    const pendingTimer = saveTimers.current.get(shotId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      saveTimers.current.delete(shotId);
    }
    setSaving((current) => ({ ...current, [shotId]: true }));
    try {
      const next = await api.updateStoryboardShot(conversationId, shotId, patch);
      setData(next);
      return true;
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "保存失败");
      await load();
      return false;
    } finally {
      setSaving((current) => ({ ...current, [shotId]: false }));
    }
  }

  function flushPrompt(shot: StoryboardShot) {
    const timer = saveTimers.current.get(shot.id);
    if (!timer) return;
    clearTimeout(timer);
    saveTimers.current.delete(shot.id);
    void saveShot(shot.id, { prompt: drafts[shot.id] ?? shot.prompt });
  }

  async function submitGenerate(ids: string[]) {
    if (!ids.length) return;
    setSubmitting(true);
    try {
      /*
       * 点「确认提交」之前先把还没落库的提示词存掉。
       * 只靠 700ms 防抖 / blur 保存的话，用户改完立刻点生成，
       * 请求可能先带着旧提示词发出去——界面上看到的是新描述，生成的是旧的。
       */
      const toSave = shots.filter((shot) => ids.includes(shot.id) && drafts[shot.id] !== undefined && drafts[shot.id] !== shot.prompt);
      const saved = await Promise.all(toSave.map((shot) => saveShot(shot.id, { prompt: drafts[shot.id]! })));
      if (saved.some((ok) => !ok)) return;
      // 并行保存的响应可能乱序回来；提交前拉一次权威视图，别让界面停在半新半旧的状态
      await load();

      const result = await api.generateStoryboardShots(conversationId, ids);
      setData((current) => current ? { ...current, shots: result.shots } : current);
      setSelected(new Set());
      setConfirming(null);
      if (result.failures.length) {
        onToast("error", result.failures.map((item) => `第 ${item.index} 镜：${item.error}`).join("；"));
      } else if (result.note) {
        onToast("error", result.note);
      } else {
        onToast("ok", `已提交 ${result.submitted} 个镜头，完成后会显示在列表里`);
      }
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function download(asset: Asset) {
    if (downloading) return;
    setDownloading(asset.id);
    try {
      if (await api.downloadAsset(asset)) onToast("ok", "已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(null);
    }
  }

  const confirmShots = confirming
    ? shots.filter((shot) => confirming.includes(shot.id))
    : [];
  const confirmImages = confirmShots.filter((shot) => shot.kind === "image").length;
  const confirmVideos = confirmShots.length - confirmImages;
  const firstImageShot = confirmShots.filter((shot) => shot.kind === "image").sort((left, right) => left.index - right.index)[0];
  const willAutoBase = reference?.mode === "auto" && !reference.asset && confirmImages >= 2;
  const rerunCount = confirmShots.filter((shot) => shot.status === "succeeded").length;
  const referenceShot = reference?.shotIndex ? shots.find((shot) => shot.index === reference.shotIndex) : undefined;
  const referenceLooksLikeScene = Boolean(referenceShot && !shotNeedsCharacterReference(referenceShot));

  return (
    <div className="storyboard-panel">
      <div className="storyboard-head">
        <div className="storyboard-title">
          <Clapperboard size={15} />
          <strong>分镜表</strong>
          <span>{shots.length} 镜</span>
          {loading ? <LoaderCircle size={13} className="spin" /> : null}
        </div>

        <label
          className="storyboard-reference"
          title="多镜之间保持同一个人物。自动 = 用镜号最小、已经有结果的图片镜头；也可以指定任意一张本会话的图。"
        >
          {reference?.asset
            ? <img src={api.assetUrl(reference.asset.thumbUrl ?? reference.asset.url)} alt="" />
            : <UserRound size={13} />}
          <select
            value={referenceValue}
            disabled={referenceBusy || !shots.length}
            onChange={(event) => void changeReference(event.target.value)}
          >
            <option value="auto">角色参考：自动</option>
            <option value="off">角色参考：不使用</option>
            {images.map((entry) => (
              <option key={entry.asset.id} value={`asset:${entry.asset.id}`}>{imageLabel(entry)}</option>
            ))}
            {reference?.mode === "manual" && reference.asset && !images.some((entry) => entry.asset.id === reference.asset!.id) ? (
              <option value={`asset:${reference.asset.id}`}>当前指定的参考图</option>
            ) : null}
          </select>
          {referenceBusy ? <LoaderCircle size={12} className="spin" /> : null}
        </label>

        <div className="storyboard-head-actions">
          <button type="button" className="link-btn" onClick={selectReady} disabled={!selectable.length}>
            选中可生成
          </button>
          {rerunnable.length ? (
            <button type="button" className="link-btn" onClick={selectRerun} title="勾选已完成的前 8 镜，一起重跑">
              选中已完成
            </button>
          ) : null}
          <button
            type="button"
            className="primary-button compact"
            disabled={!selected.size || !canGenerateAny || submitting}
            onClick={() => setConfirming([...selected])}
          >
            <Sparkles size={13} />生成选中 {selected.size ? `(${selected.size})` : ""}
          </button>
          <button type="button" className="icon-button compact" title="刷新" onClick={() => void load(false)}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-button compact" title="收起分镜表" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {!canGenerateAny && shots.length ? (
        <div className="storyboard-note">还没有可用的生图 / 生视频渠道，请先到「模型配置」里添加。</div>
      ) : null}

      <div className="storyboard-list">
        {shots.map((shot) => {
          const missing = storyboardShotMissing(shot);
          const activeShot = isStoryboardShotActive(shot.status);
          const succeeded = shot.status === "succeeded";
          const checked = selected.has(shot.id);
          const kindAvailable = shot.kind === "video" ? data?.canGenerateVideo : data?.canGenerateImage;
          return (
            <div key={shot.id} className={`storyboard-row ${checked ? "is-selected" : ""} ${succeeded ? "is-done" : ""}`}>
              <div className="storyboard-row-pick">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={Boolean(missing) || activeShot}
                  onChange={() => toggle(shot.id)}
                  title={succeeded ? "已生成，勾选可以一起重跑" : undefined}
                  aria-label={`选择第 ${shot.index} 镜`}
                />
                <span className="storyboard-index">{shot.index}</span>
              </div>

              <div className="storyboard-row-main">
                <div className="storyboard-row-meta">
                  <label className="storyboard-kind" title="这一镜生成图片还是视频">
                    {shot.kind === "video" ? <Film size={12} /> : <ImageIcon size={12} />}
                    <select
                      value={shot.kind}
                      onChange={(event) => void saveShot(shot.id, { kind: event.target.value as "image" | "video" })}
                      disabled={activeShot}
                    >
                      <option value="image">图片</option>
                      <option value="video">视频</option>
                    </select>
                  </label>
                  <label className="storyboard-aspect" title="画幅">
                    <select
                      value={shot.aspectRatio}
                      onChange={(event) => void saveShot(shot.id, { aspectRatio: event.target.value })}
                      disabled={activeShot}
                    >
                      {STORYBOARD_ASPECT_RATIOS.map((ratio) => (
                        <option key={ratio || "auto"} value={ratio}>{ratio || "默认画幅"}</option>
                      ))}
                    </select>
                  </label>
                  <span className={`storyboard-status is-${shot.status}`} title={shot.errorMessage ?? undefined}>
                    {statusLabel(shot)}
                  </span>
                  {missing ? <span className="storyboard-missing">{missing}</span> : null}
                  {saving[shot.id] ? <span className="storyboard-saving">保存中…</span> : null}
                </div>
                {shot.sourceText ? <div className="storyboard-source" title={shot.sourceText}>{shot.sourceText}</div> : null}
                <textarea
                  className="storyboard-prompt"
                  value={drafts[shot.id] ?? shot.prompt}
                  rows={2}
                  maxLength={20000}
                  placeholder="画面描述：人物、场景、构图、光线、风格…"
                  disabled={activeShot}
                  onChange={(event) => changePrompt(shot, event.target.value)}
                  onBlur={() => flushPrompt(shot)}
                />
              </div>

              <div className="storyboard-row-side">
                {shot.asset ? (
                  <button type="button" className="storyboard-thumb" title="点开看结果" onClick={() => setPreview(shot.asset)}>
                    {shot.kind === "video"
                      ? <video src={api.assetUrl(shot.asset.url)} muted playsInline preload="metadata" onContextMenu={(event) => event.preventDefault()} />
                      : <img src={api.assetUrl(shot.asset.thumbUrl ?? shot.asset.url)} alt="" loading="lazy" />}
                  </button>
                ) : <span className="storyboard-thumb is-empty">{shot.kind === "video" ? <Film size={16} /> : <ImageIcon size={16} />}</span>}
                <div className="storyboard-row-actions">
                  <button
                    type="button"
                    className="link-btn"
                    disabled={Boolean(missing) || activeShot || submitting || !kindAvailable}
                    onClick={() => setConfirming([shot.id])}
                  >
                    {activeShot ? <LoaderCircle size={12} className="spin" /> : succeeded ? <RefreshCw size={12} /> : <Sparkles size={12} />}
                    {activeShot ? "生成中" : succeeded ? "重跑" : "生成"}
                  </button>
                  {shot.asset ? (
                    <>
                      <button type="button" className="link-btn" onClick={() => setPreview(shot.asset)}>预览</button>
                      <button type="button" className="link-btn" onClick={() => onAddToCanvas(shot.asset!.id)} disabled={canvasIds.includes(shot.asset.id)}>
                        <Layers size={12} />{canvasIds.includes(shot.asset.id) ? "在画布" : "加画布"}
                      </button>
                      <button type="button" className="link-btn" disabled={Boolean(downloading)} onClick={() => void download(shot.asset!)}>
                        {downloading === shot.asset.id ? <LoaderCircle size={12} className="spin" /> : <Download size={12} />}下载
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {!shots.length && !loading ? (
        <div className="storyboard-empty">
          <ChevronDown size={16} />
          <span>还没有分镜。上传 .txt / .md 剧本，让助手「拆成分镜」。</span>
        </div>
      ) : null}

      {confirming ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setConfirming(null); }}>
          <div className="modal narrow" role="dialog" aria-modal="true" aria-label="确认生成分镜">
            <div className="modal-header">
              <div><Clapperboard size={18} /><h2>确认生成</h2></div>
              <button type="button" className="icon-button" onClick={() => setConfirming(null)} disabled={submitting}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-lead">
                将提交 <strong>{confirmShots.length}</strong> 个镜头
                {confirmImages ? `：图片 ${confirmImages} 个` : ""}
                {confirmVideos ? `${confirmImages ? "，" : "："}视频 ${confirmVideos} 个` : ""}。
              </p>
              <div className="storyboard-confirm-list">
                {confirmShots.map((shot) => (
                  <div key={shot.id} className="storyboard-confirm-item">
                    <span className="storyboard-index">{shot.index}</span>
                    <span className="storyboard-confirm-kind">{storyboardKindLabel(shot.kind)}{shot.aspectRatio ? ` · ${shot.aspectRatio}` : ""}</span>
                    <span className="storyboard-confirm-prompt">{drafts[shot.id] ?? shot.prompt}</span>
                    <Check size={13} />
                  </div>
                ))}
              </div>
              <p className={`storyboard-reference-note ${reference?.mode === "off" ? "is-warning" : ""}`}>
                {reference?.mode === "off"
                  ? "已关闭角色参考：多个镜头里的人物可能对不上。"
                  : reference?.asset
                    ? `本次会以${reference.shotIndex ? `第 ${reference.shotIndex} 镜` : "指定的图片"}作为角色 / 画风参考。`
                    : willAutoBase
                      ? `还没有角色基准：会先生成第 ${firstImageShot?.index ?? 1} 镜，等它完成后自动提交其余镜头（需要多等一次生成，最长约 3 分钟）。`
                      : confirmImages > 1
                        ? "还没有可用的角色基准，本批图片会各自生成；先从这一批里验收一张，下一次生成就会自动以它为参考。"
                        : "本批只有 1 个图片镜头，暂不需要角色参考；它完成后会自动成为后续镜头的参考。"}
              </p>
              {referenceLooksLikeScene ? (
                <p className="storyboard-reference-note is-warning">
                  当前角色参考是第 {reference!.shotIndex} 镜，看起来是空镜 / 环境，不是人物镜头；用它可能起不到保持人物一致的作用。建议改选一张有人物的图。
                </p>
              ) : null}
              {rerunCount ? (
                <p className="storyboard-reference-note">
                  其中 {rerunCount} 镜已经有结果，会重新生成并替换分镜表里的最新结果；旧结果仍保留在生成历史里。
                </p>
              ) : null}
              <p className="storyboard-billing">
                每个镜头都会按渠道单独计费，提交后不能撤回。失败或不满意的镜头可以单独重跑。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={() => setConfirming(null)} disabled={submitting}>取消</button>
              <button type="button" className="primary-button" onClick={() => void submitGenerate(confirming)} disabled={submitting}>
                {submitting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
                {submitting ? (willAutoBase ? "先生成角色基准…" : "提交中…") : `确认提交 ${confirmShots.length} 镜`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? <AssetLightbox assetId={preview.id} asset={preview} onClose={() => setPreview(null)} onToast={(kind, text) => onToast(kind, text)} /> : null}
    </div>
  );
}

function statusLabel(shot: StoryboardShot): string {
  if (shot.status === "planned") return "未生成";
  if (shot.status === "succeeded") return "已完成";
  if (shot.status === "failed") return "失败";
  if (shot.status === "cancelled") return "已取消";
  if (shot.status === "expired") return "已过期";
  return "生成中";
}
