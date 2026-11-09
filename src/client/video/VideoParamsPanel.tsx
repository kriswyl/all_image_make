import { useRef } from "react";
import { createPortal } from "react-dom";
import type { VideoCapability } from "../../shared/video-capabilities";
import { seedanceVersion } from "../../shared/seedance-capabilities";
import type { VideoDraft } from "../../shared/video-draft";
import {
  VIDEO_FORMAT_CHOICES, VIDEO_VARIANT_CHOICES, resolutionOptionsFor, supportsAudioFor, type VideoModeSpec,
} from "../../shared/video-modes";
import type { KlingCharacterOrientation } from "../../shared/types";
import { useAnchoredPanelStyle, usePanelDismiss } from "./useAnchoredPanel";

/**
 * 参数面板。
 *
 * 挂在 body 上的浮层（portal）：创作框里的 textarea、素材槽都不因为开关面板
 * 而重新挂载，输入到一半点开参数不会丢字。位置按触发胶囊的矩形算，下面放不下
 * 就翻到上面，屏幕边缘会夹住。
 */

export interface VideoParamsPanelProps {
  open: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
  adapter: string | undefined;
  model: string;
  spec: VideoModeSpec | null;
  caps: VideoCapability;
  draft: VideoDraft;
  onChange: (patch: Partial<VideoDraft>) => void;
}

const PANEL_WIDTH = 330;
const PANEL_MAX_HEIGHT = 520;

/** 比例小图示：按真实宽高比画一个 18px 内的方框 */
function RatioGlyph({ value }: { value: string }) {
  if (value === "adaptive") return <span className="vstudio-ratio-glyph" style={{ width: 12, height: 12 }} />;
  const [w, h] = value.split(":").map((part) => Number(part));
  if (!w || !h) return <span className="vstudio-ratio-glyph" style={{ width: 12, height: 12 }} />;
  const scale = 16 / Math.max(w, h);
  return <span className="vstudio-ratio-glyph" style={{ width: Math.max(6, w * scale), height: Math.max(6, h * scale) }} />;
}

export function VideoParamsPanel(props: VideoParamsPanelProps) {
  const { open, anchor, onClose, adapter, model, spec, caps, draft, onChange } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredPanelStyle(open, anchor, PANEL_WIDTH, PANEL_MAX_HEIGHT);
  usePanelDismiss(open, onClose, panelRef, anchor);
  if (!open || !style) return null;

  const resolutions = resolutionOptionsFor(adapter, spec?.id);
  const ratioValue = caps.ratioField === "ratio" ? draft.ratio : draft.aspectRatio;
  const setRatio = (value: string) => {
    onChange(caps.ratioField === "ratio" ? { ratio: value } : { aspectRatio: value });
  };
  const ratioLocked = adapter === "seedance-video" && seedanceVersion(model) === "2.5"
    && (spec?.id === "first-frame" || spec?.id === "first-last-frame");
  const smartDuration = caps.supportsSmartDuration && (spec?.durationEditable ?? true);
  const audioSupported = supportsAudioFor(adapter, spec?.id);
  const isMotion = spec?.id === "motion-control";

  return createPortal(
    <div className="vstudio-panel" ref={panelRef} style={style} role="dialog" aria-label="视频参数">
      <p className="vstudio-panel-title">视频参数</p>

      <div className="vstudio-field">
        <span className="vstudio-field-label">视频比例</span>
        <div className="vstudio-segment is-wrap">
          {caps.aspectRatios.map((value) => (
            <button
              key={value}
              type="button"
              className={ratioValue === value ? "is-active" : ""}
              disabled={ratioLocked && value !== "adaptive"}
              title={ratioLocked && value !== "adaptive" ? "2.5 的首帧 / 首尾帧只接受自适应比例" : undefined}
              onClick={() => setRatio(value)}
            >
              <RatioGlyph value={value} />
              {value === "adaptive" ? "智能" : value}
            </button>
          ))}
        </div>
      </div>

      <div className="vstudio-field">
        <span className="vstudio-field-label">分辨率</span>
        <div className="vstudio-segment">
          {resolutions.map((value) => (
            <button key={value} type="button" className={draft.resolution === value ? "is-active" : ""} onClick={() => onChange({ resolution: value })}>
              {value.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="vstudio-field">
        <span className="vstudio-field-label">视频格式</span>
        <div className="vstudio-segment">
          {VIDEO_FORMAT_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={choice.value === "mp4" ? "is-active" : ""}
              disabled={!choice.supported}
              title={"reason" in choice ? choice.reason : undefined}
            >
              {choice.label}
            </button>
          ))}
        </div>
      </div>

      {spec?.durationEditable ?? true ? (
        <div className="vstudio-field">
          <span className="vstudio-field-label">视频时长</span>
          <div className="vstudio-segment">
            <button type="button" className={draft.duration !== -1 ? "is-active" : ""} onClick={() => onChange({ duration: draft.duration === -1 ? caps.durations.default : draft.duration })}>按秒数</button>
            <button
              type="button"
              className={draft.duration === -1 ? "is-active" : ""}
              disabled={!smartDuration}
              title={smartDuration ? undefined : `${caps.label} 不支持智能时长`}
              onClick={() => onChange({ duration: -1 })}
            >
              智能时长
            </button>
          </div>
          {draft.duration !== -1 && caps.durations.fixed == null ? (
            <div className="vstudio-duration-input">
              <input
                type="number"
                min={caps.durations.min}
                max={caps.durations.max}
                value={draft.duration}
                onChange={(event) => {
                  const raw = Number(event.target.value);
                  if (!Number.isFinite(raw)) return;
                  onChange({ duration: Math.max(caps.durations.min, Math.min(caps.durations.max, raw)) });
                }}
              />
              秒（{caps.durations.min}–{caps.durations.max}）
            </div>
          ) : null}
        </div>
      ) : null}

      {audioSupported ? (
        <div className="vstudio-field">
          <span className="vstudio-field-label">输出声音</span>
          <div className="vstudio-segment">
            <button type="button" className={draft.audio ? "is-active" : ""} onClick={() => onChange({ audio: true })}>开</button>
            <button type="button" className={!draft.audio ? "is-active" : ""} onClick={() => onChange({ audio: false })}>{isMotion ? "关（去掉原声）" : "关"}</button>
          </div>
        </div>
      ) : null}

      <div className="vstudio-field">
        <span className="vstudio-field-label">选择生成数量</span>
        <div className="vstudio-segment">
          {VIDEO_VARIANT_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={choice.value === 1 ? "is-active" : ""}
              disabled={!choice.supported}
              title={"reason" in choice ? choice.reason : undefined}
            >
              {choice.label}
            </button>
          ))}
        </div>
        <p className="vstudio-hint">上游一次请求只返回一条视频；要多条就重复提交，按次计费。</p>
      </div>

      <details className="vstudio-advanced">
        <summary>高级设置</summary>
        <div className="vstudio-field">
          <label htmlFor="vstudio-negative">负面提示词</label>
          <input id="vstudio-negative" value={draft.negativePrompt} placeholder="可选，描述不希望出现的内容"
            onChange={(event) => onChange({ negativePrompt: event.target.value })} />
        </div>
        {caps.supportsPromptExtend ? (
          <div className="vstudio-field vstudio-switch">
            <span>提示词智能改写</span>
            <input type="checkbox" checked={draft.promptExtend} onChange={(event) => onChange({ promptExtend: event.target.checked })} />
          </div>
        ) : null}
        {caps.supportsWatermark ? (
          <div className="vstudio-field vstudio-switch">
            <span>AI 生成水印</span>
            <input type="checkbox" checked={draft.watermark} onChange={(event) => onChange({ watermark: event.target.checked })} />
          </div>
        ) : null}
        {adapter === "kling-video" && !isMotion ? (
          <div className="vstudio-field vstudio-switch">
            <span>多镜头</span>
            <input type="checkbox" checked={draft.multiShot} onChange={(event) => onChange({ multiShot: event.target.checked })} />
          </div>
        ) : null}
        {isMotion ? (
          <div className="vstudio-field">
            <label htmlFor="vstudio-orientation">角色朝向</label>
            <select
              id="vstudio-orientation"
              value={draft.orientation}
              onChange={(event) => onChange({ orientation: event.target.value as KlingCharacterOrientation })}
            >
              <option value="video">跟随参考视频（≤30 秒）</option>
              <option value="image">跟随角色图片（≤10 秒）</option>
            </select>
          </div>
        ) : null}
        {caps.supportsSeed ? (
          <div className="vstudio-field">
            <label htmlFor="vstudio-seed">Seed</label>
            <input id="vstudio-seed" inputMode="numeric" value={draft.seed} placeholder="可选，用于复现"
              onChange={(event) => onChange({ seed: event.target.value.replace(/[^\d]/g, "") })} />
          </div>
        ) : null}
        <div className="vstudio-field">
          <label htmlFor="vstudio-timeout">生成超时（秒）</label>
          <input id="vstudio-timeout" type="number" min={60} max={1800} step={30} value={draft.timeoutSeconds}
            onChange={(event) => {
              const raw = Number(event.target.value);
              if (!Number.isFinite(raw)) return;
              onChange({ timeoutSeconds: Math.max(60, Math.min(1800, raw)) });
            }} />
        </div>
        <div className="vstudio-field">
          <label htmlFor="vstudio-raw">高级 JSON（原样并入请求体）</label>
          <textarea id="vstudio-raw" spellCheck={false} value={draft.raw} onChange={(event) => onChange({ raw: event.target.value })} />
        </div>
      </details>
    </div>,
    document.body,
  );
}
