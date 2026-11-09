import { useCallback, useEffect, useState } from "react";
import { Film, Plus } from "lucide-react";
import { api } from "./api";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { useFileDrop } from "./useFileDrop";
import { useImagePaste } from "./useImagePaste";
import { optionalNumber, usePersistentState } from "./task-ui";
import { VideoComposer, VideoComposerPlaceholder } from "./video/VideoComposer";
import { VideoResultPanel } from "./video/VideoResultPanel";
import { buildKlingMedia, buildSeedanceMedia, buildWanMedia, mediaDuration } from "./video/media-builders";
import type { MediaBucketsController } from "./hooks/useMediaBuckets";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities";
import {
  applySnapshotToDraft, defaultVideoDraft, draftKey, reconcileVideoDraft, type VideoDraft,
} from "../shared/video-draft";
import { maxImagesForMode, videoModesFor } from "../shared/video-modes";
import type { Channel, GenerationInput, Task } from "../shared/types";

type Toast = { kind: "success" | "error"; message: string };

/**
 * 视频生成页。
 *
 * 这一层只做编排：渠道/模型 → 可用模式 → 当前草稿 → 提交。界面在
 * `video/VideoComposer`，结果在 `video/VideoResultPanel`，媒体构造在
 * `video/media-builders`。模式与参数的真相在 `shared/video-modes`，
 * 服务端用同一张表校验，所以这里不做「界面上的假模式」。
 */
export function VideoGenerateView(props: {
  channels: Channel[];
  selectedChannelId: string;
  selectedModel: string;
  activeTask: Task | null;
  tasks: Task[];
  media: MediaBucketsController;
  onChannelChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onAddChannel: () => void;
  onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
  onDiagnostics: (task: Task) => void;
}) {
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType as VideoAdapter | undefined;
  const caps = adapterType ? VIDEO_CAPABILITIES[adapterType] : null;
  // 需要参考视频的模式（视频编辑/延长、运动控制）要先把文件传到渠道的上传服务；
  // 渠道没配 uploadEndpoint 时这些模式没有可用入口，就不列出来，避免点进去只能卡住
  const modes = videoModesFor(adapterType, props.selectedModel)
    .filter((item) => !item.needsReferenceVideo || Boolean(channel?.uploadEndpoint));

  /** 每个渠道记一个当前模式，切渠道/切模型后按新能力复核 */
  const [modeByAdapter, setModeByAdapter] = usePersistentState<Record<string, string>>("studio:mode", {});
  /** 每个「渠道:模式」一份草稿，键见 draftKey() */
  const [drafts, setDrafts] = usePersistentState<Record<string, VideoDraft>>("studio:drafts", {});
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [readingVideo, setReadingVideo] = useState(false);

  const requestedMode = adapterType ? modeByAdapter[adapterType] : undefined;
  const spec = modes.find((item) => item.id === requestedMode) ?? modes[0] ?? null;
  const key = draftKey(adapterType, spec?.id);
  const bucket = props.media.get(key);
  const maxImages = spec ? maxImagesForMode(adapterType, props.selectedModel, spec.id) : caps?.maxReferenceImages ?? 0;
  const draft = drafts[key] ?? defaultVideoDraft(adapterType, spec?.id);
  const reading = props.media.reading || readingVideo;
  const seedanceInlineAudio = draft.inlineAudio || !channel?.uploadEndpoint;

  function updateDraft(patch: Partial<VideoDraft>) {
    setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? draft), ...patch } }));
  }

  // 渠道/模型/模式变化后：不支持的模式回退到该渠道第一个可用模式
  const modeIds = modes.map((item) => item.id).join(",");
  useEffect(() => {
    if (!adapterType || !modes.length) return;
    if (requestedMode && modes.some((item) => item.id === requestedMode)) return;
    const fallback = modes[0];
    setModeByAdapter((current) => ({ ...current, [adapterType]: fallback.id }));
    if (requestedMode) setNotice(`当前模型不支持「${requestedMode}」，已切换到「${fallback.label}」`);
  }, [adapterType, requestedMode, modeIds, modes, setModeByAdapter]);

  // 参数收敛：时长、分辨率、比例、声音按新渠道+模式复核，越界时说明原因
  useEffect(() => {
    if (!adapterType || !spec) return;
    const base = drafts[key] ?? defaultVideoDraft(adapterType, spec.id);
    const result = reconcileVideoDraft(base, { adapter: adapterType, model: props.selectedModel, mode: spec.id });
    if (JSON.stringify(result.draft) !== JSON.stringify(base)) {
      setDrafts((current) => ({ ...current, [key]: result.draft }));
    }
    if (result.notices.length) setNotice(result.notices.map((item) => item.message).join(" · "));
  }, [adapterType, props.selectedModel, spec?.id, key]);

  async function selectVideo(file: File) {
    try {
      if (!channel?.uploadEndpoint) throw new Error("该渠道未配置上传服务，暂时无法上传参考视频");
      if (!["video/mp4", "video/quicktime"].includes(file.type)) throw new Error("请选择 MP4 或 MOV 视频");
      if (file.size > 100 * 1024 * 1024) throw new Error("视频不能超过 100 MB");
      setReadingVideo(true);
      const seconds = await mediaDuration(file, "video");
      const isMotion = spec?.id === "motion-control";
      const max = isMotion ? (draft.orientation === "image" ? 10 : 30) : 15;
      const min = isMotion ? 3 : 1;
      if (seconds < min || seconds > max) throw new Error(`视频时长需为 ${min}–${max} 秒`);
      props.media.setVideo(key, file, seconds);
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "视频读取失败");
    } finally {
      setReadingVideo(false);
    }
  }

  async function selectAudio(file: File) {
    try {
      if (!["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/m4a"].includes(file.type)) {
        throw new Error("请选择 MP3、M4A、AAC 或 WAV 音频");
      }
      if (file.size > 15 * 1024 * 1024) throw new Error("音频不能超过 15 MB");
      setReadingVideo(true);
      const duration = await mediaDuration(file, "audio");
      if (duration > 15 || duration <= 0) throw new Error("音频时长需在 15 秒以内");
      // 上游 r2v 实测要求音频 ≥1.8 秒，低于这个值会直接 400。
      if (adapterType === "seedance-video" && duration < 1.8) throw new Error("参考音频需至少 1.8 秒");
      props.media.setAudio(key, file, duration);
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "音频读取失败");
    } finally {
      setReadingVideo(false);
    }
  }

  const addImages = useCallback((files: File[]) => {
    if (!files.length || maxImages <= 0) return;
    props.media.addImages(key, files, maxImages);
  }, [key, maxImages, props.media]);

  const drop = useFileDrop(Boolean(adapterType) && maxImages > 0 && !submitting && bucket.images.length < maxImages, (files) => addImages(files));
  const pasteImages = useCallback((files: File[]) => {
    if (submitting || reading || maxImages <= 0) return;
    const room = maxImages - bucket.images.length;
    if (room <= 0) { props.onToast("error", `当前模式最多 ${maxImages} 张图`); return; }
    if (files.length > room) { props.onToast("error", `当前模式最多 ${maxImages} 张图，还可添加 ${room} 张`); return; }
    addImages(files);
  }, [submitting, reading, maxImages, bucket.images.length, addImages, props]);
  useImagePaste(pasteImages, Boolean(adapterType) && !submitting && !reading && maxImages > 0);

  function changeMode(next: { id: string }) {
    if (!adapterType) return;
    setModeByAdapter((current) => ({ ...current, [adapterType]: next.id }));
    setNotice(null);
  }

  async function generate() {
    if (reading) return props.onToast("error", "素材读取中，请稍候");
    if (!channel || !caps) return props.onToast("error", "请先选择视频渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    if (!draft.prompt.trim()) return props.onToast("error", "请输入提示词");
    if (!spec && bucket.images.length > caps.maxReferenceImages) {
      return props.onToast("error", `${caps.label} 参考图最多 ${caps.maxReferenceImages} 张`);
    }
    let rawParameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(draft.raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      rawParameters = parsed;
    } catch {
      return props.onToast("error", "高级参数必须是 JSON 对象");
    }

    setSubmitting(true);
    try {
      let wanVideoMedia: GenerationInput["wanVideoMedia"];
      let seedanceVideoMedia: GenerationInput["seedanceVideoMedia"];
      let klingVideoMedia: GenerationInput["klingVideoMedia"];
      const ctx = { spec, bucket, draft, model: props.selectedModel, inlineAudio: seedanceInlineAudio };
      if (adapterType === "wan-video" && spec) {
        const built = await buildWanMedia({ ...ctx, spec });
        if (typeof built === "string") { props.onToast("error", built); return; }
        wanVideoMedia = built.length ? built : undefined;
      } else if (adapterType === "seedance-video" && spec) {
        const built = await buildSeedanceMedia({ ...ctx, spec });
        if (typeof built === "string") { props.onToast("error", built); return; }
        seedanceVideoMedia = built.length ? built : undefined;
      } else if (adapterType === "kling-video" && spec) {
        const built = await buildKlingMedia({ ...ctx, spec });
        if (typeof built === "string") { props.onToast("error", built); return; }
        klingVideoMedia = built.length ? built : undefined;
      }

      const localVideo = bucket.video?.file;
      // 参考视频一律走 multipart 上传：素材只在本地，页面不提供粘贴地址的入口
      const uploadVideo = Boolean(localVideo) && Boolean(
        spec?.needsReferenceVideo || spec?.acceptsReferenceVideo,
      );
      const uploadAudio = adapterType === "seedance-video" && !seedanceInlineAudio && Boolean(bucket.audio);
      const durationLabel = spec && !spec.durationEditable
        ? "由参考视频决定"
        : draft.duration === -1 ? "智能" : `${draft.duration} 秒`;
      const detail = `时长：${durationLabel} · 分辨率：${draft.resolution || "默认"}`;
      if (!confirmGeneration({ kind: "视频生成", model: props.selectedModel, channel: channel.name, detail })) return;

      const input: GenerationInput = {
        channelId: channel.id,
        model: props.selectedModel,
        prompt: draft.prompt.trim(),
        negativePrompt: draft.negativePrompt.trim() || undefined,
        duration: spec && !spec.durationEditable ? undefined : draft.duration,
        resolution: draft.resolution || undefined,
        aspectRatio: caps.ratioField === "aspectRatio" ? draft.aspectRatio : undefined,
        ratio: caps.ratioField === "ratio" ? draft.ratio : undefined,
        audio: caps.supportsAudio ? draft.audio : undefined,
        promptExtend: caps.supportsPromptExtend ? draft.promptExtend : undefined,
        watermark: caps.supportsWatermark ? draft.watermark : undefined,
        seed: caps.supportsSeed ? optionalNumber(draft.seed) : undefined,
        wanVideoMode: adapterType === "wan-video" ? (spec?.id as GenerationInput["wanVideoMode"]) : undefined,
        wanVideoMedia,
        seedanceVideoMode: adapterType === "seedance-video" ? (spec?.id as GenerationInput["seedanceVideoMode"]) : undefined,
        seedanceVideoMedia,
        klingVideoMedia,
        klingVideoMode: adapterType === "kling-video" ? (spec?.id as GenerationInput["klingVideoMode"]) : undefined,
        klingCharacterOrientation: spec?.id === "motion-control" ? draft.orientation : undefined,
        klingMultiShot: adapterType === "kling-video" ? draft.multiShot : undefined,
        timeoutMs: draft.timeoutSeconds * 1000,
        rawParameters,
      };
      const task = adapterType === "seedance-video"
        ? await api.generateWithReferenceMedia(input, {
            video: uploadVideo ? localVideo : null,
            audio: uploadAudio ? bucket.audio?.file ?? null : null,
          })
        : uploadVideo && localVideo ? await api.generateWithReferenceVideo(input, localVideo)
          : await api.generate(input, spec ? [] : bucket.images.map((item) => item.file));
      props.onTask(task);
      props.onToast("success", "视频任务已提交");
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  /** 复用历史任务的参数：提示词、数值与公网地址回填，图片素材需重选 */
  function reuseParameters(task: Task) {
    const snapshot = task.inputParameters;
    if (!snapshot) return;
    const targetSpec = modes.find((item) => item.id === snapshot.mode) ?? spec;
    const targetKey = draftKey(adapterType, targetSpec?.id);
    const base = drafts[targetKey] ?? defaultVideoDraft(adapterType, targetSpec?.id);
    const result = applySnapshotToDraft(base, snapshot);
    setDrafts((current) => ({ ...current, [targetKey]: result.draft }));
    if (targetSpec && adapterType && targetSpec.id !== spec?.id) {
      setModeByAdapter((current) => ({ ...current, [adapterType]: targetSpec.id }));
    }
    props.onToast("success", result.droppedMedia
      ? `参数已回填；${result.droppedMedia} 个素材需要重新上传（图片 / 参考视频 / 参考音频）`
      : "参数已回填到创作框");
  }

  return (
    <div className="page generate-page vstudio-page">
      <div className="page-header">
        <div>
          <h1>视频生成</h1>
          <span className="page-kicker">{spec ? spec.label : "VIDEO GENERATION"}</span>
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
              kind="video"
              menuPlacement="down"
              placeholder="选择模型"
              ariaLabel="生视频模型"
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
          <Film size={34} />
          <h2>尚无视频渠道</h2>
          <p>在渠道配置中添加 xAI 或阿里云百炼的视频渠道</p>
          <button className="primary-button" onClick={props.onAddChannel}><Plus size={17} />添加渠道</button>
        </div>
      ) : (
        <div className="vstudio-scroll">
          <div className="vstudio-inner">
            <h2 className="vstudio-hero">体验视频生成，让创意摇动</h2>

            {channel && caps ? (
              <VideoComposer
                channel={channel}
                adapter={adapterType}
                model={props.selectedModel}
                caps={caps}
                modes={modes}
                spec={spec}
                draft={draft}
                bucket={bucket}
                maxImages={maxImages}
                submitting={submitting}
                reading={reading}
                dropActive={drop.active}
                dropProps={drop.dropProps}
                notice={notice}
                onDraftChange={updateDraft}
                onModeChange={changeMode}
                onAddImages={addImages}
                onRemoveImage={(previewUrl) => props.media.removeImage(key, previewUrl)}
                onClearImages={() => props.media.clearImages(key)}
                onSelectVideo={(file) => void selectVideo(file)}
                onClearVideo={() => props.media.clearVideo(key)}
                onSelectAudio={(file) => void selectAudio(file)}
                onClearAudio={() => props.media.clearAudio(key)}
                onGenerate={() => void generate()}
                onConfigureChannel={() => channel && props.onConfigureChannel(channel)}
                onToast={props.onToast}
              />
            ) : (
              <VideoComposerPlaceholder onAddChannel={props.onAddChannel} />
            )}

            <div className="vstudio-result-block">
              <div className="vstudio-result-head">
                <h2>创作记录</h2>
                <span>{props.tasks.length ? `共 ${props.tasks.length} 条 · 最近在前` : "还没有生成记录"}</span>
              </div>
              <div className="vstudio-result">
                <VideoResultPanel
                  task={props.activeTask}
                  tasks={props.tasks}
                  onDiagnostics={props.onDiagnostics}
                  onTask={props.onTask}
                  onSelectTask={props.onSelectTask}
                  onReuse={reuseParameters}
                  onToast={props.onToast}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
