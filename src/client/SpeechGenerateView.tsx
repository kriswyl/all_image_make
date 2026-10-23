import { useState } from "react";
import {
  AlertCircle, AudioLines, Download, Eye, KeyRound, LoaderCircle, Mic, Plus, RotateCcw, Square,
} from "lucide-react";
import { api } from "./api";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import {
  StatusBadge, formatDuration, statusLabels, terminalStatuses, usePersistentState,
} from "./task-ui";
import type { Asset, Channel, Task } from "../shared/types";
import { TTS_DEFAULT_VOICE, TTS_LANGUAGES, TTS_STYLE_PRESETS, TTS_VOICES } from "../shared/tts";

type Toast = { kind: "success" | "error"; message: string };
type SpeechMode = "single" | "duo";

const DRAFT_PREFIX = "vector-image:speech-draft:";

export function SpeechGenerateView(props: {
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
  const [mode, setMode] = usePersistentState<SpeechMode>("mode", "single", DRAFT_PREFIX);
  const [text, setText] = usePersistentState("text", "", DRAFT_PREFIX);
  const [voice, setVoice] = usePersistentState<string>("voice", TTS_DEFAULT_VOICE, DRAFT_PREFIX);
  const [secondVoice, setSecondVoice] = usePersistentState<string>("secondVoice", "Puck", DRAFT_PREFIX);
  const [style, setStyle] = usePersistentState("style", "自然、像聊天", DRAFT_PREFIX);
  const [language, setLanguage] = usePersistentState("language", "zh-CN", DRAFT_PREFIX);
  const [timeoutSeconds, setTimeoutSeconds] = usePersistentState("timeoutSeconds", 300, DRAFT_PREFIX);
  const [submitting, setSubmitting] = useState(false);

  const channel = props.channels.find((item) => item.id === props.selectedChannelId);

  async function generate() {
    if (!channel) return props.onToast("error", "请先选择语音渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择 TTS 模型");
    const content = text.trim();
    if (!content) return props.onToast("error", "请输入要朗读的文本");
    if (style.trim().length > 200) return props.onToast("error", "风格描述最多 200 字");
    if (mode === "duo" && !secondVoice) return props.onToast("error", "双人对话需要选择第二个音色");
    if (mode === "duo" && !(/A\s*[：:]/.test(content) && /B\s*[：:]/.test(content))) {
      return props.onToast("error", "双人对话正文需要用「A：」「B：」标出两段台词");
    }

    setSubmitting(true);
    try {
      const task = await api.generate({
        channelId: channel.id,
        model: props.selectedModel,
        prompt: content,
        ttsVoice: voice,
        ttsStyle: style.trim() || undefined,
        ttsLanguage: language || undefined,
        ...(mode === "duo" ? {
          ttsSpeakers: [
            { speaker: "A", voice },
            { speaker: "B", voice: secondVoice },
          ],
        } : {}),
        timeoutMs: Math.max(300, timeoutSeconds) * 1000,
      });
      props.onTask(task);
      props.onToast("success", "配音任务已提交");
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
          <h1>语音生成</h1>
          <span className="page-kicker">GEMINI TTS · {mode === "duo" ? "DIALOGUE" : "VOICE OVER"}</span>
        </div>
        <div className="header-selects">
          <label><span>渠道</span>
            <ChannelPicker
              className="header-picker header-channel-picker"
              placeholder="选择语音渠道"
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
              ariaLabel="TTS 模型"
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
          <AudioLines size={34} />
          <h2>尚无语音渠道</h2>
          <p>在模型设置里添加「词元流墟-语音」并填写密钥</p>
          <button className="primary-button" onClick={props.onAddChannel}><Plus size={17} />添加渠道</button>
        </div>
      ) : (
        <div className="generation-grid">
          <section className="control-panel">
            <div className="control-scroll">
              <div className="section-title"><div><Mic size={17} /><h2>生成方式</h2></div></div>
              <div className="mode-picker" role="radiogroup" aria-label="配音方式">
                <button type="button" role="radio" aria-checked={mode === "single"} className={`mode-chip ${mode === "single" ? "active" : ""}`} onClick={() => setMode("single")}>单人配音</button>
                <button type="button" role="radio" aria-checked={mode === "duo"} className={`mode-chip ${mode === "duo" ? "active" : ""}`} onClick={() => setMode("duo")}>双人对话</button>
              </div>
              <p className="mode-hint">
                {mode === "duo"
                  ? "正文用「A：…」「B：…」标注说话人；只支持两个音色。"
                  : "一段文字配一个音色；长文建议按 50–200 字分段生成，便于重录。"}
              </p>

              <div className="section-title">
                <div><AudioLines size={17} /><h2>朗读文本</h2></div>
                <span>{text.length} / 20000</span>
              </div>
              <textarea
                className="prompt-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={20000}
                placeholder={mode === "duo" ? "A：你听说了吗？\nB：听说什么？" : "输入旁白、口播稿或要朗读的文字…"}
              />

              <div className="section-title parameters-title"><div><Mic size={17} /><h2>音色与风格</h2></div><span>Gemini TTS</span></div>
              <div className="parameter-grid">
                <label>
                  <span>{mode === "duo" ? "说话人 A 音色" : "音色"}</span>
                  <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                    {TTS_VOICES.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
                {mode === "duo" ? (
                  <label>
                    <span>说话人 B 音色</span>
                    <select value={secondVoice} onChange={(event) => setSecondVoice(event.target.value)}>
                      {TTS_VOICES.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                ) : null}
                <label>
                  <span>语种</span>
                  <select value={language} onChange={(event) => setLanguage(event.target.value)}>
                    {TTS_LANGUAGES.map((item) => <option key={item.value || "auto"} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label className="tts-style-field">
                  <span>风格 <small>会被当作语气标注，不会读出来</small></span>
                  <input value={style} onChange={(event) => setStyle(event.target.value)} maxLength={200} placeholder="例如：温柔、放慢，像深夜电台" />
                </label>
              </div>
              <div className="mode-picker tts-style-picker" aria-label="风格快捷选择">
                {TTS_STYLE_PRESETS.map((item) => (
                  <button key={item} type="button" className={`mode-chip ${style === item ? "active" : ""}`} onClick={() => setStyle(item)}>{item}</button>
                ))}
              </div>

              <details className="advanced-panel">
                <summary><Mic size={16} /><span>高级</span></summary>
                <div className="advanced-body">
                  <div className="parameter-grid">
                    <label>
                      <span>等待时长 <small>秒</small></span>
                      <input type="number" min={60} max={600} step={30} value={timeoutSeconds}
                        onChange={(event) => setTimeoutSeconds(Math.max(60, Math.min(600, Number(event.target.value) || 300)))} />
                    </label>
                  </div>
                  <p className="mode-hint">
                    输出固定为 24kHz / 16bit / 单声道 WAV；不支持自定义音色、克隆、SSML 或变速。
                  </p>
                </div>
              </details>
            </div>

            <div className="submit-row">
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : <span />}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={18} /> : <Mic size={18} />}
                {mode === "duo" ? "生成双人对话" : "生成配音"}
              </button>
            </div>
          </section>

          <SpeechResultPanel
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

function SpeechResultPanel({ task, tasks, onDiagnostics, onTask, onSelectTask, onToast }: {
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
    try { onTask(await api.retry(task.id)); onToast("success", "已重新提交"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
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
    <section className="result-panel music-result-panel speech-result-panel">
      <div className="result-toolbar">
        <div><Mic size={17} /><h2>结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
          {task && task.status === "failed" ? <button className="icon-button" title="重试" onClick={retry}><RotateCcw size={16} /></button> : null}
        </div>
      </div>

      <div className={`result-stage music-stage ${task?.assets.length ? "has-tracks" : ""}`}>
        {!task ? <SpeechEmpty /> : null}
        {busy ? (
          <div className="task-progress">
            <LoaderCircle className="spin" size={30} />
            <strong>{statusLabels[task.status]}</strong>
            {task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}
            <span>{task.model}</span>
            <small>配音通常几十秒完成，长文本会更久</small>
          </div>
        ) : null}
        {task && task.status === "failed" ? (
          <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode}</strong><span>{task.errorMessage}</span></div>
        ) : null}
        {task && !busy && task.status !== "failed" && !task.assets.length ? <SpeechEmpty /> : null}
        {task && task.assets.length ? (
          <div className="music-stage-head">
            <span>{task.assets.length} 段音频</span>
            <span>{task.model}</span>
          </div>
        ) : null}
        {task && task.assets.length ? (
          <div className="music-track-list">
            {task.assets.map((asset, index) => (
              <article className="music-track" key={asset.id}>
                <div className="music-cover speech-cover"><Mic size={28} /></div>
                <div className="music-track-main">
                  <div className="music-track-head">
                    <strong>{asset.title || `配音 ${index + 1}`}</strong>
                    {asset.duration ? <span>{formatDuration(asset.duration)}</span> : null}
                  </div>
                  <audio
                    controls
                    controlsList="nodownload"
                    preload="metadata"
                    src={api.assetUrl(asset.url)}
                    onContextMenu={(event) => event.preventDefault()}
                  />
                </div>
                <button
                  type="button"
                  className="secondary-button speech-download"
                  title="下载音频"
                  onClick={() => void download(asset)}
                  disabled={downloadingId === asset.id}
                >
                  {downloadingId === asset.id ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
                  下载
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </div>

      {recent.length ? (
        <div className="recent-strip">
          <div className="recent-strip-head"><span>最近</span><span className="muted">{recent.length} 条</span></div>
          <div className="recent-thumbs">
            {recent.map((item) => (
              <button
                key={item.id}
                className={`recent-thumb ${task?.id === item.id ? "active" : ""}`}
                title={item.prompt}
                onClick={() => onSelectTask(item)}
              >
                <Mic size={17} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SpeechEmpty() {
  return (
    <div className="empty-result">
      <Mic size={30} />
      <strong>等待配音</strong>
      <span>输入旁白或对话文本，选择音色后生成</span>
    </div>
  );
}
