import { useCallback, useMemo, useRef, useState } from "react";
import {
  AudioLines, Clock3, Download, Eye, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, Square, Volume2, VolumeX,
} from "lucide-react";
import type { Asset, Task } from "../../shared/types";
import { splitTtsDialogue } from "../../shared/tts";
import { api } from "../api";
import type { Toast } from "../app-shared";
import { confirmGeneration } from "../generation-confirm";
import { formatDuration, StatusBadge, statusLabels, terminalStatuses } from "../task-ui";

function speechTitle(task: Task) {
  return task.assets[0]?.title?.trim() || task.prompt.trim().split(/\r?\n/, 1)[0]?.replace(/^[AB]\s*[:：]\s*/i, "") || "配音";
}

function dialogueFor(task: Task | null) {
  if (!task?.prompt) return null;
  const config = task.effectiveParameters?.generationConfig;
  const speech = config && typeof config === "object" && "speechConfig" in config ? config.speechConfig : null;
  if (speech && typeof speech === "object" && ("voiceConfig" in speech || "voice_config" in speech)) return null;
  // 早期任务可能没有有效参数，仍可用提交时的 A/B 文本恢复显示。
  try { return splitTtsDialogue(task.prompt); }
  catch { return null; }
}

function clock(seconds: number) {
  return Math.floor(seconds / 60) + ":" + Math.floor(seconds % 60).toString().padStart(2, "0");
}

function SpeechPlayer({ asset, onPlay, onToast }: { asset: Asset; onPlay: (audio: HTMLAudioElement) => void; onToast: ToastHandler }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const total = duration || Math.max(0, asset.duration ?? 0);
  const bindAudio = useCallback((element: HTMLAudioElement | null) => {
    if (!element) return;
    audioRef.current = element;
    return () => {
      if (!element.paused) element.pause();
      audioRef.current = null;
    };
  }, []);
  const PlayIcon = playing ? Pause : Play;
  const VolumeIcon = muted ? VolumeX : Volume2;

  function togglePlayback() {
    const element = audioRef.current;
    if (!element) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    void element.play().catch((error: unknown) => {
      if (audioRef.current !== element || (error instanceof DOMException && error.name === "AbortError")) return;
      onToast("error", "无法播放该音频，请重试或下载后播放");
    });
  }

  return (
    <div className="speech-player">
      <audio ref={bindAudio} src={api.assetUrl(asset.url)} preload="metadata" muted={muted}
        onPlay={(event) => { setPlaying(true); onPlay(event.currentTarget); }}
        onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          setDuration(Number.isFinite(value) ? value : 0);
        }} />
      <button type="button" className="speech-play" aria-label={playing ? "暂停" : "播放"} onClick={togglePlayback}><PlayIcon size={16} /></button>
      <input type="range" min={0} max={total} step="any" value={Math.min(position, total)} disabled={!duration}
        aria-label="播放进度" aria-valuetext={clock(position)} onChange={(event) => {
          const element = audioRef.current;
          if (!element) return;
          element.currentTime = Number(event.target.value);
          setPosition(element.currentTime);
        }} />
      <span className="speech-play-time">{clock(position)} / {total ? clock(total) : "—"}</span>
      <button type="button" className="icon-button" aria-label={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)}>
        <VolumeIcon size={16} />
      </button>
    </div>
  );
}

type ToastHandler = (kind: Toast["kind"], message: string) => void;

export function SpeechResultPanel({ task, tasks, onDiagnostics, onTask, onSelectTask, onToast }: {
  task: Task | null;
  tasks: Task[];
  onDiagnostics: (task: Task) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: ToastHandler;
}) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const busy = task && !terminalStatuses.includes(task.status);
  const failed = task?.status === "failed" || task?.status === "expired";
  const audioAssets = task?.assets.filter((asset) => asset.mimeType.startsWith("audio/")) ?? [];
  const recent = tasks.slice(0, 8);
  const dialogue = useMemo(() => dialogueFor(task), [task?.prompt, task?.effectiveParameters]);

  async function update(action: "cancel" | "retry") {
    if (!task || updating) return;
    if (action === "retry" && !confirmGeneration({ kind: "语音生成", model: task.model, channel: task.channelName, retry: true })) return;
    setUpdating(true);
    try {
      onTask(await (action === "cancel" ? api.cancel(task.id) : api.retry(task.id)));
      if (action === "retry") onToast("success", "已重新提交");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : action === "cancel" ? "取消失败" : "重试失败");
    } finally {
      setUpdating(false);
    }
  }

  async function download(asset: Asset) {
    setDownloadingId(asset.id);
    try {
      if (await api.downloadAsset(asset)) onToast("success", "音频已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="speech-results">
      <section className="speech-card speech-result" aria-label="配音结果">
        <header className="speech-card-header">
          <h2><AudioLines size={17} />配音结果</h2>
          {task ? <div className="speech-result-actions">
            <StatusBadge status={task.status} />
            <button type="button" className="icon-button" title="查看诊断" aria-label="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={16} /></button>
            {busy ? <button type="button" className="icon-button" title="取消任务" aria-label="取消任务" disabled={updating} onClick={() => void update("cancel")}><Square size={15} /></button> : null}
            {failed ? <button type="button" className="icon-button" title="重试" aria-label="重试" disabled={updating} onClick={() => void update("retry")}><RotateCcw size={15} /></button> : null}
          </div> : null}
        </header>
        {busy ? (
          <div className="speech-result-message" role="status">
            <LoaderCircle className="spin" size={17} />
            <div><strong>{statusLabels[task.status]}</strong>
              {task.progress != null ? <progress max={100} value={task.progress} aria-label="配音进度" /> : null}
            </div>
          </div>
        ) : failed ? (
          <div className="speech-result-message" role="status">{task.errorMessage || statusLabels[task.status]}</div>
        ) : !audioAssets.length ? (
          <div className="speech-result-message">
            <span className="speech-audio-icon"><Mic size={20} /></span>
            <div><strong>{task?.status === "cancelled" ? "任务已取消" : task ? "暂无可播放音频" : "等待配音"}</strong>
              {!task ? <small>生成后可在这里试听和下载</small> : null}
            </div>
          </div>
        ) : null}
        {task && audioAssets.map((asset, index) => (
          <article key={asset.id} className="speech-result-track">
            <div className="speech-track-heading">
              <span className="speech-audio-icon"><Mic size={20} /></span>
              <div>
                <strong title={asset.title || speechTitle(task)}>{asset.title || (index === 0 ? speechTitle(task) : "配音 " + (index + 1))}</strong>
                <small>{dialogue ? "双人对话" : "单人配音"} · {asset.mimeType.includes("wav") ? "WAV" : "音频"}</small>
              </div>
              <button type="button" className="secondary-button" disabled={Boolean(downloadingId)} onClick={() => void download(asset)}>
                {downloadingId === asset.id ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                {asset.mimeType.includes("wav") ? "下载 WAV" : "下载音频"}
              </button>
            </div>
            <SpeechPlayer asset={asset} onToast={onToast} onPlay={(element) => {
              if (activeAudio.current !== element) activeAudio.current?.pause();
              activeAudio.current = element;
            }} />
          </article>
        ))}
      </section>

      <section className="speech-card speech-script-card" aria-label="朗读稿">
        <header className="speech-card-header"><h2><FileText size={17} />朗读稿</h2></header>
        <div className="speech-script-preview">
          {dialogue ? dialogue.map((line, index) => (
            <div key={index} className="speech-script-line"><span className="speech-speaker" aria-label={"说话人 " + line.speaker}>{line.speaker}</span><p>{line.text}</p></div>
          )) : task?.prompt ? <p>{task.prompt}</p> : <p className="speech-placeholder">提交后，这里会保留本次朗读的文本。</p>}
        </div>
      </section>

      <section className="speech-card speech-recent" aria-label="最近生成">
        <header className="speech-card-header"><h2><Clock3 size={17} />最近生成</h2></header>
        <div className="speech-history-list">
          {recent.length ? recent.map((item) => {
            const audio = item.assets.find((asset) => asset.mimeType.startsWith("audio/"));
            const title = speechTitle(item);
            return (
              <button key={item.id} type="button" className="speech-history-item" aria-current={item.id === task?.id ? "true" : undefined}
                onClick={() => onSelectTask(item)} title={title}>
                <Mic size={15} /><span>{title}</span>
                <small>{audio?.duration ? formatDuration(audio.duration) : statusLabels[item.status]}</small>
              </button>
            );
          }) : <p className="speech-placeholder">暂无配音记录</p>}
        </div>
      </section>
    </div>
  );
}
