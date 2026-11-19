import {
  AudioLines, Check, CircleCheck, Copy, Download, Eye, Film, Grid2X2, Image as ImageIcon, Layers,
  List, MoreHorizontal, Play, Plus, Search, Trash2, Upload, X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { formatDuration } from "../task-ui";
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { assetRef, type CanvasAsset } from "../../shared/agent-types";
import { CHAT_MEDIA_ACCEPT, MAX_CHAT_MEDIA_FILES } from "../../shared/chat-media";
import type { Asset } from "../../shared/types";

const types = [
  { id: "all", label: "全部" },
  { id: "image", label: "图片", icon: ImageIcon },
  { id: "video", label: "视频", icon: Film },
  { id: "audio", label: "音频", icon: AudioLines },
] as const;
const origins = { generate: "生成", upload: "上传", library: "公共引用", storyboard: "分镜", setting: "设定", bridge: "无限画布" } as const;
type MediaType = typeof types[number]["id"];
type Entry = Pick<CanvasAsset, "asset" | "prompt" | "round"> & { source: CanvasAsset["source"] | "public" };

function assetKind(asset: Asset) {
  return asset.mimeType.startsWith("video/") ? "video" : asset.mimeType.startsWith("audio/") ? "audio" : "image";
}

function assetName({ asset, prompt, source }: Entry) {
  const description = source === "upload" ? prompt.match(/^上传了图片 (.+)$/)?.[1] : source === "library" ? "" : prompt.trim();
  return asset.title || description || asset.fileName;
}

function originLabel(entry: Entry) {
  return entry.source === "public" ? "公共素材"
    : entry.source === "storyboard" ? `分镜 · 第 ${entry.round} 镜` : origins[entry.source];
}

function AssetCover({ asset }: { asset: Asset }) {
  const kind = assetKind(asset);
  const duration = asset.duration && asset.duration > 0 ? formatDuration(asset.duration) : undefined;
  return <span className={`asset-library-cover is-${kind}`} aria-hidden="true">
    {kind === "image" || asset.thumbUrl ? <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} loading="lazy" alt=""
      onError={(event) => {
        const image = event.currentTarget;
        if (kind === "image" && asset.thumbUrl && !image.dataset.retried) {
          image.dataset.retried = "1";
          image.src = api.assetUrl(asset.url);
        } else {
          image.hidden = true;
        }
      }} /> : kind === "video" ? <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline />
      : <AudioLines size={28} strokeWidth={1.5} />}
    {kind === "video" && <span className="asset-library-play"><Play size={15} fill="currentColor" /></span>}
    {kind !== "image" && <span className="asset-library-media-type">
      {kind === "video" ? <Film size={12} /> : <AudioLines size={12} />}{duration}
    </span>}
  </span>;
}

export function AssetLibrary({
  assets, selection, limit, chatSelection, canModify, previewOpen, onClose, onPreview, onApply,
  onUpload, removableLibraryIds, onAddToBoard, onDeleteAsset,
}: {
  assets: CanvasAsset[];
  selection: Asset[];
  limit: number;
  chatSelection: boolean;
  canModify: boolean;
  previewOpen: boolean;
  onClose: () => void;
  onPreview: (asset: Asset) => void;
  onApply: (assets: Asset[]) => void;
  onUpload: (files: File[]) => Promise<void>;
  removableLibraryIds: Set<string>;
  onAddToBoard?: (entry: Entry) => void;
  onDeleteAsset: (id: string) => Promise<void>;
}) {
  const [source, setSource] = useState<"conversation" | "public">("conversation");
  const [kind, setKind] = useState<MediaType>("all");
  const [origin, setOrigin] = useState("all");
  const [query, setQuery] = useState("");
  const [oldest, setOldest] = useState(false);
  const [list, setList] = useState(false);
  const [selected, setSelected] = useState(() => selection.map(({ id }) => id));
  const [draftEntries, setDraftEntries] = useState<Record<string, Entry>>(() =>
    Object.fromEntries(selection.map((asset) => [asset.id, { asset, source: "public", round: 0, prompt: "" }])));
  const [shared, setShared] = useState<Entry[]>([]);
  const [sharedOffset, setSharedOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [menu, setMenu] = useState<{ entry: Entry; left: number; top: number }>();
  const [deleteTarget, setDeleteTarget] = useState<Entry>();
  const dialog = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menuPanel = useRef<HTMLDivElement>(null);
  const deletePanel = useRef<HTMLElement>(null);
  const sharedRequest = useRef(0);
  const title = useId();
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const knownIds = useMemo(() => new Set(assets.map(({ asset }) => asset.id)), [assets]);
  const selectedAssets = selected.flatMap((id) => {
    const asset = draftEntries[id]?.asset ?? assets.find((entry) => entry.asset.id === id)?.asset;
    return asset ? [asset] : [];
  });
  const imageCount = selectedAssets.filter((asset) => assetKind(asset) === "image").length;
  const mediaCount = selectedAssets.length - imageCount;
  const keyword = query.trim();
  const localEntries = useMemo(() => {
    const candidates = origin === "selected" ? [...assets, ...Object.values(draftEntries).filter(({ asset }) => !knownIds.has(asset.id))] : assets;
    return candidates.filter((entry) => (kind === "all" || assetKind(entry.asset) === kind)
    && (origin === "all" || (origin === "selected" ? selectedSet.has(entry.asset.id) : entry.source === origin))
    && (!keyword || [assetName(entry), entry.asset.fileName, entry.asset.tags, entry.prompt, originLabel(entry), assetRef(entry.asset.id)]
      .join(" ").toLowerCase().includes(keyword.toLowerCase())))
      .sort((a, b) => (oldest ? 1 : -1) * a.asset.createdAt.localeCompare(b.asset.createdAt));
  }, [assets, draftEntries, kind, keyword, knownIds, oldest, origin, selectedSet]);
  const entries = source === "conversation" ? localEntries : shared.filter(({ asset }) => !knownIds.has(asset.id));

  useEffect(() => {
    const opener = document.activeElement;
    search.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    if (!previewOpen && !deleteTarget && !dialog.current?.contains(document.activeElement)) search.current?.focus();
  }, [previewOpen, deleteTarget, menu]);
  useEffect(() => {
    if (!menu) return;
    menuPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = () => setMenu(undefined);
    const clickOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".asset-context-menu")) close();
    };
    window.addEventListener("pointerdown", clickOutside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", clickOutside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  useEffect(() => {
    const id = ++sharedRequest.current;
    if (source !== "public") return;
    setShared([]);
    setSharedOffset(0);
    setHasMore(false);
    setNotice("");
    setLoading(true);
    const timer = window.setTimeout(() => void loadPublic(id, 0), keyword ? 180 : 0);
    return () => { sharedRequest.current++; window.clearTimeout(timer); };
  }, [kind, keyword, source, refresh]);

  async function loadPublic(id: number, offset: number) {
    setLoading(true);
    try {
      const page = await api.libraryPage({ kind, query: keyword, mode: "assets", offset });
      if (id !== sharedRequest.current) return;
      const received = page.items.flatMap(({ assets: items, prompt }) =>
        items.filter((asset) => kind === "all" || assetKind(asset) === kind)
          .map((asset): Entry => ({ asset, round: 0, prompt, source: "public" })));
      setShared((current) => [...new Map([...current, ...received].map((entry) => [entry.asset.id, entry])).values()]);
      setSharedOffset(offset + page.items.length);
      setHasMore(page.hasMore);
    } catch (error) {
      if (id === sharedRequest.current) setNotice(error instanceof Error ? error.message : "读取公共素材失败");
    } finally {
      if (id === sharedRequest.current) setLoading(false);
    }
  }

  function toggle(entry: Entry) {
    const id = entry.asset.id;
    const isImage = assetKind(entry.asset) === "image";
    setNotice("");
    if (selectedSet.has(id)) setSelected((current) => current.filter((item) => item !== id));
    else if (isImage && imageCount >= limit) setNotice(`最多选择 ${limit} 张图片，请先移除一张。`);
    else if (!isImage && mediaCount >= MAX_CHAT_MEDIA_FILES) setNotice(`最多选择 ${MAX_CHAT_MEDIA_FILES} 个音视频文件。`);
    else {
      setSelected((current) => [...current, id]);
      setDraftEntries((current) => ({ ...current, [id]: entry }));
    }
  }

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try { await operation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  function switchSource(value: typeof source) {
    setSource(value);
    setOrigin("all");
    setNotice("");
    setMenu(undefined);
  }

  function openMenu(entry: Entry, x: number, y: number) {
    setMenu({ entry, left: Math.max(8, Math.min(x, window.innerWidth - 180)), top: Math.max(8, Math.min(y, window.innerHeight - 190)) });
  }

  return createPortal(
    <div className="asset-library-overlay" inert={previewOpen} onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="asset-library" role="dialog" aria-modal="true" aria-labelledby={title} ref={dialog}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (menu) setMenu(undefined);
            else if (deleteTarget && !busy) setDeleteTarget(undefined);
            else if (!busy) onClose();
          }
          if (event.key !== "Tab") return;
          const scope = deletePanel.current ?? menuPanel.current ?? event.currentTarget;
          const items = [...scope.querySelectorAll<HTMLElement>("button:not(:disabled), input:not([tabindex='-1']), select:not(:disabled)")];
          if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
        }}>
        <header className="asset-library-head">
          <span className="asset-library-emblem"><Layers size={19} /></span>
          <div className="asset-library-heading"><h2 id={title}>聊天素材</h2>{assets.length > 0 && <p>本会话 · {assets.length} 项素材</p>}</div>
          <button type="button" className="asset-library-icon" aria-label="关闭素材库" disabled={busy} onClick={onClose}><X size={17} /></button>
        </header>

        <div className="asset-library-sources">
          <div className="asset-library-segments" role="group" aria-label="素材库">
            <button type="button" aria-pressed={source === "conversation"} onClick={() => switchSource("conversation")}>本会话</button>
            <button type="button" aria-pressed={source === "public"} onClick={() => switchSource("public")}>公共素材</button>
          </div>
          <input ref={input} className="file-input" type="file" tabIndex={-1} multiple
            accept={`image/png,image/jpeg,image/webp,${CHAT_MEDIA_ACCEPT}`} onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              if (files.length) void run(async () => { await onUpload(files); setKind("all"); setOrigin("all"); setQuery(""); switchSource("conversation"); });
            }} />
          <button className="asset-library-primary" type="button" disabled={busy || !canModify} onClick={() => input.current?.click()}>
            {busy ? <LoadingIndicator variant="dots" size={22} /> : <Upload size={15} />}上传素材
          </button>
        </div>
        <div className="asset-library-filters">
          <div className="asset-library-types" role="group" aria-label="素材类型">
            {types.map((type) => <button key={type.id} type="button" aria-pressed={kind === type.id} onClick={() => { setNotice(""); setKind(type.id); }}>
              {"icon" in type && <type.icon size={14} />}{type.label}
            </button>)}
          </div>
          <div className="asset-library-segments" role="group" aria-label="查看方式">
            <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={!list} onClick={() => setList(false)}><Grid2X2 size={15} /></button>
            <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={list} onClick={() => setList(true)}><List size={16} /></button>
          </div>
        </div>
        <div className="asset-library-tools">
          <label className="asset-library-search"><Search size={15} />
            <input ref={search} type="search" aria-label="搜索素材" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索素材名称或描述" />
          </label>
          {source === "conversation" && <>
            <select aria-label="来源筛选" value={origin} onChange={(event) => setOrigin(event.target.value)}>
              <option value="all">全部来源</option>
              {Object.entries(origins).filter(([value]) => assets.some((entry) => entry.source === value) || origin === value)
                .map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              <option value="selected">已选素材</option>
            </select>
            <button type="button" className="asset-library-icon asset-library-sort" aria-label={oldest ? "切换为最新优先" : "切换为最早优先"}
              onClick={() => setOldest(!oldest)}>{oldest ? "最早" : "最新"}</button>
          </>}
        </div>
        <div className={`asset-library-grid${list ? " is-list" : ""}${source === "public" ? " is-public" : ""}`} aria-busy={source === "public" && loading}>
          {entries.map((entry) => {
            const { asset } = entry;
            const isImage = assetKind(asset) === "image";
            const index = selected.indexOf(asset.id);
            const name = assetName(entry);
            return <article key={asset.id} className={`asset-library-item${index >= 0 ? " is-selected" : ""}`}
              onContextMenu={(event) => { event.preventDefault(); openMenu(entry, event.clientX, event.clientY); }}>
              <div className="asset-library-tile">
                <button type="button" className="asset-library-thumb" aria-label={isImage && canModify ? `选择 ${name}` : `预览 ${name}`}
                  aria-pressed={isImage && canModify ? index >= 0 : undefined}
                  onClick={() => isImage && canModify ? toggle(entry) : onPreview(asset)}>
                  <AssetCover asset={asset} />
                  {index >= 0 && <span className="asset-library-order" aria-hidden="true"><Check size={12} />{index + 1}</span>}
                </button>
                {canModify && (isImage ? <button type="button" className="asset-library-preview asset-library-icon"
                  aria-label={`预览 ${name}`} title="预览" onClick={() => onPreview(asset)}><Eye size={15} /></button>
                  : <button type="button" className="asset-library-preview asset-library-icon"
                    aria-pressed={index >= 0} aria-label={`选择 ${name}`} title={index >= 0 ? "移除选择" : "选为附件"}
                    onClick={() => toggle(entry)}>{index >= 0 ? <Check size={15} /> : <Plus size={15} />}</button>)}
              </div>
              <div className="asset-library-caption">
                <div><strong title={name}>{name}</strong><small>{originLabel(entry)}</small></div>
                <button type="button" className="asset-library-icon" aria-label={`${name} 的操作`} title="更多操作"
                  onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); openMenu(entry, rect.right - 168, rect.bottom + 4); }}><MoreHorizontal size={16} /></button>
              </div>
            </article>;
          })}
          {source === "public" && loading && <div className="asset-library-list-state" role="status"><LoadingIndicator variant="dots" size={26} />正在读取素材</div>}
          {source === "public" && !loading && hasMore && <button className="secondary-button compact asset-library-list-state" type="button"
            onClick={() => void loadPublic(sharedRequest.current, sharedOffset)}>加载更多</button>}
          {!entries.length && (source !== "public" || !loading && !hasMore) && <div className="asset-library-empty">
            <span><ImageIcon size={23} strokeWidth={1.5} /></span>
            <strong>{keyword ? "没有匹配的素材" : source === "public" ? "暂无可添加的公共素材" : assets.length ? "这个筛选下没有素材" : "这段对话还没有素材"}</strong>
            {keyword ? <button type="button" className="secondary-button compact" onClick={() => setQuery("")}>清空搜索</button>
              : source === "conversation" && assets.length ? <button type="button" className="secondary-button compact" onClick={() => { setKind("all"); setOrigin("all"); }}>查看全部</button>
                : source === "conversation" ? <button type="button" className="secondary-button compact" onClick={() => switchSource("public")}>浏览公共素材</button>
                  : notice ? <button type="button" className="secondary-button compact" onClick={() => setRefresh((value) => value + 1)}>重新加载</button> : null}
          </div>}
        </div>
        {notice && <p className="asset-library-notice" role="status">{notice}</p>}
        <footer className="asset-library-foot">
          <span className="asset-library-selected" aria-live="polite"><CircleCheck size={17} />
            {selected.length ? [imageCount ? `${imageCount} 张图片` : "", mediaCount ? `${mediaCount} 项音视频` : ""].filter(Boolean).join(" · ") : "未选择素材"}
          </span>
          <div className="asset-library-actions">
            {selected.length > 0 && canModify && <button type="button" className="asset-library-text-button" disabled={busy} onClick={() => { setSelected([]); setNotice(""); }}>清空</button>}
            <button type="button" className="asset-library-primary" disabled={busy}
              onClick={() => { if (canModify) onApply(selectedAssets); onClose(); }}>
              {canModify && selected.length ? "用作附件" : "完成"}
            </button>
          </div>
        </footer>

        {menu && <div ref={menuPanel} className="canvas-bar-menu asset-context-menu" role="group" aria-label="素材操作" style={{ left: menu.left, top: menu.top }}>
          <div className="canvas-bar-menu-title">{assetName(menu.entry)}</div>
          {canModify && <button type="button" onClick={() => {
            toggle(menu.entry);
            setMenu(undefined);
          }}><Plus size={14} />{selectedSet.has(menu.entry.asset.id) ? "取消选择" : "选为附件"}</button>}
          {menu.entry.source !== "public" && <button type="button" onClick={() => {
            const ref = assetRef(menu.entry.asset.id);
            setMenu(undefined);
            void run(async () => { await navigator.clipboard.writeText(ref); setNotice(`已复制素材编号 ${ref}`); });
          }}><Copy size={14} />复制素材编号</button>}
          {!chatSelection && canModify && assetKind(menu.entry.asset) === "image" && selectedSet.has(menu.entry.asset.id) && <>
            {["设为首帧", "设为尾帧"].map((label, index) => <button type="button" key={label} disabled={imageCount <= index} onClick={() => {
              const id = menu.entry.asset.id;
              const photos = selectedAssets.filter((asset) => assetKind(asset) === "image" && asset.id !== id).map(({ id }) => id);
              photos.splice(index, 0, id);
              setSelected([...photos, ...selectedAssets.filter((asset) => assetKind(asset) !== "image").map(({ id }) => id)]);
              setMenu(undefined);
            }}><ImageIcon size={14} />{label}</button>)}
          </>}
          <button type="button" onClick={() => { const asset = menu.entry.asset; setMenu(undefined); void run(async () => { await api.downloadAsset(asset); }); }}><Download size={14} />下载素材</button>
          {onAddToBoard && <button type="button" onClick={() => { onAddToBoard(menu.entry); setMenu(undefined); }}><Layers size={14} />加入无限画布</button>}
          {menu.entry.source !== "public" && (menu.entry.source !== "library" || removableLibraryIds.has(menu.entry.asset.id)) && canModify && <button className="danger" type="button"
            onClick={() => { setDeleteTarget(menu.entry); setMenu(undefined); }}><Trash2 size={14} />{menu.entry.source === "library" ? "移出会话" : "删除素材"}</button>}
        </div>}

        {deleteTarget && <div className="asset-library-delete">
          <section ref={deletePanel} role="alertdialog" aria-modal="true" aria-label={deleteTarget.source === "library" ? "移出会话" : "删除素材"} className="asset-library-delete-card">
            <h3>{deleteTarget.source === "library" ? "移出会话" : "删除素材"}</h3>
            <p>{deleteTarget.source === "library" ? `将「${assetName(deleteTarget)}」从本会话的素材引用中移出，公共原文件会保留。`
              : `删除「${assetName(deleteTarget)}」会同时移除原文件和本会话中的相关引用，无法恢复。`}</p>
            {notice && <p role="alert">{notice}</p>}
            <div className="asset-library-actions">
              <button type="button" className="secondary-button" autoFocus disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</button>
              <button type="button" className="primary-button danger" disabled={busy} onClick={() => void run(async () => {
                const id = deleteTarget.asset.id;
                await onDeleteAsset(id);
                setSelected((current) => current.filter((item) => item !== id));
                setDeleteTarget(undefined);
              })}>{deleteTarget.source === "library" ? "确认移出" : "确认删除"}</button>
            </div>
          </section>
        </div>}
      </section>
    </div>,
    document.body,
  );
}
