import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, ChevronRight, CloudRain, Eye, KeyRound, LoaderCircle, Moon, Music, Plus, Sparkles, Sun,
} from "lucide-react";
import { api } from "./api";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { SelectMenu } from "./ui/SelectMenu";
import { formatDuration, usePersistentState } from "./task-ui";
import type { Channel, MusicMode, Task } from "../shared/types";
import type { Toast } from "./app-shared";
import { MusicResultWorkspace } from "./views/MusicResultWorkspace";
import { MusicLyricsDialog } from "./views/MusicLyrics";
import { isSunoSong, isSunoV6Version, SUNO_DAMOBI_MODEL, SUNO_TARGET_DURATIONS, SUNO_V6_DEFAULT, SUNO_V6_VERSIONS, type SunoSourceSelection } from "../shared/suno";
import "./views/music-workbench.css";

const MUSIC_MODE_SPECS: Array<{ value: MusicMode; label: string; hint: string }> = [
  { value: "inspiration", label: "灵感创作", hint: "" },
  { value: "custom", label: "自定义歌词", hint: "" },
  { value: "cover", label: "翻唱", hint: "选一首历史歌曲，可带入原曲歌词再编辑" },
  { value: "mashup", label: "混音", hint: "选两首不同的历史歌曲，混合成一首新作品" },
  { value: "sound", label: "音效", hint: "" },
  { value: "playlist", label: "歌单风格", hint: "按某个歌单的整体风格生成新曲" },
  { value: "sample", label: "取样", hint: "基于取样提示词生成" },
];

const MAIN_MODES = MUSIC_MODE_SPECS.slice(0, 2);
const MORE_MODES = MUSIC_MODE_SPECS.slice(2);
const MUSIC_IDEAS = [
  { label: "夏日海边", icon: Sun, prompt: "轻快的海边流行歌，明亮的吉他和温暖的人声" },
  { label: "雨后城市", icon: CloudRain, prompt: "关于雨后城市的独立民谣，温暖的人声与木吉他" },
  { label: "深夜散步", icon: Moon, prompt: "适合深夜散步的舒缓音乐，慵懒的鼓点和柔和的电钢琴" },
];
const MUSIC_STYLES = ["流行", "民谣", "摇滚", "电子", "古典", "嘻哈"];

/** 每个模式真正能选的 mv 不同，别让用户选到一个必然被上游拒绝的版本 */
const MUSIC_VERSION_SPECS: Array<{ value: string; label: string }> = [
  { value: "chirp-v3-5", label: "v3.5" },
  { value: "chirp-v3-5-tau", label: "v3.5 Tau" },
  { value: "chirp-v4", label: "v4" },
  { value: "chirp-v4-tau", label: "v4 Tau" },
  { value: "chirp-auk-turbo", label: "v4.5 Turbo" },
  { value: "chirp-auk", label: "v4.5" },
  { value: "chirp-bluejay", label: "v4.5+" },
  { value: "chirp-crow", label: "v5" },
  { value: "chirp-fenix", label: "v5.5" },
];

const MUSIC_VERSION_VALUES: Record<MusicMode, string[]> = {
  inspiration: ["chirp-v3-5", "chirp-v4", "chirp-auk", "chirp-bluejay", "chirp-crow", "chirp-fenix"],
  custom: ["chirp-v3-5", "chirp-v4", "chirp-auk", "chirp-bluejay", "chirp-crow", "chirp-fenix"],
  cover: ["chirp-v3-5-tau", "chirp-v4-tau", "chirp-auk-turbo", "chirp-auk", "chirp-bluejay", "chirp-crow", "chirp-fenix"],
  playlist: ["chirp-v3-5-tau", "chirp-v4-tau", "chirp-auk-turbo", "chirp-auk", "chirp-bluejay", "chirp-crow", "chirp-fenix"],
  mashup: ["chirp-crow", "chirp-fenix"],
  sound: ["chirp-crow", "chirp-fenix"],
  sample: ["chirp-crow", "chirp-fenix"],
};

const MUSIC_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const MUSIC_DRAFT_PREFIX = "vector-image:music-draft:";

export function MusicGenerateView(props: {
  channels: Channel[];
  selectedChannelId: string;
  selectedModel: string;
  activeTask: Task | null;
  tasks: Task[];
  sourceSelection?: SunoSourceSelection | null;
  onSourceSelectionApplied?: () => void;
  onChannelChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onAddChannel: () => void;
  onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
  onDiagnostics: (task: Task) => void;
}) {
  const [mode, setMode] = usePersistentState<MusicMode>("mode", "inspiration", MUSIC_DRAFT_PREFIX);
  const [prompt, setPrompt] = usePersistentState("prompt", "", MUSIC_DRAFT_PREFIX);
  const [coverPrompt, setCoverPrompt] = usePersistentState("coverPrompt", "", MUSIC_DRAFT_PREFIX);
  const [mashupPrompt, setMashupPrompt] = usePersistentState("mashupPrompt", "", MUSIC_DRAFT_PREFIX);
  const [title, setTitle] = usePersistentState("title", "", MUSIC_DRAFT_PREFIX);
  const [tags, setTags] = usePersistentState("tags", "", MUSIC_DRAFT_PREFIX);
  const [negativeTags, setNegativeTags] = usePersistentState("negativeTags", "", MUSIC_DRAFT_PREFIX);
  const [instrumental, setInstrumental] = usePersistentState("instrumental", false, MUSIC_DRAFT_PREFIX);
  const [version, setVersion] = usePersistentState("version", "chirp-v3-5", MUSIC_DRAFT_PREFIX);
  const [v6Version, setV6Version] = usePersistentState("v6Version", SUNO_V6_DEFAULT, MUSIC_DRAFT_PREFIX);
  const [targetDuration, setTargetDuration] = usePersistentState("targetDuration", "auto", MUSIC_DRAFT_PREFIX);
  const [styleWeight, setStyleWeight] = usePersistentState("styleWeight", "", MUSIC_DRAFT_PREFIX);
  const [weirdness, setWeirdness] = usePersistentState("weirdness", "", MUSIC_DRAFT_PREFIX);
  const [timeoutSeconds, setTimeoutSeconds] = usePersistentState("timeoutSeconds", 900, MUSIC_DRAFT_PREFIX);
  const [raw, setRaw] = usePersistentState("raw", "{}", MUSIC_DRAFT_PREFIX);
  const [coverClipId, setCoverClipId] = usePersistentState("coverClipId", "", MUSIC_DRAFT_PREFIX);
  const [mashupClipIds, setMashupClipIds] = usePersistentState<string[]>("mashupClipIds", [], MUSIC_DRAFT_PREFIX);
  const [soundTitle, setSoundTitle] = usePersistentState("soundTitle", "", MUSIC_DRAFT_PREFIX);
  const [soundDescription, setSoundDescription] = usePersistentState("soundDescription", "", MUSIC_DRAFT_PREFIX);
  const [soundExclusions, setSoundExclusions] = usePersistentState("soundExclusions", "", MUSIC_DRAFT_PREFIX);
  const [soundTempo, setSoundTempo] = usePersistentState<number | "">("soundTempo", 99, MUSIC_DRAFT_PREFIX);
  const [soundKey, setSoundKey] = usePersistentState("soundKey", "C", MUSIC_DRAFT_PREFIX);
  const [soundLoop, setSoundLoop] = usePersistentState("soundLoop", false, MUSIC_DRAFT_PREFIX);
  const [submitting, setSubmitting] = useState(false);
  const [sourceChannelId, setSourceChannelId] = usePersistentState("sourceChannelId", "", MUSIC_DRAFT_PREFIX);
  const lyricsPreviewRef = useRef<HTMLDialogElement>(null);
  const sourcePickerRef = useRef<HTMLDivElement>(null);

  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const modeSpec = MUSIC_MODE_SPECS.find((item) => item.value === mode) ?? MUSIC_MODE_SPECS[0]!;
  const custom = mode === "custom";
  const sound = mode === "sound";
  const damobi = props.selectedModel === SUNO_DAMOBI_MODEL;
  const targetDurationAvailable = damobi && (custom || mode === "inspiration");
  const needsPrompt = mode !== "sound" && mode !== "mashup";
  const activePrompt = mode === "cover" ? coverPrompt : mode === "mashup" ? mashupPrompt : prompt;
  const setActivePrompt = mode === "cover" ? setCoverPrompt : mode === "mashup" ? setMashupPrompt : setPrompt;
  const promptLimit = mode === "inspiration" ? 500 : 5000;
  const allowedVersions = MUSIC_VERSION_VALUES[mode];
  const versionOptions = damobi
    ? (mode === "cover" || mode === "mashup" || mode === "playlist" || mode === "sample" ? SUNO_V6_VERSIONS.slice(0, 1) : SUNO_V6_VERSIONS)
    : MUSIC_VERSION_SPECS.filter((item) => allowedVersions.includes(item.value));

  // 切换模式时把版本收敛到该模式支持的集合，避免界面留着一个上游不认的 mv
  useEffect(() => {
    if (!damobi && !allowedVersions.includes(version)) setVersion(allowedVersions[0]!);
  }, [mode, damobi, allowedVersions, version, setVersion]);
  const requestedVersion = damobi ? (isSunoV6Version(v6Version) ? v6Version : SUNO_V6_DEFAULT) : version;
  const effectiveVersion = versionOptions.find(item => item.value === requestedVersion)?.value ?? versionOptions[0]!.value;
  const resultTask = props.activeTask ?? props.tasks[0] ?? null;
  const taskVersion = resultTask?.effectiveParameters?.mv;
  const taskVersionLabel = typeof taskVersion === "string"
    ? ([...SUNO_V6_VERSIONS, ...MUSIC_VERSION_SPECS].find((item) => item.value === taskVersion)?.label ?? taskVersion)
    : undefined;

  const songOptions = useMemo(() => {
    const seen = new Set<string>();
    return props.tasks.filter(task => task.channelId === props.selectedChannelId)
      .flatMap((task) => task.assets
        .filter((asset) => isSunoSong(task, asset))
        .map((asset) => ({
          clipId: asset.remoteClipId!,
          title: asset.title || "未命名歌曲",
          duration: asset.duration,
          thumbUrl: asset.thumbUrl,
          lyrics: asset.lyrics,
        })))
      .filter((song) => {
        if (seen.has(song.clipId)) return false;
        seen.add(song.clipId);
        return true;
      });
  }, [props.tasks, props.selectedChannelId]);
  const canUseSource = (clipId: string) => songOptions.some(song => song.clipId === clipId);
  const coverSource = canUseSource(coverClipId) ? coverClipId : "";
  const mashupSources = mashupClipIds.filter(canUseSource);

  function startFromTrack({ mode: nextMode, task, asset }: SunoSourceSelection) {
    const clipId = asset.remoteClipId;
    if (submitting || !clipId || !isSunoSong(task, asset)) return;
    if (task.channelId !== props.selectedChannelId) {
      const sourceChannel = props.channels.find(item => item.id === task.channelId && item.enabled);
      if (!sourceChannel) return props.onToast("error", "源歌曲的渠道已停用或删除");
      props.onChannelChange(sourceChannel.id);
    }
    setSourceChannelId(task.channelId);
    if (nextMode === "cover") {
      if (coverClipId !== clipId) setCoverPrompt(asset.lyrics?.slice(0, 5000) ?? "");
      setCoverClipId(clipId);
    }
    else setMashupClipIds(current => {
      if (sourceChannelId !== task.channelId) return [clipId];
      if (current.includes(clipId)) return current;
      return current.length === 1 ? [...current, clipId] : [clipId];
    });
    setMode(nextMode);
    requestAnimationFrame(() => sourcePickerRef.current?.scrollIntoView?.({ block: "nearest" }));
  }

  useEffect(() => {
    if (!props.sourceSelection) return;
    startFromTrack(props.sourceSelection);
    props.onSourceSelectionApplied?.();
  }, [props.sourceSelection]);

  function toggleMashupSong(clipId: string) {
    setSourceChannelId(props.selectedChannelId);
    setMashupClipIds((current) => {
      const available = current.filter(canUseSource);
      if (available.includes(clipId)) return available.filter((id) => id !== clipId);
      if (available.length >= 2) return available;
      return [...available, clipId];
    });
  }

  function addSuggestion(value: string, field: "prompt" | "tags") {
    const current = (field === "prompt" ? prompt : tags).trim();
    if (current === value || current.split(/[，,]/).some((part) => part.trim() === value)) return;
    const separator = field === "prompt" ? "，" : ", ";
    const next = current ? current + separator + value : value;
    const limit = field === "prompt" ? promptLimit : 1000;
    if (next.length > limit) return props.onToast("error", "添加后超过 " + limit + " 字");
    if (field === "prompt") setPrompt(next);
    else setTags(next);
  }

  function toggleStyle(style: string) {
    const field = custom ? "tags" : "prompt";
    const current = custom ? tags : prompt;
    const parts = current.split(/([，,])/);
    const index = parts.findIndex((part) => part.trim() === style);
    if (index < 0) return addSuggestion(style, field);
    parts.splice(index ? index - 1 : 0, 2);
    const next = parts.join("").trim();
    if (custom) setTags(next);
    else setPrompt(next);
  }

  async function generate() {
    if (!channel) return props.onToast("error", "请先选择音乐渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    const text = (sound ? soundDescription : activePrompt).trim();
    if (needsPrompt && !text) {
      if (custom) return props.onToast("error", "请输入歌词");
      return props.onToast("error", mode === "cover" ? "请输入翻唱歌词" : "请描述想要的音乐");
    }
    if (mode === "inspiration" && text.length > 500) return props.onToast("error", "灵感描述最多 500 字");
    if (custom && !tags.trim()) return props.onToast("error", "自定义模式需要填写曲风");
    if (mode === "cover" && !coverSource) return props.onToast("error", "请选择当前渠道的一首源歌曲");
    if (mode === "mashup" && mashupSources.length !== 2) return props.onToast("error", "请选择当前渠道的两首不同歌曲");
    if (sound && !text) return props.onToast("error", "请填写音效描述");
    if (sound && soundTempo !== "" && (!Number.isInteger(soundTempo) || soundTempo < 20 || soundTempo > 300)) {
      return props.onToast("error", "BPM 必须是 20 到 300 之间的整数");
    }
    if (damobi && custom && [styleWeight, weirdness].some(value => value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100))) {
      return props.onToast("error", "风格强度和创意偏离度须在 0 到 100 之间");
    }

    let rawParameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      rawParameters = parsed;
    } catch {
      return props.onToast("error", "高级参数必须是 JSON 对象");
    }

    if (!confirmGeneration({ kind: sound ? "音效生成" : "音乐生成", model: props.selectedModel, channel: channel.name, detail: sound ? "通常返回 2 条音效" : "通常返回 2 首" })) return;
    setSubmitting(true);
    try {
      const task = await api.generate({
        channelId: channel.id,
        model: props.selectedModel,
        prompt: text,
        musicMode: mode,
        musicTitle: (sound ? soundTitle : custom || mode === "mashup" ? title : "").trim() || undefined,
        musicTags: (sound ? soundDescription : custom ? tags : "").trim() || undefined,
        musicNegativeTags: (sound ? soundExclusions : custom ? negativeTags : "").trim() || undefined,
        musicInstrumental: mode === "sound" ? true : instrumental,
        musicVersion: effectiveVersion,
        ...(targetDurationAvailable && targetDuration !== "auto" ? { musicTargetDuration: Number(targetDuration) } : {}),
        ...(damobi && custom ? {
          musicStyleWeight: styleWeight === "" ? undefined : Number(styleWeight) / 100,
          musicWeirdness: weirdness === "" ? undefined : Number(weirdness) / 100,
        } : {}),
        ...(mode === "cover" ? { musicCoverClipId: coverSource } : {}),
        ...(mode === "mashup" ? { musicMashupClipIds: mashupSources } : {}),
        ...(sound ? {
          musicSoundConfigs: { tempo: soundTempo === "" ? 99 : soundTempo, key: soundKey, loop: soundLoop },
        } : {}),
        timeoutMs: Math.max(60, timeoutSeconds) * 1000,
        rawParameters,
      });
      props.onTask(task);
      props.onSelectTask(task);
      props.onToast("success", sound ? "音效任务已提交" : "音乐任务已提交");
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  const selectedStyles = (custom ? tags : prompt).split(/[，,]/).map((part) => part.trim());
  const genreCards = (
    <div className="music-genre-grid" role="group" aria-label="音乐风格">
      {MUSIC_STYLES.map((style) => {
        const selected = selectedStyles.includes(style);
        return (
          <button type="button" className="music-genre-card" key={style} disabled={submitting}
            aria-pressed={selected} onClick={() => toggleStyle(style)}>
            {selected ? <span className="music-genre-check"><Check size={10} aria-hidden="true" /></span> : null}
            <span>{style}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="page generate-page music-workbench-page">
      <div className="page-header">
        <h1>音乐生成</h1>
        <div className="header-selects">
          <label><span>渠道</span>
            <ChannelPicker
              className="header-picker header-channel-picker"
              placeholder="选择渠道"
              value={props.selectedChannelId}
              onChange={props.onChannelChange}
              options={props.channels.filter((item) => item.enabled).map((item) => ({
                value: item.id, name: item.name, baseUrl: item.baseUrl,
              }))}
            />
          </label>
          <label><span>模型</span>
            <ModelPicker
              className="header-picker header-model-picker"
              kind="audio"
              menuPlacement="down"
              placeholder="选择模型"
              ariaLabel="音乐模型"
              value={props.selectedModel}
              disabled={!channel}
              onChange={props.onModelChange}
              options={(channel?.models ?? []).map((model) => ({
                value: model, model, channelName: channel?.name ?? "",
              }))}
            />
          </label>
        </div>
      </div>

      {!props.channels.length ? (
        <div className="empty-page">
          <Music size={34} />
          <h2>尚无音乐渠道</h2>
          <p>在渠道配置里添加「词元流墟-音乐」并填写密钥</p>
          <button className="primary-button" onClick={props.onAddChannel}><Plus size={17} />添加渠道</button>
        </div>
      ) : (
        <div className="music-workbench">
          <section className={`control-panel music-composer music-composer--${mode}`} aria-label="音乐创作">
            <div className="music-mode-bar" role="group" aria-label="音乐创作方式">
              {MAIN_MODES.map((spec) => (
                <button
                  key={spec.value}
                  type="button"
                  className="music-choice"
                  aria-pressed={mode === spec.value}
                  onClick={() => setMode(spec.value)}
                  disabled={submitting}
                >{spec.label}</button>
              ))}
              <SelectMenu
                value={mode}
                options={MORE_MODES}
                onChange={(value) => {
                  const spec = MORE_MODES.find((item) => item.value === value);
                  if (spec) setMode(spec.value);
                }}
                placeholder="更多"
                ariaLabel="更多创作方式"
                className={`music-mode-more${MORE_MODES.includes(modeSpec) ? " is-current" : ""}`}
                disabled={submitting}
              />
            </div>
            <div key={mode} className="control-scroll">
              {modeSpec.hint ? <p className="music-mode-hint">{modeSpec.hint}</p> : null}

              {(mode === "cover" || mode === "mashup") ? (
                <div className="field" ref={sourcePickerRef}>
                  <label>
                    源歌曲
                    <span className="field-counter">
                      {mode === "mashup" ? `已选 ${mashupSources.length}/2` : coverSource ? "已选 1 首" : "未选择"}
                    </span>
                  </label>
                  {songOptions.length ? (
                    <div className="song-picker">
                      {songOptions.map((song) => {
                        const selected = mode === "cover" ? coverSource === song.clipId : mashupSources.includes(song.clipId);
                        return (
                          <button
                            type="button"
                            key={song.clipId}
                            aria-pressed={selected}
                            className={`song-option ${selected ? "active" : ""}`}
                            onClick={() => {
                              if (mode !== "cover") return toggleMashupSong(song.clipId);
                              const previousLyrics = songOptions.find(item => item.clipId === coverSource)?.lyrics?.slice(0, promptLimit);
                              if (!coverPrompt.trim() || coverPrompt === previousLyrics) {
                                setCoverPrompt(song.lyrics?.slice(0, promptLimit) ?? "");
                              }
                              setCoverClipId(song.clipId);
                            }}
                            disabled={submitting}
                          >
                            <span className="song-option-cover">
                              {song.thumbUrl ? <img src={api.assetUrl(song.thumbUrl)} alt="" loading="lazy" /> : <Music size={18} />}
                            </span>
                            <span className="song-option-meta">
                              <strong>{song.title}</strong>
                              <small>{song.duration ? formatDuration(song.duration) : "未知时长"}</small>
                            </span>
                            {selected ? <Check size={15} className="song-option-check" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : <p className="field-hint">当前渠道暂无可用源歌曲。请先生成歌曲，或切到歌曲原来的渠道。</p>}
                  {sourceChannelId && sourceChannelId !== props.selectedChannelId ? <p className="field-hint">切换渠道后，请重新确认源歌曲。</p> : null}
                </div>
              ) : null}

              {mode !== "sound" ? (
                <div className={`field music-prompt-field${mode === "inspiration" ? " is-inspiration" : ""}`}>
                  <div className="music-prompt-heading">
                    <label className="music-prompt-label" htmlFor="music-prompt">
                      {custom ? "歌词" : mode === "cover" ? "翻唱歌词（必填）" : mode === "mashup" ? "提示词（可选）" : mode === "playlist" ? "歌单风格 / 歌词" : mode === "sample" ? "取样提示词" : "音乐描述"}
                    </label>
                    {custom ? (
                      <button type="button" className="music-choice music-preview-lyrics" disabled={!prompt.trim()}
                        onClick={() => lyricsPreviewRef.current?.showModal()}><Eye size={13} />预览歌词</button>
                    ) : null}
                  </div>
                  <div className="music-prompt-shell">
                    {mode === "inspiration" ? <Sparkles className="music-prompt-icon" size={16} aria-hidden="true" /> : null}
                    <textarea
                      id="music-prompt"
                      className={`prompt-input music-prompt${custom ? " is-lyrics" : ""}`}
                      rows={custom ? 8 : 5}
                      maxLength={promptLimit}
                      placeholder={custom
                        ? "输入要唱出的歌词\n\n用 [Verse] 和 [Chorus] 标记主歌和副歌"
                        : mode === "cover"
                          ? "粘贴要演唱的歌词，或编辑从原曲带入的歌词"
                          : mode === "mashup"
                            ? "可选：想强调的风格或主题"
                            : mode === "playlist"
                              ? "描述歌单的整体风格，或直接贴歌词"
                              : mode === "sample"
                                ? "描述要取样的段落和想要的新曲风"
                                : "描述你想要的音乐，例如：一首夏日海边的流行歌，轻快、温暖、充满阳光…"}
                      value={activePrompt}
                      onChange={(event) => setActivePrompt(event.target.value)}
                      disabled={submitting}
                    />
                    <span className="music-prompt-count">{activePrompt.length} / {promptLimit}</span>
                  </div>
                  {custom ? (
                    <p className="music-field-help">只有主题？<button type="button" disabled={submitting} onClick={() => setMode("inspiration")}>用灵感创作</button></p>
                  ) : null}
                </div>
              ) : null}

              {mode === "inspiration" ? (
                <div className="music-suggestions">
                  <span>推荐灵感</span>
                  <div className="music-chip-row">
                    {MUSIC_IDEAS.map(({ label, icon: Icon, prompt: idea }) => (
                      <button type="button" className="music-choice" key={label} disabled={submitting}
                        onClick={() => addSuggestion(idea, "prompt")}><Icon size={13} aria-hidden="true" />{label}</button>
                    ))}
                  </div>
                </div>
              ) : null}

              {sound ? (
                <div className="field music-prompt-field">
                  <label className="music-prompt-heading" htmlFor="music-sound-description">音效描述</label>
                  <div className="music-prompt-shell">
                    <textarea id="music-sound-description" className="prompt-input music-prompt" maxLength={1000}
                      placeholder="例如：远处传来雷声，雨点轻敲玻璃，室内安静"
                      value={soundDescription} onChange={(event) => setSoundDescription(event.target.value)} disabled={submitting} />
                    <span className="music-prompt-count">{soundDescription.length} / 1000</span>
                  </div>
                </div>
              ) : null}

              {custom ? (
                <div className="field music-style-field">
                  <label htmlFor="music-tags">曲风<span className="field-counter">{tags.length} / 1000</span></label>
                  <input id="music-tags" className="text-input" maxLength={1000} placeholder="例如：独立民谣，温暖原声"
                    value={tags} onChange={(event) => setTags(event.target.value)} disabled={submitting} />
                  {genreCards}
                </div>
              ) : null}

              {custom || sound || mode === "mashup" ? (
                <div className="field">
                  <label htmlFor="music-title">标题 <small>可选</small></label>
                  <input id="music-title" className="text-input" maxLength={80}
                    placeholder={sound ? "例如：窗边的雨声" : "留空则自动命名"} value={sound ? soundTitle : title}
                    onChange={(event) => (sound ? setSoundTitle : setTitle)(event.target.value)} disabled={submitting} />
                </div>
              ) : null}

              {mode === "inspiration" ? (
                <div className="music-suggestions">
                  <span>音乐风格</span>
                  {genreCards}
                </div>
              ) : null}

              <div className="music-quick-settings">
                {!sound || !damobi ? <label className="field">
                  <span>Suno 版本</span>
                  <SelectMenu
                    value={effectiveVersion}
                    options={versionOptions.map((item) => ({ value: item.value, label: item.label }))}
                    onChange={damobi ? setV6Version : setVersion}
                    disabled={submitting}
                    ariaLabel="Suno 版本"
                    className="param-select"
                    minWidth={142}
                  />
                </label> : <span className="field-hint">Suno 音效模型</span>}
                {targetDurationAvailable ? <label className="field">
                  <span>目标时长</span>
                  <SelectMenu value={targetDuration} options={[{ value: "auto", label: "自动" }, ...SUNO_TARGET_DURATIONS.map(seconds => ({ value: String(seconds), label: seconds + " 秒" }))]}
                    onChange={setTargetDuration} disabled={submitting} ariaLabel="目标时长" className="param-select" minWidth={110} />
                </label> : null}
                {mode === "sound" ? (
                  <label className="switch-field option-switch">
                    <span>循环音效</span>
                    <input type="checkbox" checked={soundLoop} onChange={(event) => setSoundLoop(event.target.checked)} disabled={submitting} />
                  </label>
                ) : mode !== "cover" ? (
                  <label className="switch-field option-switch">
                    <span>纯音乐</span>
                    <input type="checkbox" checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} disabled={submitting} />
                  </label>
                ) : null}
              </div>

              {sound ? (
                <div className="field-row">
                  <label className="field">
                    <span>BPM</span>
                    <input type="number" min={20} max={300} placeholder="99" value={soundTempo}
                      onChange={(event) => setSoundTempo(event.target.value === "" ? "" : Number(event.target.value))}
                      disabled={submitting} />
                  </label>
                  <label className="field">
                    <span>调性</span>
                    <SelectMenu value={soundKey} options={MUSIC_KEYS.map((key) => ({ value: key, label: key }))}
                      onChange={setSoundKey} disabled={submitting} ariaLabel="调性" className="param-select" />
                  </label>
                </div>
              ) : null}

              <details className="advanced-panel music-advanced">
                <summary><ChevronRight size={14} className="music-disclosure" />高级设置</summary>
                {damobi && custom ? <div className="field-row">
                  <label className="field"><span>风格强度（%）</span><input type="number" min={0} max={100} placeholder="默认"
                    value={styleWeight} disabled={submitting} onChange={event => setStyleWeight(event.target.value)} /></label>
                  <label className="field"><span>创意偏离度（%）</span><input type="number" min={0} max={100} placeholder="默认"
                    value={weirdness} disabled={submitting} onChange={event => setWeirdness(event.target.value)} /></label>
                </div> : null}
                {custom || sound ? (
                  <div className="field">
                    <label htmlFor="music-exclusions">{sound ? "排除声音" : "排除风格"} <small>可选</small></label>
                    <input id="music-exclusions" className="text-input" maxLength={1000}
                      placeholder={sound ? "例如：人声，背景音乐" : "例如：重金属，说唱"}
                      value={sound ? soundExclusions : negativeTags}
                      onChange={(event) => (sound ? setSoundExclusions : setNegativeTags)(event.target.value)} disabled={submitting} />
                  </div>
                ) : null}
                <label className="field">
                  <span>提交请求超时（秒）</span>
                  <input
                    type="number" min={60} max={1800} step={30}
                    value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value) || 900)}
                    disabled={submitting}
                  />
                </label>
                <label htmlFor="music-raw-parameters">高级参数（JSON）</label>
                <textarea
                  id="music-raw-parameters"
                  className="prompt-input raw-input" rows={4}
                  value={raw} onChange={(event) => setRaw(event.target.value)} disabled={submitting}
                />
                <p className="field-hint">与表单参数合并，模型版本按当前模式校验。</p>
              </details>
            </div>

            <div className="submit-row">
              {channel && !channel.hasKey ? (
                <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}>
                  <KeyRound size={15} />填写密钥
                </button>
              ) : null}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : <Music size={17} />}
                {submitting ? "提交中" : sound ? "生成音效" : "生成音乐"}
              </button>
              <small>{sound ? "通常返回 2 条音效" : targetDurationAvailable && targetDuration !== "auto" ? `通常返回 2 首 · 目标 ${targetDuration} 秒` : "通常返回 2 首"}</small>
            </div>
          </section>

          <MusicResultWorkspace
            task={resultTask}
            tasks={props.tasks}
            versionLabel={taskVersionLabel}
            onUseTrack={startFromTrack}
            onDiagnostics={props.onDiagnostics}
            onTask={props.onTask}
            onSelectTask={props.onSelectTask}
            onToast={props.onToast}
          />
          {custom && prompt.trim() ? (
            <MusicLyricsDialog dialogRef={lyricsPreviewRef} label="预览歌词" title={title.trim() || "预览歌词"} lyrics={prompt} />
          ) : null}
        </div>
      )}
    </div>
  );
}
