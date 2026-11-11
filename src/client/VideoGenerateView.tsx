import { useCallback, useEffect, useState } from "react";
import { Film, Plus } from "lucide-react";
import { api } from "./api";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { useFileDrop } from "./useFileDrop";
import { useImagePaste } from "./useImagePaste";
import { withReferenceMediaType } from "./media-files";
import { referenceMediaType } from "../shared/reference-media";
import { optionalNumber, usePersistentState } from "./task-ui";
import { VideoComposer, VideoComposerPlaceholder } from "./video/VideoComposer";
import { VideoResultPanel } from "./video/VideoResultPanel";
import { buildKlingMedia, buildSeedanceMedia, buildWanMedia, mediaDuration } from "./video/media-builders";
import type { MediaBucketsController } from "./hooks/useMediaBuckets";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities";
import {
  applySnapshotToDraft, defaultVideoDraft, draftKey, reconcileVideoDraft, type VideoDraft,
} from "../shared/video-draft";
import { maxImagesForMode, referenceMediaLimits, resolveStudioMode, studioAssetSpec, studioModeForConcrete, videoModeLabel, videoModesFor } from "../shared/video-modes";
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
  /** 删除一条记录：上层弹「本地文件删不删」的确认框，这里不自己动数据 */
  onDelete: (task: Task) => void;
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
  /**
   * 展开创作框 = 专注编辑：输入框吃掉工作区，创作记录让位（暂时隐藏）。
   * 状态放在这一层，是因为「谁让位」由页面决定，创作框自己不该管记录区。
   */
  const [editingFocus, setEditingFocus] = useState(false);

  const requestedMode = adapterType ? modeByAdapter[adapterType] : undefined;
  // Grok 这类渠道没有「生成方式」列表，但仍要有一份素材规格：否则整个参考内容
  // 入口都不渲染（用户看到的就是「grok 缺少上传入口」），提交也会被当成没有可用模式。
  const spec = modes.find((item) => item.id === requestedMode) ?? modes[0]
    ?? studioAssetSpec(adapterType, props.selectedModel);
  const key = draftKey(adapterType, spec?.id);
  const bucket = props.media.get(key);
  const maxImages = spec ? maxImagesForMode(adapterType, props.selectedModel, spec.id) : caps?.maxReferenceImages ?? 0;
  /** 参考视频/音频各能放几段：Seedance 2.0 三段、2.5 十段，万相/可灵各一段 */
  const mediaLimits = referenceMediaLimits(adapterType, props.selectedModel, spec);
  const draft = drafts[key] ?? defaultVideoDraft(adapterType, spec?.id);
  const reading = props.media.reading || readingVideo;
  const seedanceInlineAudio = draft.inlineAudio || !channel?.uploadEndpoint;
  // 标题下的那行小字说的是「这一次会按哪种模式提交」，跟素材联动；
  // 合并入口（提示词/首尾帧）本身不是上游模式，直接翻成上游名字更准确
  const modePreviewLabel = videoModeLabel(resolveStudioMode(adapterType, props.selectedModel, spec?.id, {
    images: bucket.images.length, video: bucket.videos.length > 0, audio: bucket.audios.length > 0,
  })?.mode) ?? spec?.label ?? "VIDEO GENERATION";

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

  /** 单段视频的校验 + 入桶；失败已经弹过提示，返回 false 让批量循环停下 */
  async function selectVideo(file: File): Promise<boolean> {
    try {
      if (!channel?.uploadEndpoint) throw new Error("该渠道未配置上传服务，暂时无法上传参考视频");
      // 认类型交给扩展名（MIME 在有的机器上是空串），补上规范类型再往下传
      if (referenceMediaType(file)?.kind !== "video") throw new Error("请选择 MP4 或 MOV 视频");
      if (file.size > 100 * 1024 * 1024) throw new Error("视频不能超过 100 MB");
      setReadingVideo(true);
      const typed = withReferenceMediaType(file);
      const seconds = await mediaDuration(typed, "video");
      const isMotion = spec?.id === "motion-control";
      const max = isMotion ? (draft.orientation === "image" ? 10 : 30) : 15;
      const min = isMotion ? 3 : 1;
      if (seconds < min || seconds > max) throw new Error(`视频时长需为 ${min}–${max} 秒`);
      if (!props.media.addVideo(key, typed, seconds, mediaLimits.videos)) throw new Error("当前模式放不下这段参考视频");
      return true;
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "视频读取失败");
      return false;
    } finally {
      setReadingVideo(false);
    }
  }

  /**
   * 一次选多段视频。
   *
   * Seedance 2.0 能放 3 段、2.5 能放 10 段，逐个点选太笨；文件对话框里多选一起进来。
   * 只有 1 段额度的渠道（万相/可灵）取最后一段并说明，免得用户以为传了 3 段其实只剩 1 段。
   */
  async function selectVideos(files: File[]) {
    if (!files.length) return;
    for (const file of files) {
      const ok = await selectVideo(file);
      if (!ok) return;
    }
    if (mediaLimits.videos === 1 && files.length > 1) {
      props.onToast("error", `当前模式只有 1 段参考视频额度，只保留了「${files[files.length - 1]!.name}」`);
    }
  }

  /** 单段音频的校验 + 入桶；同 selectVideo */
  async function selectAudio(file: File): Promise<boolean> {
    try {
      // 小写 .m4a 在 Windows 上 `file.type` 常常是空串，按 MIME 白名单会误杀；
      // 统一按扩展名判定，并把类型补成 audio/mp4 再上传
      if (referenceMediaType(file)?.kind !== "audio") {
        throw new Error("请选择 MP3、M4A、AAC 或 WAV 音频");
      }
      if (file.size > 15 * 1024 * 1024) throw new Error("音频不能超过 15 MB");
      setReadingVideo(true);
      const typed = withReferenceMediaType(file);
      const duration = await mediaDuration(typed, "audio");
      if (duration > 15 || duration <= 0) throw new Error("音频时长需在 15 秒以内");
      // 上游 r2v 实测要求音频 ≥1.8 秒，低于这个值会直接 400。
      if (adapterType === "seedance-video" && duration < 1.8) throw new Error("参考音频需至少 1.8 秒");
      if (!props.media.addAudio(key, typed, duration, mediaLimits.audios)) throw new Error("当前模式放不下这段参考音频");
      return true;
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "音频读取失败");
      return false;
    } finally {
      setReadingVideo(false);
    }
  }

  async function selectAudios(files: File[]) {
    if (!files.length) return;
    for (const file of files) {
      const ok = await selectAudio(file);
      if (!ok) return;
    }
    if (mediaLimits.audios === 1 && files.length > 1) {
      props.onToast("error", `当前模式只有 1 段参考音频额度，只保留了「${files[files.length - 1]!.name}」`);
    }
  }

  const addImages = useCallback((files: File[]) => {
    if (!files.length || maxImages <= 0) return;
    props.media.addImages(key, files, maxImages);
  }, [key, maxImages, props.media]);

  /**
   * 拖进来的文件按类型分派。
   *
   * 之前落进来的东西一律当图片处理，拖一段视频会得到「仅支持 PNG、JPEG 或 WebP
   * 参考图」这种答非所问的提示。现在按 MIME / 扩展名拆开：图片进图片桶，
   * 视频、音频交给各自的校验函数；当前模式不收的那种直接说清楚原因。
   */
  const handleDrop = (files: File[]) => {
    if (!files.length) return;
    const images = files.filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name));
    // 一段或多段都收：多段额度下拖 3 个视频就放 3 段
    const videos = files.filter((file) => referenceMediaType(file)?.kind === "video");
    const audios = files.filter((file) => referenceMediaType(file)?.kind === "audio");
    const handled = new Set<File>([...images, ...videos, ...audios]);
    const problems: string[] = [];

    if (images.length) {
      if (maxImages <= 0) problems.push("当前模式不接受参考图，切到「提示词生视频」再拖图片");
      else addImages(images);
    }
    if (videos.length) {
      if (adapterType && (spec?.acceptsReferenceVideo || spec?.needsReferenceVideo)) void selectVideos(videos);
      else problems.push("当前模式不接受参考视频，切到「提示词生视频」或「视频编辑」再拖");
    }
    if (audios.length) {
      if (spec?.acceptsReferenceAudio) void selectAudios(audios);
      else problems.push("当前模式不接受参考音频，切到「提示词生视频」再拖");
    }
    const unknown = files.find((file) => !handled.has(file));
    if (unknown) problems.push(`不支持「${unknown.name}」：只能拖图片、MP4/MOV 视频或 MP3/M4A/AAC/WAV 音频`);
    if (problems.length) props.onToast("error", problems[0]!);
  };

  const drop = useFileDrop(Boolean(adapterType) && !submitting && !reading, handleDrop);
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
    // 合并入口提交前先落成上游真实模式：没素材=文生，有素材=参考，1/2 张图=首帧/首尾帧
    const resolved = resolveStudioMode(adapterType, props.selectedModel, spec?.id, {
      images: bucket.images.length, video: bucket.videos.length > 0, audio: bucket.audios.length > 0,
    });
    if (!resolved) return props.onToast("error", "当前模型没有可用的生成方式");
    const minImages = spec?.imageMin ?? spec?.imageSlots.length ?? 0;
    if (spec && !spec.imageRepeatable && bucket.images.length < minImages) {
      return props.onToast("error", `${spec.label}需要 ${minImages} 张图片`);
    }
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
      const ctx = { spec: resolved.spec, bucket, draft, model: props.selectedModel, inlineAudio: seedanceInlineAudio };
      if (adapterType === "wan-video") {
        const built = await buildWanMedia(ctx);
        if (typeof built === "string") { props.onToast("error", built); return; }
        wanVideoMedia = built.length ? built : undefined;
      } else if (adapterType === "seedance-video") {
        const built = await buildSeedanceMedia(ctx);
        if (typeof built === "string") { props.onToast("error", built); return; }
        seedanceVideoMedia = built.length ? built : undefined;
      } else if (adapterType === "kling-video") {
        const built = await buildKlingMedia(ctx);
        if (typeof built === "string") { props.onToast("error", built); return; }
        klingVideoMedia = built.length ? built : undefined;
      }

      const localVideos = bucket.videos.map((item) => item.file);
      // 参考视频一律走 multipart 上传：素材只在本地，页面不提供粘贴地址的入口
      const uploadVideos = Boolean(spec?.needsReferenceVideo || spec?.acceptsReferenceVideo) ? localVideos : [];
      const uploadAudios = adapterType === "seedance-video" && !seedanceInlineAudio
        ? bucket.audios.map((item) => item.file)
        : [];
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
        wanVideoMode: adapterType === "wan-video" ? (resolved.mode as GenerationInput["wanVideoMode"]) : undefined,
        wanVideoMedia,
        seedanceVideoMode: adapterType === "seedance-video" ? (resolved.mode as GenerationInput["seedanceVideoMode"]) : undefined,
        seedanceVideoMedia,
        klingVideoMedia,
        klingVideoMode: adapterType === "kling-video" ? (resolved.mode as GenerationInput["klingVideoMode"]) : undefined,
        klingCharacterOrientation: spec?.id === "motion-control" ? draft.orientation : undefined,
        klingMultiShot: adapterType === "kling-video" ? draft.multiShot : undefined,
        timeoutMs: draft.timeoutSeconds * 1000,
        rawParameters,
      };
      // 没有模式表 / 没有专属 media 数组的渠道（Grok）仍走通用 referenceImages 上传；
      // 其他渠道的图已经进了各自的 xxxVideoMedia，这里不要再重复带一份。
      const genericImages = adapterType === "grok-video" || !spec
        ? bucket.images.map((item) => item.file)
        : [];
      const task = adapterType === "seedance-video"
        ? await api.generateWithReferenceMedia(input, { videos: uploadVideos, audios: uploadAudios })
        : uploadVideos[0] ? await api.generateWithReferenceVideo(input, uploadVideos[0])
          : await api.generate(input, genericImages);
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
    // 历史任务存的是具体模式（文生/参考/首帧/首尾帧），先折回合并入口
    const targetMode = studioModeForConcrete(snapshot.mode);
    const targetSpec = modes.find((item) => item.id === targetMode) ?? spec;
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
    <div className={`page generate-page vstudio-page ${editingFocus ? "is-focus" : ""}`}>
      <div className="page-header">
        <div>
          <h1>视频生成</h1>
          <span className="page-kicker">{modePreviewLabel}</span>
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
            <div className="vstudio-hero">
              <h2>让创意，自由成片</h2>
              <p>用文字与画面，创造你的下一段精彩</p>
            </div>

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
                videoRoom={Math.max(0, mediaLimits.videos - bucket.videos.length)}
                audioRoom={Math.max(0, mediaLimits.audios - bucket.audios.length)}
                submitting={submitting}
                reading={reading}
                dropActive={drop.active}
                dropProps={drop.dropProps}
                notice={notice}
                expanded={editingFocus}
                onExpandedChange={setEditingFocus}
                onDraftChange={updateDraft}
                onModeChange={changeMode}
                onAddImages={addImages}
                onRemoveImage={(previewUrl) => props.media.removeImage(key, previewUrl)}
                onSelectVideos={(files) => void selectVideos(files)}
                onRemoveVideo={(id) => props.media.removeVideo(key, id)}
                onSelectAudios={(files) => void selectAudios(files)}
                onRemoveAudio={(id) => props.media.removeAudio(key, id)}
                onGenerate={() => void generate()}
                onConfigureChannel={() => channel && props.onConfigureChannel(channel)}
                onToast={props.onToast}
              />
            ) : (
              <VideoComposerPlaceholder onAddChannel={props.onAddChannel} />
            )}

            <div className="vstudio-result-block">
              <VideoResultPanel
                task={props.activeTask}
                tasks={props.tasks}
                hidden={editingFocus}
                onDiagnostics={props.onDiagnostics}
                onTask={props.onTask}
                onSelectTask={props.onSelectTask}
                onReuse={reuseParameters}
                onDelete={props.onDelete}
                onToast={props.onToast}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
