/**
 * 确认卡片（AGENT_PLAN.md §13.5）。
 *
 * 拦在生成视频之前，也拦在会话任务额度用完之后。卡片上把「已经解析好的真实渠道名 + 模型」
 * 摆出来，而不是让用户看 alias——alias 只在服务端有意义。
 * 视频参数在卡片上可改：改完直接点确认，改动跟着这次确认一起提交，
 * 用户不用退回去重新说一遍。
 */
import { AlertCircle, Check, Film, Image as ImageIcon, X } from "lucide-react";
import { useState } from "react";
import { assetRef, type ChatMessage, type ConfirmPreview, type GenerateVideoArgs } from "../../shared/agent-types";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../../shared/video-capabilities";

const MODE_LABELS: Record<string, string> = {
  "text-to-video": "文生视频",
  "first-frame": "首帧生视频",
  "first-last-frame": "首尾帧生视频",
  reference: "参考生视频",
  "video-edit": "视频编辑",
  "video-extend": "视频续写",
};

export function ConfirmCard({
  message,
  preview,
  busy,
  onApprove,
  onReject,
}: {
  message: ChatMessage;
  preview: ConfirmPreview;
  busy: boolean;
  onApprove: (patch: Partial<GenerateVideoArgs>) => void;
  onReject: () => void;
}) {
  const isVideo = message.toolName === "generate_video";
  // 大脑不可用时的退化卡片：不是「拦一下」，而是「问一句要不要将就着生成」
  const isDegraded = preview.reason === "brain_down";
  // 批量（需求.md 问题 2b）：一张卡替 N 个调用问清楚。N 得写在按钮上，
  // 否则用户点「确认生成」时根本不知道自己一次同意了多少钱
  const batchCount = preview.count ?? 1;
  const args = (message.toolArgs ?? {}) as Partial<GenerateVideoArgs>;
  /**
   * 参数范围跟着**渠道**走，不是写死一套。
   * 写死的后果很具体：Grok 只支持 1–15 秒、且不认音频和提示词扩展，
   * 卡片却给它摆出「1–30 秒」和「带音频」——用户在卡片上改的每个字都可能让上游报错。
   */
  const caps = isVideo && preview.adapterType
    ? VIDEO_CAPABILITIES[preview.adapterType as VideoAdapter]
    : undefined;
  const durations = caps?.durations ?? { min: 1, max: 30, fixed: null, default: 5 };
  // 当前值不在档位表里（换了渠道、大脑写了个不常规的值）也要留一项，否则一进卡片就被悄悄改掉
  const resolutionOptions = caps
    ? [...caps.resolutions, ...(preview.resolution && !caps.resolutions.includes(preview.resolution) ? [preview.resolution] : [])]
    : [];

  const [duration, setDuration] = useState(String(preview.duration ?? args.duration ?? durations.default));
  const [resolution, setResolution] = useState(preview.resolution ?? args.resolution ?? "");
  const [audio, setAudio] = useState<boolean>(preview.audio ?? args.audio ?? false);
  const [promptExtend, setPromptExtend] = useState<boolean>(preview.promptExtend ?? args.promptExtend ?? true);

  function approve() {
    const patch: Partial<GenerateVideoArgs> = {};
    if (isVideo) {
      // 渠道不认的开关不发：发过去也只会被丢掉，还不如别让它出现在请求参数里
      patch.promptExtend = caps ? caps.supportsPromptExtend && promptExtend : promptExtend;
      patch.audio = caps ? caps.supportsAudio && audio : audio;
      const parsed = Number(duration);
      if (Number.isFinite(parsed) && parsed > 0) {
        patch.duration = Math.max(durations.min, Math.min(durations.max, Math.round(parsed)));
      }
      if (resolution.trim()) patch.resolution = resolution.trim();
    }
    onApprove(patch);
  }

  return (
    <div className="chat-row chat-row-assistant">
      <div className="confirm-card">
        <div className="confirm-card-head">
          <span className={`confirm-card-badge ${preview.reason === "session_limit" || isDegraded ? "is-warn" : ""}`}>
            {preview.reason === "session_limit" || isDegraded
              ? <AlertCircle size={13} />
              : isVideo ? <Film size={13} /> : <ImageIcon size={13} />}
            {preview.reason === "session_limit"
              ? "会话任务额度"
              : isDegraded ? "大脑不可用" : isVideo ? "生成视频" : "生成图片"}
          </span>
          <span className="confirm-card-model">
            {preview.channelName ? `${preview.channelName} · ` : ""}{preview.model || "（未指定）"}
          </span>
        </div>

        <p className="confirm-card-message">{preview.message}</p>
        {message.content ? <p className="confirm-card-say">{message.content}</p> : null}
        {batchCount > 1 ? (
          <div className="confirm-card-batch">
            {preview.consistency
              ? `这次要生成 ${batchCount} 张：先生成第 1 张基准图，再以它为准并行生成其余 ${batchCount - 1} 张（共 ${batchCount} 笔费用）。下面显示的是第 1 张的提示词。`
              : `这次会一次并行提交 ${batchCount} 个任务（${batchCount} 笔费用），下面显示的是第 1 个的提示词。`}
          </div>
        ) : null}
        {preview.prompt ? <div className="confirm-card-prompt">{preview.prompt}</div> : null}

        {isVideo ? (
          <>
            <div className="confirm-card-fields">
              <label className="confirm-field">
                <span>时长</span>
                {durations.fixed != null ? (
                  <input type="text" value={`${durations.fixed} 秒（固定）`} disabled />
                ) : (
                  <input
                    type="number" min={durations.min} max={durations.max} step={1} value={duration}
                    onChange={(event) => setDuration(event.target.value)} disabled={busy}
                  />
                )}
                <em>秒</em>
                {/* 范围写在旁边：这个渠道到底能从几秒到几秒，不该让用户去试 */}
                {durations.fixed == null ? <em className="confirm-field-range">{durations.min}–{durations.max}</em> : null}
              </label>
              <label className="confirm-field">
                <span>分辨率</span>
                {resolutionOptions.length ? (
                  <select value={resolution} onChange={(event) => setResolution(event.target.value)} disabled={busy}>
                    <option value="">按渠道默认</option>
                    {resolutionOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                ) : (
                  <input
                    type="text" value={resolution} placeholder="默认"
                    onChange={(event) => setResolution(event.target.value)} disabled={busy}
                  />
                )}
              </label>
              {/* 渠道不认的开关直接不出现：给 Grok 摆一个「带音频」，勾了也是白勾 */}
              {!caps || caps.supportsAudio ? (
                <label className="confirm-check">
                  <input type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} disabled={busy} />
                  <span>带音频</span>
                </label>
              ) : null}
              {!caps || caps.supportsPromptExtend ? (
                <label className="confirm-check">
                  <input type="checkbox" checked={promptExtend} onChange={(event) => setPromptExtend(event.target.checked)} disabled={busy} />
                  <span>自动扩展提示词</span>
                </label>
              ) : null}
            </div>
            <div className="confirm-card-meta">
              {MODE_LABELS[preview.mode ?? ""] ?? preview.mode ?? "按渠道默认"}
              {preview.referenceAssetId
                // 画布有多张时要说清只有主图进视频：视频的 first_frame 只有一个槽，
                // 不写这句，用户会以为画布整组都发过去了
                ? preview.referenceCount && preview.referenceCount > 1
                  ? ` · 用画布主图 ${assetRef(preview.referenceAssetId)} 当首帧（画布共 ${preview.referenceCount} 张，其余不发给视频模型）`
                  : " · 用当前画布当首帧"
                : " · 纯文生视频"}
            </div>
          </>
        ) : null}

        <div className="confirm-card-actions">
          <button type="button" className="secondary-button" onClick={onReject} disabled={busy}>
            <X size={14} />{isDegraded ? "算了" : "先不生成"}
          </button>
          <button type="button" className="primary-button" onClick={approve} disabled={busy}>
            <Check size={14} />{isDegraded ? "按这句话生成" : batchCount > 1 ? `确认生成 ${batchCount} 张` : "确认生成"}
          </button>
        </div>
      </div>
    </div>
  );
}
