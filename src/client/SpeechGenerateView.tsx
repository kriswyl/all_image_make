import { useRef, useState } from "react";
import {
  AudioLines, ChevronRight, KeyRound, List, LoaderCircle, Mic, Plus, Upload,
} from "lucide-react";
import { api } from "./api";
import { useFileDrop } from "./useFileDrop";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { SelectMenu } from "./ui/SelectMenu";
import { usePersistentState } from "./task-ui";
import type { Channel, Task } from "../shared/types";
import { TTS_DEFAULT_VOICE, TTS_LANGUAGES, TTS_STYLE_PRESETS, TTS_VOICES, splitTtsDialogue, formatTtsDialogue } from "../shared/tts";
import { SpeechResultPanel } from "./views/SpeechResultPanel";
import "./views/speech-workbench.css";

type Toast = { kind: "success" | "error"; message: string };
type SpeechMode = "single" | "duo";

const DRAFT_PREFIX = "vector-image:speech-draft:";
const VOICE_OPTIONS = TTS_VOICES.map((value) => ({ value, label: value }));
const COMMON_STYLE_LABELS = ["自然", "温柔", "新闻播报"];

function SpeechVoice({ speaker, value, onChange }: { speaker?: "A" | "B"; value: string; onChange: (value: string) => void }) {
  const label = speaker ? "说话人 " + speaker : "音色";
  return (
    <div className="speech-voice">
      {speaker ? <span className="speech-speaker" aria-hidden="true">{speaker}</span> : null}
      <div className="speech-voice-field">
        <span>{label}</span>
        <SelectMenu value={value} options={VOICE_OPTIONS} onChange={onChange}
          ariaLabel={speaker ? label + " 音色" : label} className="param-select" minWidth={160} />
      </div>
    </div>
  );
}

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
  const fileInput = useRef<HTMLInputElement>(null);

  const channel = props.channels.find((item) => item.id === props.selectedChannelId);

  async function importText(file: File) {
    if (!/\.(txt|md)$/i.test(file.name)) return props.onToast("error", "请选择 TXT 或 Markdown 文本文件");
    if (file.size > 1024 * 1024) return props.onToast("error", "文件不能超过 1 MB");
    try {
      const content = (await file.text()).replace(/^\uFEFF/, "");
      if (!content.trim()) return props.onToast("error", "文件内容为空");
      if (content.length > 20000) return props.onToast("error", "文本超过 20000 字，请拆分后再导入");
      if (text.trim() && !window.confirm("导入文件会替换当前朗读文本，继续吗？")) return;
      let imported = content;
      if (mode === "duo") { try { imported = formatTtsDialogue(content); } catch { /* 未识别的内容保留原样，供用户编辑 */ } }
      setText(imported); props.onToast("success", `已导入 ${file.name}`);
    } catch { props.onToast("error", "读取失败，请使用 UTF-8 编码的文本文件"); }
  }
  const textDrop = useFileDrop(!submitting, (files) => { if (files[0]) void importText(files[0]); });

  function formatScript() {
    try {
      const formatted = formatTtsDialogue(text);
      if (formatted.length > 20000) return props.onToast("error", "整理后的文本超过 20000 字");
      setText(formatted);
      props.onToast("success", "已整理为 A/B 格式");
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "对话格式不正确");
    }
  }

  async function generate() {
    if (!channel) return props.onToast("error", "请先选择语音渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择 TTS 模型");
    const content = text.trim();
    if (!content) return props.onToast("error", "请输入要朗读的文本");
    if (style.trim().length > 200) return props.onToast("error", "风格描述最多 200 字");
    if (mode === "duo" && !secondVoice) return props.onToast("error", "双人对话需要选择第二个音色");
    if (mode === "duo") {
      try { splitTtsDialogue(content); }
      catch (error) { return props.onToast("error", error instanceof Error ? error.message : "对话格式不正确"); }
    }

    if (!confirmGeneration({ kind: "语音生成", model: props.selectedModel, channel: channel.name })) return;
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
        timeoutMs: Math.round(Math.min(600, Math.max(300, timeoutSeconds))) * 1000,
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
    <div className="page generate-page speech-workbench-page">
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
        <div className="speech-workbench">
          <section className="speech-card speech-composer" aria-label="配音创作">
            <header className="speech-card-header"><h2><Mic size={17} />配音创作</h2></header>
            <div className="speech-composer-content">
              <div className="speech-modes" role="group" aria-label="配音方式">
                <button type="button" className="secondary-button" aria-pressed={mode === "single"} onClick={() => setMode("single")}>单人配音</button>
                <button type="button" className="secondary-button" aria-pressed={mode === "duo"} onClick={() => setMode("duo")}>双人对话</button>
              </div>
              <div className="speech-voices" data-duo={mode === "duo"}>
                <SpeechVoice speaker={mode === "duo" ? "A" : undefined} value={voice} onChange={setVoice} />
                {mode === "duo" ? <SpeechVoice speaker="B" value={secondVoice} onChange={setSecondVoice} /> : null}
              </div>

              <div className={`speech-editor${textDrop.active ? " is-drop-target" : ""}`} {...textDrop.dropProps}>
                <div className="speech-editor-header">
                  <label htmlFor="speech-script">朗读文本</label>
                  <div className="speech-editor-actions">
                    <button type="button" className="secondary-button" disabled={submitting} onClick={() => fileInput.current?.click()}>
                      <Upload size={14} />导入文本
                    </button>
                    <input ref={fileInput} type="file" accept=".txt,.md,text/plain,text/markdown" hidden disabled={submitting}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void importText(file);
                        event.target.value = "";
                      }} />
                    {mode === "duo" ? (
                      <button type="button" className="secondary-button" disabled={!text.trim() || submitting} onClick={formatScript}>
                        <List size={14} />整理 A/B
                      </button>
                    ) : null}
                  </div>
                </div>
                <textarea id="speech-script" value={text} onChange={(event) => setText(event.target.value)}
                  onBlur={() => {
                    if (mode !== "duo" || !text.trim()) return;
                    try {
                      const formatted = formatTtsDialogue(text);
                      if (formatted !== text && formatted.length <= 20000) setText(formatted);
                    } catch { /* 未写完的对话保留原样。 */ }
                  }}
                  maxLength={20000} aria-describedby="speech-script-hint"
                  placeholder={mode === "duo" ? "A：今晚的故事，从一封旧信说起。\nB：信里写了什么？" : "输入旁白、口播稿或要朗读的文字…"} />
                <div className="speech-editor-footer">
                  <span id="speech-script-hint">{mode === "duo" ? "每行用 A：或 B：标记说话人" : "支持拖入 TXT 或 Markdown"}</span>
                  <span>{text.length} / 20000</span>
                </div>
              </div>

              <div className="speech-style">
                <label htmlFor="speech-style">风格</label>
                <input id="speech-style" value={style} onChange={(event) => setStyle(event.target.value)} maxLength={200}
                  placeholder="例如：自然、像在讲故事" title="风格作为语气提示，不会朗读" />
                <div className="speech-style-presets" role="group" aria-label="常用风格">
                  {TTS_STYLE_PRESETS.slice(0, 3).map((item, index) => (
                    <button key={item} type="button" className="secondary-button" aria-pressed={style === item}
                      onClick={() => setStyle(item)}>{COMMON_STYLE_LABELS[index]}</button>
                  ))}
                </div>
              </div>

              <details className="advanced-panel speech-advanced">
                <summary><ChevronRight size={15} /><span>更多设置</span></summary>
                <div className="speech-settings-grid">
                  <label><span>语种</span>
                    <SelectMenu value={language} options={TTS_LANGUAGES.map((item) => ({ value: item.value, label: item.label }))}
                      onChange={setLanguage} ariaLabel="语种" className="param-select" minWidth={180} />
                  </label>
                  <label><span>等待时长（秒）</span>
                    <input type="number" min={300} max={600} step={30} value={timeoutSeconds}
                      onChange={(event) => setTimeoutSeconds(Number(event.target.value))} />
                  </label>
                </div>
                <div className="speech-style-presets" role="group" aria-label="更多风格">
                  {TTS_STYLE_PRESETS.slice(3).map((item) => (
                    <button key={item} type="button" className="secondary-button" aria-pressed={style === item}
                      onClick={() => setStyle(item)}>{item}</button>
                  ))}
                </div>
                <p className="field-hint">输出格式为 24 kHz / 16 bit / 单声道 WAV。</p>
              </details>
            </div>

            <div className="speech-submit">
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : null}
              <button className="primary-button" onClick={generate} disabled={submitting || !channel || !props.selectedModel || !text.trim()}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : <Mic size={17} />}
                {mode === "duo" ? "生成双人对话" : "生成配音"}
              </button>
            </div>
          </section>

          <SpeechResultPanel task={props.activeTask ?? props.tasks[0] ?? null} tasks={props.tasks}
            onDiagnostics={props.onDiagnostics} onTask={props.onTask} onSelectTask={props.onSelectTask} onToast={props.onToast} />
        </div>
      )}
    </div>
  );
}
