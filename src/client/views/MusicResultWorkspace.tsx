import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Copy, Disc3, Download, Ellipsis, History, LoaderCircle, Maximize2,
  Music, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX,
} from "lucide-react";
import type { Asset, Task } from "../../shared/types";
import { isSunoSong, sunoResultLabel, sunoTrackInfo, type SunoSourceSelection } from "../../shared/suno";
import { api } from "../api";
import type { Toast } from "../app-shared";
import { copyTextToClipboard } from "../clipboard";
import { formatTime, StatusBadge, statusLabels, terminalStatuses } from "../task-ui";
import { MusicLyrics, MusicLyricsDialog } from "./MusicLyrics";

type MusicResultProps = {
  task: Task | null;
  tasks: Task[];
  versionLabel?: string;
  onDiagnostics: (task: Task) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onUseTrack: (selection: SunoSourceSelection) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
};

function clock(seconds: number) {
  return Math.floor(seconds / 60) + ":" + Math.floor(seconds % 60).toString().padStart(2, "0");
}

function MusicCover({ track, large = false }: { track?: Asset; large?: boolean }) {
  return (
    <div className={`music-workbench-cover${large && !track?.thumbUrl ? " is-record" : ""}`}>
      {track?.thumbUrl ? <img src={api.assetUrl(track.thumbUrl)} alt="" /> : large ? (
        <div className="music-record"><Music size={17} aria-hidden="true" /></div>
      ) : <Music aria-hidden="true" />}
    </div>
  );
}

export function MusicResultWorkspace({ task, tasks, versionLabel, onDiagnostics, onTask, onSelectTask, onUseTrack, onToast }: MusicResultProps) {
  const [selectedId, setSelectedId] = useState<string>();
  const [detailsTab, setDetailsTab] = useState<"lyrics" | "details">("lyrics");
  const [downloadId, setDownloadId] = useState<string>();
  const [taskActionId, setTaskActionId] = useState<string>();
  const [volume, setVolume] = useState(1);
  const [position, setPosition] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const historyRef = useRef<HTMLDetailsElement>(null);
  const lyricsDialogRef = useRef<HTMLDialogElement>(null);
  const resumeTrackId = useRef<string | undefined>(undefined);
  const attachAudio = useCallback((audio: HTMLAudioElement | null) => {
    if (!audio) return;
    audioRef.current = audio;
    return () => {
      audioRef.current = null;
      if (!audio.paused) audio.pause();
    };
  }, []);

  const tracks = task?.assets.filter((asset) => asset.mimeType.startsWith("audio/")) ?? [];
  const trackIndex = Math.max(0, tracks.findIndex((asset) => asset.id === selectedId));
  const track = tracks[trackIndex];
  const trackInfo = sunoTrackInfo(task, track?.remoteClipId);
  const sound = trackInfo?.model === "chirp-sfx" || task?.effectiveParameters?.task === "sound";
  const actualLabel = sunoResultLabel(trackInfo);
  const resultLabel = actualLabel ?? (sound ? "Suno 音效" : versionLabel ? "请求版本 " + versionLabel : task?.model);
  const trackId = track?.id;
  const title = track ? track.title || "歌曲 " + (trackIndex + 1) : "";
  const duration = mediaDuration || track?.duration || 0;
  const busy = Boolean(task && !terminalStatuses.includes(task.status));
  const timedOut = task?.errorCode === "VIDEO_TIMEOUT";
  const failed = task?.status === "failed" || task?.status === "expired";
  let emptyTitle = "等待生成";
  if (task) {
    if (busy) emptyTitle = statusLabels[task.status];
    else if (timedOut) emptyTitle = "查询已暂停";
    else if (task.status === "succeeded") emptyTitle = "本次没有可播放的歌曲";
    else emptyTitle = statusLabels[task.status];
  }
  const recent = tasks.slice(0, 8);

  function play(audio: HTMLAudioElement) {
    setPlaybackError("");
    void audio.play().catch((error: unknown) => {
      if (audioRef.current !== audio || (error instanceof DOMException && error.name === "AbortError")) return;
      setPlaybackError("无法播放这首歌，请重试或下载后播放");
    });
  }

  useLayoutEffect(() => {
    setPosition(0);
    setMediaDuration(0);
    setPlaying(false);
    setPlaybackError("");
    setDetailsTab("lyrics");
    const audio = audioRef.current;
    if (audio && trackId && resumeTrackId.current === trackId) play(audio);
    resumeTrackId.current = undefined;
  }, [trackId]);

  useLayoutEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [trackId, volume]);

  function selectTrack(next: Asset) {
    if (next.id === trackId) return;
    resumeTrackId.current = audioRef.current && !audioRef.current.paused ? next.id : undefined;
    setSelectedId(next.id);
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) play(audio);
    else audio.pause();
  }

  async function download(asset: Asset) {
    setDownloadId(asset.id);
    try {
      if (await api.downloadAsset(asset)) onToast("success", "音乐已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadId(undefined);
    }
  }

  async function copyLyrics(lyrics: string) {
    try {
      await copyTextToClipboard(lyrics);
      onToast("success", "歌词已复制");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "复制歌词失败");
    }
  }

  async function updateTask(current: Task, action: "cancel" | "continue") {
    setTaskActionId(current.id);
    try {
      const updated = await (action === "cancel" ? api.cancel(current.id) : api.continueTaskQuery(current.id));
      onTask(updated);
      if (action === "continue") onToast("success", "已继续查询原任务");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : action === "cancel" ? "取消失败" : "继续查询失败");
    } finally {
      setTaskActionId(undefined);
    }
  }

  const playLabel = playing ? "暂停" : "播放";
  const PlayIcon = playing ? Pause : Play;

  return (
    <>
      <section className="result-panel music-result-workbench" aria-label="音乐生成结果">
        <header className="music-result-header">
          <h2><Disc3 size={16} />生成结果 {tracks.length ? <small>{tracks.length} 首</small> : null}</h2>
          {track && tracks.length > 1 ? (
            <div className="music-track-switch" role="group" aria-label="本次生成的歌曲">
              {tracks.map((item, index) => (
                <button type="button" className="music-choice" key={item.id} title={item.title || undefined}
                  aria-pressed={track.id === item.id} onClick={() => selectTrack(item)}>
                  {item.title || "歌曲 " + (index + 1)}
                </button>
              ))}
            </div>
          ) : null}
          {task && (!track || task.status !== "succeeded") ? <StatusBadge status={task.status} /> : null}
          <div className="music-result-actions">
            {recent.length ? (
              <details ref={historyRef} className="music-menu">
                <summary className="music-choice"><History size={14} />最近生成</summary>
                <div className="music-menu-content music-history-list" aria-label="最近音乐任务">
                  {recent.map((item) => {
                    const firstTrack = item.assets.find((asset) => asset.mimeType.startsWith("audio/"));
                    return (
                      <button key={item.id} type="button" aria-current={item.id === task?.id ? "true" : undefined}
                        title={item.prompt} onClick={() => {
                          if (historyRef.current) historyRef.current.open = false;
                          if (item.id === task?.id) return;
                          setSelectedId(undefined);
                          onSelectTask(item);
                        }}>
                        <MusicCover track={firstTrack} />
                        <span>
                          <strong>{firstTrack?.title || item.prompt || "音乐任务"}</strong>
                          <small>{statusLabels[item.status]} · {formatTime(item.createdAt)}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </details>
            ) : null}
            {task ? (
              <details className="music-menu">
                <summary className="icon-button" aria-label="更多操作"><Ellipsis size={17} /></summary>
                <div className="music-menu-content">
                  {track && isSunoSong(task, track) ? (["cover", "mashup"] as const).map(mode => (
                    <button key={mode} type="button" onClick={event => {
                      event.currentTarget.closest("details")?.removeAttribute("open");
                      onUseTrack({ mode, task, asset: track });
                    }}>{mode === "cover" ? "翻唱" : "混音"}</button>
                  )) : null}
                  <button type="button" onClick={(event) => {
                    event.currentTarget.closest("details")?.removeAttribute("open");
                    onDiagnostics(task);
                  }}>查看诊断</button>
                  {busy ? (
                    <button type="button" disabled={Boolean(taskActionId)}
                      onClick={() => void updateTask(task, "cancel")}>取消任务</button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </header>

        <div className="music-result-content">
          <div className="music-track-hero">
            <MusicCover track={track} large />
            <div className="music-track-info">
              <div className="music-track-title">
                <h3>{track ? title : emptyTitle}</h3>
                <button type="button" className="icon-button music-download" aria-label="下载歌曲" title="下载歌曲"
                  disabled={!track || Boolean(downloadId)} onClick={() => { if (track) void download(track); }}>
                  {downloadId && downloadId === track?.id ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
                </button>
              </div>
              {track ? <div className="music-track-meta">
                <span>{resultLabel}</span>
                {duration > 0 ? <span>{clock(duration)}</span> : null}
              </div> : !task ? <p className="music-track-meta">生成完成后可在这里试听。</p> : null}
              {track?.tags ? <p className="music-track-tags" title={track.tags}>{track.tags}</p> : null}
              <div className="music-inline-player" role="group" aria-label="歌曲试听">
                <button type="button" className="music-play-button" aria-label={playLabel} title={playLabel}
                  disabled={!track} onClick={togglePlay}><PlayIcon size={16} /></button>
                <input type="range" min={0} max={duration} step="any" value={Math.min(position, duration)}
                  disabled={!mediaDuration} aria-label="播放进度" aria-valuetext={clock(position)}
                  onChange={(event) => {
                    const audio = audioRef.current;
                    if (!audio || !mediaDuration) return;
                    audio.currentTime = Number(event.target.value);
                    setPosition(audio.currentTime);
                  }} />
                <span className="music-play-time">{track ? clock(position) : "—"} / {duration ? clock(duration) : "—"}</span>
              </div>
              {busy && task ? (
                <div className="music-task-note" role="status">
                  <LoaderCircle className="spin" size={14} />
                  {task.progress != null ? <progress value={task.progress} max={100} aria-label="生成进度" /> : <span>{statusLabels[task.status]}</span>}
                </div>
              ) : null}
              {failed && task ? (
                <div className="music-task-note is-error" role="status">
                  {task.errorMessage ? <span>{task.errorMessage}</span> : null}
                  {timedOut ? <button type="button" className="secondary-button" disabled={Boolean(taskActionId)}
                    onClick={() => void updateTask(task, "continue")}>继续查询</button> : null}
                </div>
              ) : null}
              {playbackError ? <p className="music-play-error" role="status">{playbackError}</p> : null}
              {task?.remoteMeta?.suno?.warning ? <p className="music-task-note" role="status">{task.remoteMeta.suno.warning}</p> : null}
            </div>
          </div>
          <div className="music-track-details">
            <div className="music-details-bar">
              <div role="group" aria-label="歌曲信息">
                <button type="button" className="music-choice" aria-pressed={detailsTab === "lyrics"}
                  onClick={() => setDetailsTab("lyrics")}>歌词</button>
                <button type="button" className="music-choice" aria-pressed={detailsTab === "details"}
                  onClick={() => setDetailsTab("details")}>详情</button>
              </div>
              {detailsTab === "lyrics" && track?.lyrics ? (
                <div className="music-lyric-actions">
                  <button type="button" className="icon-button" aria-label="复制歌词" title="复制歌词"
                    onClick={() => void copyLyrics(track.lyrics!)}><Copy size={16} /></button>
                  <button type="button" className="icon-button" aria-label="展开歌词" title="展开歌词"
                    onClick={() => lyricsDialogRef.current?.showModal()}><Maximize2 size={15} /></button>
                </div>
              ) : null}
            </div>
            {!track || !task ? (
              <p className="music-no-lyrics is-placeholder">
                {detailsTab === "lyrics" ? "生成歌曲后在这里查看歌词" : "生成歌曲后在这里查看详情"}
              </p>
            ) : detailsTab === "lyrics" ? (
              track.lyrics ? <MusicLyrics key={track.id} lyrics={track.lyrics} />
                : <p className="music-no-lyrics">这首歌没有可显示的歌词</p>
            ) : (
              <dl className="music-track-facts">
                <dt>渠道</dt><dd>{task.channelName}</dd>
                <dt>模型</dt><dd>{task.model}</dd>
                {actualLabel ? <><dt>实际模型</dt><dd>{actualLabel}</dd></> : null}
                {versionLabel ? <><dt>请求版本</dt><dd>{versionLabel}</dd></> : null}
                {typeof task.effectiveParameters?.duration === "number" ? <><dt>目标时长</dt><dd>{task.effectiveParameters.duration} 秒</dd></> : null}
                {trackInfo?.sound ? <><dt>音效参数</dt><dd>{[
                  trackInfo.sound.tempo !== undefined ? trackInfo.sound.tempo + " BPM" : undefined,
                  trackInfo.sound.key,
                  trackInfo.sound.loop === undefined ? undefined : trackInfo.sound.loop ? "循环开启" : "循环关闭",
                ].filter(Boolean).join(" · ")}</dd></> : null}
                {trackInfo?.controls?.styleWeight !== undefined ? <><dt>风格强度</dt><dd>{Math.round(trackInfo.controls.styleWeight * 100)}%</dd></> : null}
                {trackInfo?.controls?.weirdness !== undefined ? <><dt>创意偏离度</dt><dd>{Math.round(trackInfo.controls.weirdness * 100)}%</dd></> : null}
                {track.tags ? <><dt>曲风</dt><dd>{track.tags}</dd></> : null}
                <dt>生成时间</dt><dd>{formatTime(task.createdAt)}</dd>
                {task.prompt ? <><dt>提示词</dt><dd>{task.prompt}</dd></> : null}
              </dl>
            )}
          </div>
          {track?.lyrics ? (
            <MusicLyricsDialog key={"lyrics-" + track.id} dialogRef={lyricsDialogRef} label="展开歌词" title={title} lyrics={track.lyrics} />
          ) : null}
          {track ? <audio key={track.id} ref={attachAudio} preload="metadata" src={api.assetUrl(track.url)}
            onDurationChange={(event) => {
              const value = event.currentTarget.duration;
              setMediaDuration(Number.isFinite(value) ? value : 0);
            }}
            onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => { setPlaying(false); setPlaybackError("音频加载失败，请重试或下载后播放"); }} /> : null}
        </div>
      </section>

      <footer className="music-player-dock" aria-label="音乐播放控制">
        <div className="music-dock-track">
          <MusicCover track={track} />
          <div><strong>{track ? title : "暂无歌曲"}</strong>{track ? <small>{resultLabel}</small> : null}</div>
        </div>
        <div className="music-dock-controls">
          <button type="button" className="icon-button" title="上一首" aria-label="上一首" disabled={trackIndex === 0}
            onClick={() => selectTrack(tracks[trackIndex - 1]!)}><SkipBack size={17} /></button>
          <button type="button" className="music-play-button" title={playLabel} aria-label={playLabel} disabled={!track}
            onClick={togglePlay}><PlayIcon size={17} /></button>
          <button type="button" className="icon-button" title="下一首" aria-label="下一首" disabled={trackIndex >= tracks.length - 1}
            onClick={() => selectTrack(tracks[trackIndex + 1]!)}><SkipForward size={17} /></button>
        </div>
        <div className="music-dock-end">
        <span className="music-play-time">{track ? clock(position) : "—"} / {duration ? clock(duration) : "—"}</span>
        <label className="music-dock-volume">
          {volume ? <Volume2 size={16} /> : <VolumeX size={16} />}
          <input type="range" min={0} max={1} step={0.01} value={volume} aria-label="音量"
            disabled={!track} aria-valuetext={Math.round(volume * 100) + "%"}
            onChange={(event) => setVolume(Number(event.target.value))} />
        </label>
        </div>
      </footer>
    </>
  );
}
