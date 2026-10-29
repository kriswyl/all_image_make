import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, Check, Download, Eye, KeyRound, LoaderCircle, Music, Music2, Plus,
  SlidersHorizontal, Square, Disc3,
} from "lucide-react";
import { api } from "./api";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import {
  StatusBadge, formatDuration, formatTime, statusLabels, terminalStatuses, usePersistentState,
} from "./task-ui";
import type { Asset, Channel, MusicMode, Task } from "../shared/types";

type Toast = { kind: "success" | "error"; message: string };

const MUSIC_MODE_SPECS: Array<{ value: MusicMode; label: string; hint: string }> = [
  { value: "inspiration", label: "灵感描述", hint: "用一句话描述风格、情绪和场景，系统自动写歌" },
  { value: "custom", label: "自定义歌词", hint: "自己写歌词和曲风；标题可留空，系统会起名" },
  { value: "cover", label: "翻唱", hint: "选一首历史歌曲，用提示词决定新的唱法或风格" },
  { value: "mashup", label: "混音", hint: "选两首不同的历史歌曲，混合成一首新作品" },
  { value: "sound", label: "音效", hint: "用标题和标签描述音效，可设置 BPM、调性与循环" },
  { value: "playlist", label: "歌单风格", hint: "按某个歌单的整体风格生成新曲" },
  { value: "sample", label: "取样", hint: "基于取样提示词生成" },
];

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
  const [title, setTitle] = usePersistentState("title", "", MUSIC_DRAFT_PREFIX);
  const [tags, setTags] = usePersistentState("tags", "", MUSIC_DRAFT_PREFIX);
  const [negativeTags, setNegativeTags] = usePersistentState("negativeTags", "", MUSIC_DRAFT_PREFIX);
  const [instrumental, setInstrumental] = usePersistentState("instrumental", false, MUSIC_DRAFT_PREFIX);
  const [version, setVersion] = usePersistentState("version", "chirp-v3-5", MUSIC_DRAFT_PREFIX);
  const [timeoutSeconds, setTimeoutSeconds] = usePersistentState("timeoutSeconds", 900, MUSIC_DRAFT_PREFIX);
  const [raw, setRaw] = usePersistentState("raw", "{}", MUSIC_DRAFT_PREFIX);
  const [coverClipId, setCoverClipId] = usePersistentState("coverClipId", "", MUSIC_DRAFT_PREFIX);
  const [mashupClipIds, setMashupClipIds] = usePersistentState<string[]>("mashupClipIds", [], MUSIC_DRAFT_PREFIX);
  const [soundTempo, setSoundTempo] = usePersistentState("soundTempo", 99, MUSIC_DRAFT_PREFIX);
  const [soundKey, setSoundKey] = usePersistentState("soundKey", "C", MUSIC_DRAFT_PREFIX);
  const [soundLoop, setSoundLoop] = usePersistentState("soundLoop", false, MUSIC_DRAFT_PREFIX);
  const [submitting, setSubmitting] = useState(false);

  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const modeSpec = MUSIC_MODE_SPECS.find((item) => item.value === mode) ?? MUSIC_MODE_SPECS[0]!;
  const custom = mode === "custom";
  const needsPrompt = mode !== "sound" && mode !== "mashup";
  const allowedVersions = MUSIC_VERSION_VALUES[mode];
  const versionOptions = MUSIC_VERSION_SPECS.filter((item) => allowedVersions.includes(item.value));

  // 切换模式时把版本收敛到该模式支持的集合，避免界面留着一个上游不认的 mv
  useEffect(() => {
    if (!allowedVersions.includes(version)) setVersion(allowedVersions[0]!);
  }, [mode]);
  const effectiveVersion = allowedVersions.includes(version) ? version : allowedVersions[0]!;

  const songOptions = useMemo(() => {
    const seen = new Set<string>();
    return props.tasks
      .flatMap((task) => task.assets
        .filter((asset) => asset.mimeType.startsWith("audio/") && asset.remoteClipId)
        .map((asset) => ({
          clipId: asset.remoteClipId!,
          title: asset.title || "未命名歌曲",
          duration: asset.duration,
          thumbUrl: asset.thumbUrl,
          taskId: task.id,
        })))
      .filter((song) => {
        if (seen.has(song.clipId)) return false;
        seen.add(song.clipId);
        return true;
      });
  }, [props.tasks]);

  function toggleMashupSong(clipId: string) {
    setMashupClipIds((current) => {
      if (current.includes(clipId)) return current.filter((id) => id !== clipId);
      if (current.length >= 2) return current;
      return [...current, clipId];
    });
  }

  async function generate() {
    if (!channel) return props.onToast("error", "请先选择音乐渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    const text = prompt.trim();
    if (needsPrompt && !text) {
      return props.onToast("error", mode === "custom" ? "请输入歌词" : "请描述想要的音乐");
    }
    if (mode === "inspiration" && text.length > 500) return props.onToast("error", "灵感描述最多 500 字");
    if (custom && !tags.trim()) return props.onToast("error", "自定义模式需要填写曲风");
    if (mode === "cover" && !coverClipId) return props.onToast("error", "请选择一首要翻唱的歌曲");
    if (mode === "mashup" && mashupClipIds.length !== 2) return props.onToast("error", "混音需要选择两首不同的歌曲");
    if (mode === "sound" && !tags.trim()) return props.onToast("error", "请填写音效描述（标签）");

    let rawParameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      rawParameters = parsed;
    } catch {
      return props.onToast("error", "高级参数必须是 JSON 对象");
    }

    if (!confirmGeneration({ kind: "音乐生成", model: props.selectedModel, channel: channel.name, detail: "一次生成两首" })) return;
    setSubmitting(true);
    try {
      const task = await api.generate({
        channelId: channel.id,
        model: props.selectedModel,
        prompt: text,
        musicMode: mode,
        musicTitle: ["custom", "mashup", "sound"].includes(mode) ? title.trim() || undefined : undefined,
        musicTags: ["custom", "sound"].includes(mode) ? tags.trim() || undefined : undefined,
        musicNegativeTags: ["custom", "sound"].includes(mode) ? negativeTags.trim() || undefined : undefined,
        musicInstrumental: mode === "sound" ? true : instrumental,
        musicVersion: effectiveVersion,
        ...(mode === "cover" ? { musicCoverClipId: coverClipId } : {}),
        ...(mode === "mashup" ? { musicMashupClipIds: mashupClipIds } : {}),
        ...(mode === "sound" ? {
          musicSoundConfigs: { tempo: soundTempo, key: soundKey, loop: soundLoop },
        } : {}),
        timeoutMs: Math.max(60, timeoutSeconds) * 1000,
        rawParameters,
      });
      props.onTask(task);
      props.onToast("success", "音乐任务已提交，一次会生成 2 首");
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page generate-page">
      <div className="page-header">
        <div>
          <h1>音乐生成</h1>
          <span className="page-kicker">{custom ? "CUSTOM MUSIC" : instrumental ? "INSTRUMENTAL" : "MUSIC GENERATION"}</span>
        </div>
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
        <div className="generation-grid">
          <section className="control-panel">
            <div className="control-scroll">
              <div className="section-title"><div><Music2 size={17} /><h2>创作方式</h2></div></div>
              <div className="mode-picker" role="radiogroup" aria-label="音乐创作方式">
                {MUSIC_MODE_SPECS.map((spec) => (
                  <button
                    key={spec.value}
                    type="button" role="radio" aria-checked={mode === spec.value}
                    className={`mode-chip ${mode === spec.value ? "active" : ""}`}
                    onClick={() => setMode(spec.value)}
                  >{spec.label}</button>
                ))}
              </div>
              <p className="mode-hint">{modeSpec.hint}</p>

              {(mode === "cover" || mode === "mashup") ? (
                <div className="field">
                  <label>
                    源歌曲
                    <span className="field-counter">
                      {mode === "mashup" ? `已选 ${mashupClipIds.length}/2` : coverClipId ? "已选 1 首" : "未选择"}
                    </span>
                  </label>
                  {songOptions.length ? (
                    <div className="song-picker">
                      {songOptions.map((song) => {
                        const selected = mode === "cover" ? coverClipId === song.clipId : mashupClipIds.includes(song.clipId);
                        return (
                          <button
                            type="button"
                            key={song.clipId}
                            className={`song-option ${selected ? "active" : ""}`}
                            onClick={() => mode === "cover" ? setCoverClipId(song.clipId) : toggleMashupSong(song.clipId)}
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
                  ) : (
                    <p className="field-hint">还没有带 Suno 歌曲 ID 的历史歌曲。先用灵感模式生成一首。</p>
                  )}
                  <p className="field-hint">翻唱/混音只支持本账号生成过的 Suno 歌曲；当前中转站没有上传本地音频的接口。</p>
                </div>
              ) : null}

              {mode !== "sound" ? (
                <div className="field">
                  <label>
                    {custom ? "歌词" : mode === "cover" ? "翻唱提示词" : mode === "mashup" ? "提示词（可选）" : mode === "playlist" ? "歌单风格 / 歌词" : mode === "sample" ? "取样提示词" : "描述"}
                    <span className="field-counter">{prompt.length}/{mode === "inspiration" ? 500 : 5000}</span>
                  </label>
                  <textarea
                    className="prompt-input"
                    rows={custom ? 8 : 5}
                    maxLength={mode === "inspiration" ? 500 : 5000}
                    placeholder={custom
                      ? "写下歌词；可以用 [Verse] [Chorus] 标记段落"
                      : mode === "cover"
                        ? "想改成什么风格/唱法；留空也可以"
                        : mode === "mashup"
                          ? "可选：想强调的风格或主题"
                          : mode === "playlist"
                            ? "描述歌单的整体风格，或直接贴歌词"
                            : mode === "sample"
                              ? "描述要取样的段落和想要的新曲风"
                              : "例如：轻快的民谣，关于雨后的城市，温暖的人声"}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    disabled={submitting}
                  />
                </div>
              ) : null}

              {["custom", "sound"].includes(mode) ? (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>标题<span className="field-counter">{title.length}/80</span></label>
                      <input
                        className="text-input" maxLength={80} placeholder={mode === "sound" ? "例如：Rain" : "留空则自动命名"}
                        value={title} onChange={(event) => setTitle(event.target.value)} disabled={submitting}
                      />
                    </div>
                    <div className="field">
                      <label>{mode === "sound" ? "音效描述 / 标签" : "曲风"}<span className="field-counter">{tags.length}/1000</span></label>
                      <input
                        className="text-input" maxLength={1000} placeholder={mode === "sound" ? "例如：rain, thunder" : "例如：独立民谣, 温暖原声"}
                        value={tags} onChange={(event) => setTags(event.target.value)} disabled={submitting}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>排除风格（可选）</label>
                    <input
                      className="text-input" maxLength={1000} placeholder="例如：重金属, 说唱"
                      value={negativeTags} onChange={(event) => setNegativeTags(event.target.value)} disabled={submitting}
                    />
                  </div>
                </>
              ) : mode === "mashup" ? (
                <div className="field">
                  <label>标题<span className="field-counter">{title.length}/80</span></label>
                  <input
                    className="text-input" maxLength={80} placeholder="留空则自动命名"
                    value={title} onChange={(event) => setTitle(event.target.value)} disabled={submitting}
                  />
                </div>
              ) : null}

              {mode === "sound" ? (
                <div className="field-row">
                  <label className="field">
                    <span>BPM</span>
                    <input
                      type="number" min={20} max={300} value={soundTempo}
                      onChange={(event) => setSoundTempo(Math.max(20, Math.min(300, Number(event.target.value) || 99)))}
                      disabled={submitting}
                    />
                  </label>
                  <label className="field">
                    <span>调性</span>
                    <select value={soundKey} onChange={(event) => setSoundKey(event.target.value)} disabled={submitting}>
                      {MUSIC_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </label>
                </div>
              ) : null}

              <div className="section-title"><div><SlidersHorizontal size={17} /><h2>参数</h2></div></div>
              <div className="field-row">
                <label className="field">
                  <span>模型版本</span>
                  <select value={effectiveVersion} onChange={(event) => setVersion(event.target.value)} disabled={submitting}>
                    {versionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>等待上限（秒）</span>
                  <input
                    type="number" min={60} max={1800} step={30}
                    value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value) || 900)}
                    disabled={submitting}
                  />
                </label>
              </div>
              {mode === "sound" ? (
                <>
                  <label className="switch-field option-switch">
                    <span>循环音效<small>让音效首尾衔接，可反复播放</small></span>
                    <input type="checkbox" checked={soundLoop} onChange={(event) => setSoundLoop(event.target.checked)} disabled={submitting} />
                  </label>
                  <p className="field-hint">音效模式固定为纯音乐，不需要人声。</p>
                </>
              ) : mode !== "cover" ? (
                <label className="switch-field option-switch">
                  <span>纯音乐<small>无人声，只生成伴奏</small></span>
                  <input type="checkbox" checked={instrumental} onChange={(event) => setInstrumental(event.target.checked)} disabled={submitting} />
                </label>
              ) : null}

              <details className="advanced-panel">
                <summary>高级参数（JSON）</summary>
                <textarea
                  className="prompt-input raw-input" rows={4}
                  value={raw} onChange={(event) => setRaw(event.target.value)} disabled={submitting}
                />
                <p className="field-hint">会与基础参数合并，同名时以这里为准。</p>
              </details>
            </div>

            <div className="submit-row">
              {channel && !channel.hasKey ? (
                <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}>
                  <KeyRound size={15} />填写密钥
                </button>
              ) : <span />}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : <Music size={17} />}
                {submitting ? "提交中" : "生成音乐"}
              </button>
            </div>
          </section>

          <MusicResultPanel
            task={props.activeTask}
            tasks={props.tasks}
            onDiagnostics={props.onDiagnostics}
            onTask={props.onTask}
            onSelectTask={props.onSelectTask}
            onToast={props.onToast}
          />
        </div>
      )}
    </div>
  );
}

function MusicResultPanel({ task, tasks, onDiagnostics, onTask, onSelectTask, onToast }: {
  task: Task | null;
  tasks: Task[];
  onDiagnostics: (task: Task) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const busy = task && !terminalStatuses.includes(task.status);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const recent = tasks.filter((item) => item.status === "succeeded" && item.assets.length).slice(0, 8);

  async function cancel() {
    if (!task) return;
    try { onTask(await api.cancel(task.id)); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "取消失败"); }
  }

  async function retry() {
    if (!task) return;
    if (!confirmGeneration({ kind: "音乐生成", model: task.model, channel: task.channelName, detail: "一次生成两首", retry: true })) return;
    try { onTask(await api.retry(task.id)); onToast("success", "已重新提交"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
  }

  async function download(asset: Asset) {
    setDownloadingId(asset.id);
    try {
      if (await api.downloadAsset(asset)) onToast("success", "音乐已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="result-panel music-result-panel">
      <div className="result-toolbar">
        <div><Disc3 size={17} /><h2>结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
        </div>
      </div>

      <div className={`result-stage music-stage ${task?.assets.length ? "has-tracks" : ""}`}>
        {!task ? <MusicEmpty /> : null}
        {busy ? (
          <div className="task-progress">
            <LoaderCircle className="spin" size={30} />
            <strong>{statusLabels[task.status]}</strong>
            {task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}
            <span>{task.model}</span>
            <small>音乐生成通常需要 1 到 5 分钟，一次会返回 2 首</small>
          </div>
        ) : null}
        {task && task.status === "failed" ? (
          <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode}</strong><span>{task.errorMessage}</span></div>
        ) : null}
        {task && !busy && task.status !== "failed" && !task.assets.length ? <MusicEmpty /> : null}
        {task && task.assets.length ? (
          <div className="music-stage-head">
            <span>共 {task.assets.length} 首</span>
            <span>{task.model}</span>
          </div>
        ) : null}
        {task && task.assets.length ? (
          <div className="music-track-list">
            {task.assets.map((asset, index) => (
              <article className="music-track" key={asset.id}>
                <div className="music-cover">
                  {asset.thumbUrl
                    ? <img src={api.assetUrl(asset.thumbUrl)} alt="" loading="lazy" />
                    : <Music size={28} />}
                </div>
                <div className="music-track-main">
                  <div className="music-track-head">
                    <strong>{asset.title || `歌曲 ${index + 1}`}</strong>
                    {asset.duration ? <span>{formatDuration(asset.duration)}</span> : null}
                  </div>
                  {asset.tags ? <div className="music-tags" title={asset.tags}>{asset.tags}</div> : null}
                  <audio controls controlsList="nodownload" preload="metadata" src={api.assetUrl(asset.url)} onContextMenu={(event) => event.preventDefault()} />
                  {asset.lyrics ? (
                    <details className="music-lyrics">
                      <summary>歌词</summary>
                      <pre>{asset.lyrics}</pre>
                    </details>
                  ) : null}
                </div>
                <button className="icon-button" title="下载" onClick={() => void download(asset)} disabled={downloadingId === asset.id}>
                  {downloadingId === asset.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </div>

      {recent.length ? (
        <div className="recent-strip">
          <div className="recent-strip-head"><span>最近</span>
            <span className="muted">{recent.length} 条</span>
          </div>
          <div className="recent-thumbs">
            {recent.map((item) => (
              <button
                key={item.id}
                className={`recent-thumb ${task?.id === item.id ? "active" : ""}`}
                title={item.prompt}
                onClick={() => onSelectTask(item)}
              >
                {item.assets[0]?.thumbUrl
                  ? <img src={api.assetUrl(item.assets[0].thumbUrl)} alt="" loading="lazy" />
                  : <Music size={17} />}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MusicEmpty() {
  return (
    <div className="empty-result">
      <Disc3 size={30} />
      <strong>还没有音乐</strong>
      <span>描述一段情绪，或者贴一段歌词</span>
    </div>
  );
}
