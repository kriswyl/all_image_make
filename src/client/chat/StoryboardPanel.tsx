/**
 * 分镜工作台（大浮层）。
 *
 * 结构刻意分成左右两栏：
 * - 左：角色 / 场景设定图。每张设定图先给用户看大图、确认，之后才会被用于分镜；
 * - 右：镜头表。每镜的 prompt、角色、场景、画幅、状态和结果都在这里改、这里重跑。
 *
 * 一镜一镜从零画，人物和场景都会漂；所以生成分镜前先要求「设定图已确认」，
 * 缺哪张就在镜头行里直接写出来，而不是让用户花了钱才发现人物又变了。
 */
import {
  CheckCircle2, Clapperboard, Download, Image as ImageIcon, Layers, LoaderCircle, Maximize2,
  Mountain, PanelLeftClose, PanelLeftOpen, RefreshCw, Sparkles, Upload, UserRound, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { api } from "../api";
import {
  isStoryboardShotActive, storyboardShotMissing,
  STORYBOARD_ASPECT_RATIOS, type StoryboardCharacter, type StoryboardScene, type StoryboardShot,
  type StoryboardView,
} from "../../shared/storyboard";
import type { CanvasAsset } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";
import { AssetLightbox } from "./AssetLightbox";
import { ImagePickerMenu, SelectMenu, SuggestInput } from "../ui/SelectMenu";

type ToastKind = "ok" | "error";
type SettingKind = "character" | "scene";
type SettingItem = StoryboardCharacter | StoryboardScene;

const ACTIVE_SETTING_STATUS = new Set(["queued", "validating", "submitting", "running"]);
/** 设定栏的宽度 / 收起状态跟着用户走，下一次打开还是他习惯的样子 */
const SETTINGS_WIDTH_KEY = "yida.storyboard.settingsWidth";
const SETTINGS_COLLAPSED_KEY = "yida.storyboard.settingsCollapsed";
const SETTINGS_WIDTH_DEFAULT = 360;
const SETTINGS_WIDTH_MIN = 280;
const SETTINGS_WIDTH_MAX = 520;
type CSSVars = CSSProperties & Record<`--${string}`, string>;

function readSettingsCollapsed() {
  try {
    return localStorage.getItem(SETTINGS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function readSettingsWidth() {
  try {
    const value = Number(localStorage.getItem(SETTINGS_WIDTH_KEY));
    if (Number.isFinite(value) && value >= SETTINGS_WIDTH_MIN && value <= SETTINGS_WIDTH_MAX) return value;
  } catch {
    // localStorage 不可用时用默认宽度
  }
  return SETTINGS_WIDTH_DEFAULT;
}

function statusLabel(status: string): string {
  if (status === "planned" || status === "none") return "未生成";
  if (status === "succeeded") return "已生成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "expired") return "已过期";
  return "生成中";
}

function shotStatusLabel(shot: StoryboardShot): string {
  return statusLabel(shot.status);
}

export function StoryboardPanel({
  conversationId,
  refreshKey,
  canvasIds,
  images,
  onClose,
  onToast,
  onAddToCanvas,
  onTagCharacters,
  tagCharactersDisabled = false,
}: {
  conversationId: string;
  refreshKey: number;
  canvasIds: string[];
  images: CanvasAsset[];
  onClose: () => void;
  onToast: (kind: ToastKind, text: string) => void;
  onAddToCanvas: (assetId: string) => void;
  onTagCharacters: () => void;
  tagCharactersDisabled?: boolean;
}) {
  const [data, setData] = useState<StoryboardView | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [characterDrafts, setCharacterDrafts] = useState<Record<string, string>>({});
  const [sceneDrafts, setSceneDrafts] = useState<Record<string, string>>({});
  const [settingPromptDrafts, setSettingPromptDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [settingBusy, setSettingBusy] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<{ kind: SettingKind; id: string } | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const loadSeq = useRef(0);
  /** 设定栏可收窄 / 收起：确认完设定后把宽度还给分镜表 */
  const [settingsCollapsed, setSettingsCollapsed] = useState(readSettingsCollapsed);
  const [settingsWidth, setSettingsWidth] = useState(readSettingsWidth);
  const [resizing, setResizing] = useState(false);
  const settingsWidthRef = useRef(settingsWidth);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const autoCollapsed = useRef(false);

  const shots = data?.shots ?? [];
  const characters = data?.characters ?? [];
  const scenes = data?.scenes ?? [];
  const active = shots.some((shot) => isStoryboardShotActive(shot.status))
    || [...characters, ...scenes].some((item) => ACTIVE_SETTING_STATUS.has(item.status));

  async function load(quiet = true) {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await api.storyboard(conversationId);
      if (seq !== loadSeq.current) return;
      setData(next);
      setPromptDrafts((current) => Object.fromEntries(next.shots.map((shot) => [shot.id, current[shot.id] ?? shot.prompt])));
      setCharacterDrafts((current) => Object.fromEntries(next.shots.map((shot) => [shot.id, current[shot.id] ?? shot.character])));
      setSceneDrafts((current) => Object.fromEntries(next.shots.map((shot) => [shot.id, current[shot.id] ?? shot.scene])));
      setSettingPromptDrafts((current) => Object.fromEntries(
        [...next.characters, ...next.scenes].map((item) => [item.id, current[item.id] ?? item.prompt]),
      ));
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
    setPromptDrafts({});
    setCharacterDrafts({});
    setSceneDrafts({});
    setSettingPromptDrafts({});
    setSelected(new Set());
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (data) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

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

  const imageOptions = useMemo(() => {
    const result: Array<{ asset: Asset; label: string }> = [];
    const seen = new Set<string>();
    for (const entry of images) {
      if (seen.has(entry.asset.id)) continue;
      seen.add(entry.asset.id);
      result.push({ asset: entry.asset, label: entry.source === "storyboard" ? `分镜第 ${entry.round} 镜` : entry.source === "setting" ? "设定图" : entry.source === "upload" ? `上传 · ${entry.asset.fileName}` : `第 ${entry.round} 轮` });
    }
    for (const item of [...characters, ...scenes]) {
      if (!item.asset || seen.has(item.asset.id)) continue;
      seen.add(item.asset.id);
      result.push({ asset: item.asset, label: `设定：${item.name}` });
    }
    return result;
  }, [images, characters, scenes]);

  const settingsConfirmed = [...characters, ...scenes].filter((item) => item.confirmed).length;
  const settingsTotal = characters.length + scenes.length;
  const shotDone = shots.filter((shot) => shot.status === "succeeded").length;

  /**
   * 设定全部确认后自动收起一次——这是「设定完了，把空间让给分镜」。
   * 用户手动展开过（localStorage 里已经有值）就不再自动收，避免抢控制权。
   */
  useEffect(() => {
    if (autoCollapsed.current) return;
    if (!settingsTotal || settingsConfirmed < settingsTotal) return;
    try {
      if (localStorage.getItem(SETTINGS_COLLAPSED_KEY) !== null) return;
    } catch {
      return;
    }
    // 等浮层入场动画走完再收，避免「边淡入边收窄」的拥挤感
    const timer = window.setTimeout(() => {
      autoCollapsed.current = true;
      setSettingsCollapsed(true);
    }, 320);
    return () => window.clearTimeout(timer);
  }, [settingsConfirmed, settingsTotal]);

  function setSettingsOpen(open: boolean) {
    setSettingsCollapsed(!open);
    try {
      localStorage.setItem(SETTINGS_COLLAPSED_KEY, open ? "0" : "1");
    } catch {
      // 隐身模式 / 存储被禁用时只在本次会话生效
    }
  }

  function expandSettings(section?: "characters" | "scenes") {
    setSettingsOpen(true);
    if (!section) return;
    // 等收起态卸掉、栏宽展开后再滚到对应分组
    window.setTimeout(() => {
      document.getElementById(`storyboard-settings-${section}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 220);
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (settingsCollapsed) return;
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: settingsWidthRef.current };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    const next = Math.min(
      SETTINGS_WIDTH_MAX,
      Math.max(SETTINGS_WIDTH_MIN, resizeStart.current.width + event.clientX - resizeStart.current.x),
    );
    settingsWidthRef.current = next;
    setSettingsWidth(next);
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    setResizing(false);
    try {
      localStorage.setItem(SETTINGS_WIDTH_KEY, String(settingsWidthRef.current));
    } catch {
      // 同上
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resetSettingsWidth() {
    settingsWidthRef.current = SETTINGS_WIDTH_DEFAULT;
    setSettingsWidth(SETTINGS_WIDTH_DEFAULT);
    try {
      localStorage.setItem(SETTINGS_WIDTH_KEY, String(SETTINGS_WIDTH_DEFAULT));
    } catch {
      // 同上
    }
  }

  function settingMissing(shot: StoryboardShot): string[] {
    if (shot.kind !== "image" || !data) return [];
    const missing: string[] = [];
    for (const name of shot.characters) {
      const character = characters.find((item) => item.name === name);
      if (!character?.asset) missing.push(`角色「${name}」还没有设定图`);
      else if (!character.confirmed) missing.push(`角色「${name}」的设定图还没确认`);
    }
    if (shot.scene) {
      const scene = scenes.find((item) => item.name === shot.scene);
      if (!scene?.asset) missing.push(`场景「${shot.scene}」还没有设定图`);
      else if (!scene.confirmed) missing.push(`场景「${shot.scene}」的设定图还没确认`);
    }
    return missing;
  }

  const selectable = useMemo(
    () => shots.filter((shot) => !storyboardShotMissing(shot) && shot.status !== "succeeded"
      && !isStoryboardShotActive(shot.status) && settingMissing(shot).length === 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shots, data],
  );
  const rerunnable = useMemo(
    () => shots.filter((shot) => !storyboardShotMissing(shot) && shot.status === "succeeded"
      && settingMissing(shot).length === 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shots, data],
  );
  const maxBatch = data?.maxBatch ?? 8;
  const canGenerateAny = data?.canGenerateImage || data?.canGenerateVideo;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) { next.delete(id); return next; }
      if (next.size >= maxBatch) { onToast("error", `一次最多提交 ${maxBatch} 个镜头`); return current; }
      const shot = shots.find((item) => item.id === id);
      const missing = shot ? settingMissing(shot) : [];
      if (missing.length) { onToast("error", missing.join("；")); return current; }
      next.add(id);
      return next;
    });
  }

  function selectReady() {
    setSelected(new Set(selectable.slice(0, maxBatch).map((shot) => shot.id)));
  }

  function selectRerun() {
    setSelected(new Set(rerunnable.slice(0, maxBatch).map((shot) => shot.id)));
  }

  async function saveShot(
    shotId: string,
    patch: Partial<Pick<StoryboardShot, "prompt" | "character" | "scene" | "kind" | "aspectRatio">>,
  ): Promise<boolean> {
    const timer = saveTimers.current.get(shotId);
    if (timer) { clearTimeout(timer); saveTimers.current.delete(shotId); }
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

  function debounce(key: string, action: () => void) {
    const timer = saveTimers.current.get(key);
    if (timer) clearTimeout(timer);
    saveTimers.current.set(key, setTimeout(() => { saveTimers.current.delete(key); action(); }, 700));
  }

  function changePrompt(shot: StoryboardShot, value: string) {
    setPromptDrafts((current) => ({ ...current, [shot.id]: value }));
    debounce(`prompt:${shot.id}`, () => void saveShot(shot.id, { prompt: value }));
  }

  function flushPrompt(shot: StoryboardShot) {
    const timer = saveTimers.current.get(`prompt:${shot.id}`);
    if (!timer) return;
    clearTimeout(timer);
    saveTimers.current.delete(`prompt:${shot.id}`);
    void saveShot(shot.id, { prompt: promptDrafts[shot.id] ?? shot.prompt });
  }

  function changeCharacter(shot: StoryboardShot, value: string) {
    setCharacterDrafts((current) => ({ ...current, [shot.id]: value }));
    debounce(`character:${shot.id}`, () => void saveShot(shot.id, { character: value.trim() }));
  }

  function changeScene(shot: StoryboardShot, value: string) {
    setSceneDrafts((current) => ({ ...current, [shot.id]: value }));
    debounce(`scene:${shot.id}`, () => void saveShot(shot.id, { scene: value.trim() }));
  }

  async function saveSettingPrompt(kind: SettingKind, item: SettingItem, value: string) {
    setSettingBusy(item.id);
    try {
      const next = kind === "character"
        ? await api.updateStoryboardCharacter(conversationId, item.id, { prompt: value })
        : await api.updateStoryboardScene(conversationId, item.id, { prompt: value });
      setData(next);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "保存设定描述失败");
    } finally {
      setSettingBusy(null);
    }
  }

  function changeSettingPrompt(kind: SettingKind, item: SettingItem, value: string) {
    setSettingPromptDrafts((current) => ({ ...current, [item.id]: value }));
    debounce(`setting:${item.id}`, () => void saveSettingPrompt(kind, item, value));
  }

  async function generateSettings(characterIds: string[], sceneIds: string[]) {
    const total = characterIds.length + sceneIds.length;
    if (!total) return;
    setSettingBusy("all");
    try {
      const result = await api.generateStoryboardSettings(conversationId, characterIds, sceneIds);
      setData(result.view);
      if (result.failures.length) onToast("error", result.failures.map((item) => `${item.name}：${item.error}`).join("；"));
      else onToast("ok", `已提交 ${result.submitted} 张设定图，完成后会显示在左侧`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "提交设定图失败");
    } finally {
      setSettingBusy(null);
    }
  }

  function generateMissingSettings() {
    const missingCharacters = characters.filter((item) => !item.asset && !ACTIVE_SETTING_STATUS.has(item.status));
    const missingScenes = scenes.filter((item) => !item.asset && !ACTIVE_SETTING_STATUS.has(item.status));
    if (!missingCharacters.length && !missingScenes.length) {
      onToast("ok", "所有设定图都已经有了，点卡片上的「确认使用」即可");
      return;
    }
    // 两类一起提交时也守住 8 张上限
    const charactersToGenerate = missingCharacters.slice(0, maxBatch).map((item) => item.id);
    const scenesToGenerate = missingScenes.slice(0, Math.max(0, maxBatch - charactersToGenerate.length)).map((item) => item.id);
    void generateSettings(charactersToGenerate, scenesToGenerate);
  }

  async function confirmSetting(kind: SettingKind, item: SettingItem) {
    setSettingBusy(item.id);
    try {
      const next = kind === "character"
        ? await api.updateStoryboardCharacter(conversationId, item.id, { confirmed: true })
        : await api.updateStoryboardScene(conversationId, item.id, { confirmed: true });
      setData(next);
      onToast("ok", `已确认「${item.name}」的设定图`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "确认失败");
    } finally {
      setSettingBusy(null);
    }
  }

  async function chooseSettingAsset(kind: SettingKind, item: SettingItem, assetId: string) {
    if (!assetId) return;
    setSettingBusy(item.id);
    try {
      // 手动选图就是用户的确认动作，直接置为已确认
      const next = kind === "character"
        ? await api.updateStoryboardCharacter(conversationId, item.id, { assetId, confirmed: true })
        : await api.updateStoryboardScene(conversationId, item.id, { assetId, confirmed: true });
      setData(next);
      onToast("ok", `「${item.name}」的设定图已更新`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "设置失败");
    } finally {
      setSettingBusy(null);
    }
  }

  async function uploadSettingFile(file: File) {
    if (!uploadTarget) return;
    setSettingBusy(uploadTarget.id);
    try {
      const next = await api.uploadStoryboardSetting(conversationId, uploadTarget.kind, uploadTarget.id, file);
      setData(next);
      onToast("ok", "已上传并确认设定图");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "上传失败");
    } finally {
      setSettingBusy(null);
      setUploadTarget(null);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  }

  async function submitGenerate(ids: string[]) {
    if (!ids.length) return;
    setSubmitting(true);
    try {
      const toSave = shots.filter((shot) => ids.includes(shot.id) && promptDrafts[shot.id] !== undefined && promptDrafts[shot.id] !== shot.prompt);
      const saved = await Promise.all(toSave.map((shot) => saveShot(shot.id, { prompt: promptDrafts[shot.id]! })));
      if (saved.some((ok) => !ok)) return;
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

  const confirmShots = confirming ? shots.filter((shot) => confirming.includes(shot.id)) : [];
  const confirmImages = confirmShots.filter((shot) => shot.kind === "image").length;
  const confirmVideos = confirmShots.length - confirmImages;
  const confirmCharacterNames = [...new Set(confirmShots.flatMap((shot) => shot.characters))];
  const confirmSceneNames = [...new Set(confirmShots.map((shot) => shot.scene).filter(Boolean))];
  const confirmMissing = [...new Set(confirmShots.flatMap((shot) => settingMissing(shot)))];
  const rerunCount = confirmShots.filter((shot) => shot.status === "succeeded").length;
  const legacyReference = data?.reference;
  const legacyAutoBase = characters.length === 0 && scenes.length === 0
    && legacyReference?.mode === "auto" && !legacyReference.asset && confirmImages >= 2;

  function renderSettingCard(kind: SettingKind, item: SettingItem) {
    const Icon = kind === "character" ? UserRound : Mountain;
    const isBusy = settingBusy === item.id;
    const anyBusy = settingBusy !== null;
    const isActive = ACTIVE_SETTING_STATUS.has(item.status);
    return (
      <div key={`${kind}:${item.id}`} className={`setting-card ${item.confirmed ? "is-confirmed" : ""}`}>
        <button
          type="button"
          className={`setting-card-image is-${kind}`}
          title={item.asset ? "点开看大图" : "还没有设定图"}
          onClick={() => item.asset && setPreview(item.asset)}
        >
          {item.asset
            ? <img src={api.assetUrl(item.asset.thumbUrl ?? item.asset.url)} alt="" />
            : <span className="setting-card-placeholder"><Icon size={22} /><small>{statusLabel(item.status)}</small></span>}
          <span className={`setting-status is-${item.status} ${item.confirmed ? "is-confirmed" : ""}`}>
            {isActive ? <LoaderCircle size={11} className="spin" /> : item.confirmed ? <CheckCircle2 size={11} /> : null}
            {item.confirmed ? "已确认" : item.asset ? "待确认" : statusLabel(item.status)}
          </span>
        </button>
        <div className="setting-card-body">
          <div className="setting-card-title">
            <strong>{item.name}</strong>
            <small>{item.shotCount} 镜</small>
          </div>
          <textarea
            className="setting-card-prompt"
            rows={3}
            maxLength={2000}
            value={settingPromptDrafts[item.id] ?? item.prompt}
            placeholder={kind === "character" ? "外貌、年龄、发型、服装…" : "空间、陈设、光线、色调…"}
            onChange={(event) => changeSettingPrompt(kind, item, event.target.value)}
            onBlur={() => {
              const timer = saveTimers.current.get(`setting:${item.id}`);
              if (!timer) return;
              clearTimeout(timer);
              saveTimers.current.delete(`setting:${item.id}`);
              void saveSettingPrompt(kind, item, settingPromptDrafts[item.id] ?? item.prompt);
            }}
          />
          <div className="setting-card-actions">
            <button type="button" className="secondary-button compact" disabled={anyBusy || isActive}
              onClick={() => void generateSettings(kind === "character" ? [item.id] : [], kind === "scene" ? [item.id] : [])}>
              {isBusy || isActive ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
              {item.asset ? "重生成" : "生成"}
            </button>
            <button type="button" className="secondary-button compact" disabled={anyBusy}
              onClick={() => { setUploadTarget({ kind, id: item.id }); uploadRef.current?.click(); }}>
              <Upload size={12} />上传
            </button>
            <ImagePickerMenu
              disabled={anyBusy}
              options={imageOptions.map((option) => ({
                id: option.asset.id,
                label: option.label,
                url: api.assetUrl(option.asset.thumbUrl ?? option.asset.url),
              }))}
              onSelect={(assetId) => void chooseSettingAsset(kind, item, assetId)}
            />
            {item.asset && !item.confirmed ? (
              <button type="button" className="primary-button compact" disabled={anyBusy}
                onClick={() => void confirmSetting(kind, item)}>
                <CheckCircle2 size={12} />确认使用
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="storyboard-overlay" role="dialog" aria-modal="true" aria-label="分镜工作台"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
      <div className="storyboard-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="storyboard-modal-head">
          <div className="storyboard-modal-title">
            <Clapperboard size={18} />
            <div>
              <h2>分镜工作台</h2>
              <p>先生成并确认人物 / 场景设定图，再生成分镜图</p>
            </div>
          </div>
          <div className="storyboard-progress">
            <button
              type="button"
              className={`storyboard-progress-pill ${settingsConfirmed === settingsTotal && settingsTotal ? "is-done" : ""}`}
              onClick={() => setSettingsOpen(settingsCollapsed)}
              title={settingsCollapsed ? "展开角色 / 场景设定" : "收起角色 / 场景设定"}
              aria-expanded={!settingsCollapsed}
            >
              {settingsCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
              设定图 {settingsConfirmed}/{settingsTotal}
            </button>
            <span className="storyboard-progress-pill">分镜 {shotDone}/{shots.length}</span>
            {loading ? <LoaderCircle size={13} className="spin" /> : null}
          </div>
          <div className="storyboard-modal-actions">
            {shots.length ? (
              <button type="button" className="secondary-button compact" disabled={tagCharactersDisabled} onClick={onTagCharacters}>
                <UserRound size={13} />{characters.length || scenes.length ? "重新标注" : "标注角色/场景"}
              </button>
            ) : null}
            <button type="button" className="secondary-button compact" disabled={Boolean(settingBusy)}
              onClick={generateMissingSettings}>
              <Sparkles size={13} />生成缺失设定图
            </button>
            <button type="button" className="icon-button compact" title="刷新" onClick={() => void load(false)}>
              <RefreshCw size={14} />
            </button>
            <button type="button" className="icon-button compact" title="关闭" onClick={onClose}><X size={15} /></button>
          </div>
        </header>

        <div
          className={`storyboard-modal-body ${settingsCollapsed ? "is-settings-collapsed" : ""} ${resizing ? "is-resizing" : ""}`}
          style={{ "--storyboard-settings-width": settingsCollapsed ? "56px" : `${settingsWidth}px` } as CSSVars}
        >
          <aside className={`storyboard-settings ${settingsCollapsed ? "is-collapsed" : ""}`}>
            {settingsCollapsed ? (
              /* 收起态：只留一条窄轨，角色 / 场景数量和确认进度还看得见，点一下就能回去 */
              <div className="storyboard-settings-rail">
                <button type="button" className="rail-toggle" title="展开角色 / 场景设定" onClick={() => expandSettings()}>
                  <PanelLeftOpen size={16} />
                </button>
                <button type="button" className="rail-stat" title={`角色设定 · ${characters.length}`} onClick={() => expandSettings("characters")}>
                  <UserRound size={15} />
                  <span>{characters.length}</span>
                </button>
                <button type="button" className="rail-stat" title={`场景设定 · ${scenes.length}`} onClick={() => expandSettings("scenes")}>
                  <Mountain size={15} />
                  <span>{scenes.length}</span>
                </button>
                <span
                  className={`rail-progress ${settingsTotal && settingsConfirmed === settingsTotal ? "is-done" : ""}`}
                  title={`设定图已确认 ${settingsConfirmed}/${settingsTotal}`}
                >
                  {settingsConfirmed}/{settingsTotal}
                </span>
                <span className="rail-label">设定图</span>
              </div>
            ) : (
              <>
                <div className="storyboard-settings-head">
                  <strong>角色与场景</strong>
                  <span className={`storyboard-settings-count ${settingsTotal && settingsConfirmed === settingsTotal ? "is-done" : ""}`}>
                    {settingsTotal ? `${settingsConfirmed}/${settingsTotal} 已确认` : "暂无设定"}
                  </span>
                  <button type="button" className="icon-button compact" title="收起设定图，把宽度让给分镜" onClick={() => setSettingsOpen(false)}>
                    <PanelLeftClose size={15} />
                  </button>
                </div>
                <div className="storyboard-settings-scroll">
                  <section className="setting-section" id="storyboard-settings-characters">
                    <div className="setting-section-head">
                      <div><UserRound size={14} /><h3>角色设定</h3><span>{characters.length}</span></div>
                      {characters.length ? (
                        <button type="button" className="link-btn"
                          onClick={() => void generateSettings(characters.filter((item) => !item.asset).map((item) => item.id).slice(0, maxBatch), [])}>
                          生成全部
                        </button>
                      ) : null}
                    </div>
                    {characters.length
                      ? characters.map((item) => renderSettingCard("character", item))
                      : <div className="setting-empty">还没有角色标签。点右上角「标注角色/场景」，或直接在镜头里填角色名。</div>}
                  </section>

                  <section className="setting-section" id="storyboard-settings-scenes">
                    <div className="setting-section-head">
                      <div><Mountain size={14} /><h3>场景设定</h3><span>{scenes.length}</span></div>
                      {scenes.length ? (
                        <button type="button" className="link-btn"
                          onClick={() => void generateSettings([], scenes.filter((item) => !item.asset).map((item) => item.id).slice(0, maxBatch))}>
                          生成全部
                        </button>
                      ) : null}
                    </div>
                    {scenes.length
                      ? scenes.map((item) => renderSettingCard("scene", item))
                      : <div className="setting-empty">还没有场景标签。标注后可以给每个地点生成一张空镜设定图。</div>}
                  </section>
                </div>
              </>
            )}
          </aside>

          {/* 收起时保留这个网格项（宽度 0），列数不变，展开/收起才能真的做宽度过渡 */}
          <div
            className={`storyboard-splitter ${settingsCollapsed ? "is-hidden" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整设定栏宽度"
            aria-hidden={settingsCollapsed}
            aria-valuenow={settingsWidth}
            aria-valuemin={SETTINGS_WIDTH_MIN}
            aria-valuemax={SETTINGS_WIDTH_MAX}
            title="拖动调整宽度，双击恢复默认"
            tabIndex={settingsCollapsed ? -1 : 0}
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onDoubleClick={resetSettingsWidth}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = Math.min(
                SETTINGS_WIDTH_MAX,
                Math.max(SETTINGS_WIDTH_MIN, settingsWidthRef.current + (event.key === "ArrowLeft" ? -16 : 16)),
              );
              settingsWidthRef.current = next;
              setSettingsWidth(next);
              try {
                localStorage.setItem(SETTINGS_WIDTH_KEY, String(next));
              } catch {
                // 同上
              }
            }}
          />

          <main className="storyboard-shots">
            <div className="storyboard-shots-toolbar">
              <div className="storyboard-shots-title">
                <strong>分镜图</strong>
                <span>{shots.length} 镜 · 已完成 {shotDone}</span>
              </div>
              <div className="storyboard-shots-actions">
                <button type="button" className="link-btn" onClick={selectReady} disabled={!selectable.length}>选中可生成</button>
                {rerunnable.length ? (
                  <button type="button" className="link-btn" onClick={selectRerun}>选中已完成</button>
                ) : null}
                <button
                  type="button"
                  className="primary-button compact"
                  disabled={!selected.size || !canGenerateAny || submitting}
                  onClick={() => setConfirming([...selected])}
                >
                  <Sparkles size={13} />生成选中 {selected.size ? `(${selected.size})` : ""}
                </button>
              </div>
            </div>

            {!canGenerateAny && shots.length ? (
              <div className="storyboard-note">还没有可用的生图 / 生视频渠道，请先到「模型配置」里添加。</div>
            ) : null}

            <div className="shot-list">
              {shots.map((shot) => {
                const missing = storyboardShotMissing(shot);
                const missingSettings = settingMissing(shot);
                const activeShot = isStoryboardShotActive(shot.status);
                const succeeded = shot.status === "succeeded";
                const checked = selected.has(shot.id);
                return (
                  <div key={shot.id} className={`shot-card ${checked ? "is-selected" : ""} ${succeeded ? "is-done" : ""}`}>
                    <div className="shot-pick">
                      <input type="checkbox" checked={checked}
                        disabled={Boolean(missing) || activeShot || missingSettings.length > 0}
                        onChange={() => toggle(shot.id)}
                        title={missingSettings.length ? "先处理左侧设定图" : undefined}
                        aria-label={`选择第 ${shot.index} 镜`} />
                      <span className="shot-index">{shot.index}</span>
                    </div>

                    <div className="shot-main">
                      <div className="shot-meta">
                        <SelectMenu
                          className="shot-aspect"
                          ariaLabel={`第 ${shot.index} 镜的画幅`}
                          value={shot.aspectRatio}
                          disabled={activeShot}
                          options={STORYBOARD_ASPECT_RATIOS.map((ratio) => ({
                            value: ratio,
                            label: ratio || "默认画幅",
                          }))}
                          onChange={(value) => void saveShot(shot.id, { aspectRatio: value })}
                        />
                        <label className="shot-character" title="出场角色；多个人物用「、」分隔">
                          <UserRound size={11} />
                          <SuggestInput
                            value={characterDrafts[shot.id] ?? shot.character}
                            suggestions={characters.map((item) => item.name)}
                            multiple
                            placeholder="无人物"
                            maxLength={120}
                            disabled={activeShot}
                            ariaLabel={`第 ${shot.index} 镜的出场角色`}
                            onChange={(value) => changeCharacter(shot, value)}
                            onBlur={() => {
                              const timer = saveTimers.current.get(`character:${shot.id}`);
                              if (!timer) return;
                              clearTimeout(timer);
                              saveTimers.current.delete(`character:${shot.id}`);
                              void saveShot(shot.id, { character: (characterDrafts[shot.id] ?? shot.character).trim() });
                            }}
                          />
                        </label>
                        <label className="shot-character" title="场景名；同一地点用同一个名字">
                          <Mountain size={11} />
                          <SuggestInput
                            value={sceneDrafts[shot.id] ?? shot.scene}
                            suggestions={scenes.map((item) => item.name)}
                            placeholder="无场景"
                            maxLength={80}
                            disabled={activeShot}
                            ariaLabel={`第 ${shot.index} 镜的场景`}
                            onChange={(value) => changeScene(shot, value)}
                            onBlur={() => {
                              const timer = saveTimers.current.get(`scene:${shot.id}`);
                              if (!timer) return;
                              clearTimeout(timer);
                              saveTimers.current.delete(`scene:${shot.id}`);
                              void saveShot(shot.id, { scene: (sceneDrafts[shot.id] ?? shot.scene).trim() });
                            }}
                          />
                        </label>
                        <span className={`shot-status is-${shot.status}`} title={shot.errorMessage ?? undefined}>
                          {shotStatusLabel(shot)}
                        </span>
                        {saving[shot.id] ? <span className="shot-saving">保存中…</span> : null}
                      </div>
                      {shot.sourceText ? <div className="shot-source" title={shot.sourceText}>{shot.sourceText}</div> : null}
                      <textarea className="shot-prompt" rows={2} maxLength={20000}
                        value={promptDrafts[shot.id] ?? shot.prompt}
                        placeholder="画面描述：人物、场景、构图、光线、风格…"
                        disabled={activeShot}
                        onChange={(event) => changePrompt(shot, event.target.value)}
                        onBlur={() => flushPrompt(shot)} />
                      {missing ? <div className="shot-warning">{missing}</div> : null}
                      {missingSettings.length ? <div className="shot-warning">先处理设定图：{missingSettings.join("；")}</div> : null}
                    </div>

                    <div className="shot-side">
                      {shot.asset ? (
                        <button type="button" className="shot-thumb" title="点开看大图" onClick={() => setPreview(shot.asset)}>
                          {shot.asset.mimeType.startsWith("video/")
                            ? <video src={api.assetUrl(shot.asset.url)} muted playsInline preload="metadata" onContextMenu={(event) => event.preventDefault()} />
                            : <img src={api.assetUrl(shot.asset.thumbUrl ?? shot.asset.url)} alt="" loading="lazy" />}
                          <span className="shot-thumb-hint"><Maximize2 size={11} />预览</span>
                        </button>
                      ) : <span className="shot-thumb is-empty"><ImageIcon size={18} /></span>}
                      <div className="shot-actions">
                        <button type="button" className="link-btn"
                          disabled={Boolean(missing) || activeShot || submitting || !data?.canGenerateImage || missingSettings.length > 0}
                          onClick={() => setConfirming([shot.id])}>
                          {activeShot ? <LoaderCircle size={12} className="spin" /> : succeeded ? <RefreshCw size={12} /> : <Sparkles size={12} />}
                          {activeShot ? "生成中" : succeeded ? "重跑" : "生成"}
                        </button>
                        {shot.asset ? (
                          <>
                            <button type="button" className="link-btn" onClick={() => setPreview(shot.asset)}>预览</button>
                            <button type="button" className="link-btn" onClick={() => onAddToCanvas(shot.asset!.id)}
                              disabled={canvasIds.includes(shot.asset.id)}>
                              <Layers size={12} />{canvasIds.includes(shot.asset.id) ? "在画布" : "加画布"}
                            </button>
                            <button type="button" className="link-btn" disabled={Boolean(downloading)}
                              onClick={() => void download(shot.asset!)}>
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
                <Clapperboard size={20} />
                <span>还没有分镜。上传 .txt / .md 剧本，让助手「拆成分镜」。</span>
              </div>
            ) : null}
          </main>
        </div>

        <input
          ref={uploadRef}
          className="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadSettingFile(file);
          }}
        />
      </div>

      {confirming ? (
        <div className="modal-backdrop storyboard-confirm-backdrop" role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) setConfirming(null); }}>
          <div className="modal storyboard-confirm" role="dialog" aria-modal="true" aria-label="确认生成分镜">
            <div className="modal-header">
              <div><Clapperboard size={18} /><h2>确认生成分镜</h2></div>
              <button type="button" className="icon-button" onClick={() => setConfirming(null)} disabled={submitting}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-lead">
                将提交 <strong>{confirmShots.length}</strong> 个镜头
                {confirmImages ? `：图片 ${confirmImages} 个` : ""}
                {confirmVideos ? `${confirmImages ? "，" : "："}视频 ${confirmVideos} 个` : ""}。
              </p>
              <div className="storyboard-ref-summary">
                {confirmCharacterNames.length ? (
                  <div><strong>角色参考</strong>{confirmCharacterNames.map((name) => {
                    const item = characters.find((character) => character.name === name);
                    return <span key={name} className={item?.confirmed ? "is-ok" : "is-missing"}>{name}{item?.confirmed ? " · 已确认" : " · 未确认"}</span>;
                  })}</div>
                ) : null}
                {confirmSceneNames.length ? (
                  <div><strong>场景参考</strong>{confirmSceneNames.map((name) => {
                    const item = scenes.find((scene) => scene.name === name);
                    return <span key={name} className={item?.confirmed ? "is-ok" : "is-missing"}>{name}{item?.confirmed ? " · 已确认" : " · 未确认"}</span>;
                  })}</div>
                ) : null}
                {!confirmCharacterNames.length && !confirmSceneNames.length ? (
                  <div className="storyboard-ref-none">这一批没有角色 / 场景参考</div>
                ) : null}
              </div>
              {confirmMissing.length ? (
                <p className="storyboard-reference-note is-warning">先处理：{confirmMissing.join("；")}</p>
              ) : null}
              {rerunCount ? (
                <p className="storyboard-reference-note">
                  其中 {rerunCount} 镜已经有结果，会重新生成并替换分镜表里的最新结果；旧结果仍保留在生成历史里。
                </p>
              ) : legacyAutoBase ? (
                <p className="storyboard-reference-note is-warning">
                  还没有角色基准：会先生成一个有人物的镜头，再提交其余镜头（需要多等一次生成，最长约 3 分钟）。
                </p>
              ) : null}
              <p className="storyboard-billing">
                每个镜头都会按渠道单独计费，提交后不能撤回。失败或不满意的镜头可以单独重跑。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={() => setConfirming(null)} disabled={submitting}>取消</button>
              <button type="button" className="primary-button" disabled={submitting || confirmMissing.length > 0}
                onClick={() => void submitGenerate(confirming)}>
                {submitting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
                {submitting ? "提交中…" : `确认提交 ${confirmShots.length} 镜`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? <AssetLightbox assetId={preview.id} asset={preview} onClose={() => setPreview(null)} onToast={onToast} /> : null}
    </div>
  );
}
