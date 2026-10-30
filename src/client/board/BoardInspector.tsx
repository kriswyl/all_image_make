/**
 * 无限画布右侧检查器。
 *
 * P0 只放「改节点内容」和「删除」；生成参数在 P1 接进来。
 * 所有修改都走 useBoard 的 applyLocal，和画布拖拽共用同一套防抖保存 / 撤销。
 */
import { useEffect, useState } from "react";
import { AudioLines, Image as ImageIcon, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  BOARD_LIMITS, directInputLinks, directUpstreamImages, directUpstreamText,
  type BoardAudioKind, type BoardEdgeRole, type BoardNode, type BoardView,
} from "../../shared/board";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../../shared/tts";
import {
  supportedVideoModes, VIDEO_CAPABILITIES, VIDEO_DEFAULTS, VIDEO_MODE_LABELS, type VideoAdapter,
} from "../../shared/video-capabilities";
import type { Asset } from "../../shared/types";
import { ModelPicker } from "../chat/ModelPicker";
import { api } from "../api";

export interface BoardImageAlias {
  alias: string;
  model: string;
  channelName: string;
  channelId: string;
  adapterType: string;
}

export type BoardVideoAlias = BoardImageAlias;

const OPENAI_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const GEMINI_SIZES = ["1K", "2K", "4K"] as const;
const QUALITIES = ["low", "medium", "high"] as const;
const VIDEO_MODE_OPTIONS = [
  { value: "", label: "自动（按连线角色）" },
  { value: "text-to-video", label: VIDEO_MODE_LABELS["text-to-video"] },
  { value: "first-frame", label: VIDEO_MODE_LABELS["first-frame"] },
  { value: "first-last-frame", label: VIDEO_MODE_LABELS["first-last-frame"] },
  { value: "reference", label: VIDEO_MODE_LABELS.reference },
] as const;

export function BoardInspector({
  view, node, selectedCount, assets, imageAliases, defaultImageAlias, videoAliases, defaultVideoAlias,
  audioAliases, defaultSpeechAlias, defaultMusicAlias,
  onUpdateNode, onUpdateEdge, onDeleteNode, onPreview, onPickImage, onRemoveAsset,
  onGenerate, onStopTask, onRetryTask, onExtractFrame, onCompareVersions, onClose,
}: {
  view: BoardView;
  node: BoardNode | null;
  selectedCount: number;
  assets: Map<string, Asset>;
  imageAliases: BoardImageAlias[];
  defaultImageAlias: string;
  videoAliases: BoardVideoAlias[];
  defaultVideoAlias: string;
  audioAliases: BoardImageAlias[];
  defaultSpeechAlias: string;
  defaultMusicAlias: string;
  onUpdateNode: (nodeId: string, patch: Partial<BoardNode>) => void;
  onUpdateEdge: (edgeId: string, patch: { role?: BoardEdgeRole | undefined }) => void;
  onDeleteNode: (nodeId: string) => void;
  onPreview: (asset: Asset) => void;
  onPickImage: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  onExtractFrame: (nodeId: string) => void;
  onCompareVersions: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [titleDraft, setTitleDraft] = useState("");
  const [textDraft, setTextDraft] = useState("");

  useEffect(() => {
    setTitleDraft(node?.title ?? "");
    setTextDraft(node?.type === "text" ? node.text : node ? node.prompt ?? "" : "");
  }, [node?.id, node?.type]);

  if (!node) return null;

  const asset = node.type === "image" || node.type === "video" || node.type === "audio"
    ? (node.assetId ? assets.get(node.assetId) ?? null : null)
    : null;
  const isConfig = node.type === "config";
  const isGenerator = node.type !== "text";
  const mode = node.type === "config" ? node.mode : node.type;
  const isVideo = mode === "video";
  const isText = mode === "text";
  const isAudio = mode === "audio";
  const audioKind: BoardAudioKind = isGenerator ? node.audioKind ?? "speech" : "speech";
  const audioAliasList = audioAliases.filter((alias) =>
    alias.adapterType === (audioKind === "music" ? "suno-music" : "gemini-tts"));
  const upstreamText = isGenerator ? directUpstreamText(view.doc, node.id) : [];
  const upstreamImages = isGenerator ? directUpstreamImages(view.doc, node.id) : [];
  const upstreamLinks = isGenerator ? directInputLinks(view.doc, node.id) : [];
  const aliasList = isVideo ? videoAliases : isAudio ? audioAliasList : imageAliases;
  const defaultAlias = isVideo
    ? defaultVideoAlias
    : isAudio
      ? (audioKind === "music" ? defaultMusicAlias : defaultSpeechAlias)
      : defaultImageAlias;
  const effectiveAlias = isGenerator
    ? (aliasList.some((item) => item.alias === node.model)
      ? node.model!
      : defaultAlias || aliasList[0]?.alias || "")
    : "";
  const effectiveAliasInfo = aliasList.find((item) => item.alias === effectiveAlias) ?? null;
  const sizeMode = effectiveAliasInfo?.adapterType === "gemini-content"
    ? "gemini"
    : effectiveAliasInfo?.adapterType === "midjourney"
      ? "none"
      : "size";
  const videoCapability = isVideo
    ? VIDEO_CAPABILITIES[effectiveAliasInfo?.adapterType as VideoAdapter] ?? null
    : null;
  const videoDefaults = VIDEO_DEFAULTS[effectiveAliasInfo?.adapterType ?? ""] ?? { duration: 5, resolution: "720p", audio: false };
  const videoResolutions = videoCapability?.resolutions ?? [videoDefaults.resolution];
  const videoModeOptions = isVideo
    ? VIDEO_MODE_OPTIONS.filter((option) => !option.value
      || supportedVideoModes(effectiveAliasInfo?.adapterType ?? "", effectiveAliasInfo?.model).includes(option.value))
    : VIDEO_MODE_OPTIONS;
  const modelOptions = [
    {
      value: "",
      model: "跟随默认",
      channelName: defaultAlias
        ? `默认${isVideo ? "视频" : isAudio ? "音频" : "生图"}模型 ${defaultAlias}`
        : `默认${isVideo ? "视频" : isAudio ? "音频" : "生图"}模型`,
    },
    ...aliasList.map((item) => ({
      value: item.alias,
      model: item.model,
      channelName: item.channelName,
    })),
  ];
  const videoHasImages = upstreamLinks.some((link) => link.node.type === "image" && link.node.assetId);
  const videoCount = upstreamLinks.filter((link) => link.node.type === "video").length;
  const audioCount = upstreamLinks.filter((link) => link.node.type === "audio").length;
  const generateBlocked = isGenerator
    && ((isVideo && !videoAliases.length)
      || (isAudio && !audioAliasList.length)
      || (!isVideo && !isAudio && !imageAliases.length));

  return (
    <aside className="board-inspector" aria-label="节点设置">
      <header className="board-inspector-head">
        <div>
          <span>{node.type === "config" ? "配置节点" : node.type === "image" ? "图片节点" : node.type === "video" ? "视频节点" : node.type === "audio" ? "音频节点" : "文本节点"}</span>
          <strong>{node.ref}</strong>
        </div>
        <button type="button" className="icon-button compact" aria-label="关闭检查器" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <div className="board-inspector-body">
        {selectedCount > 1 ? (
          <section className="board-inspector-section">
            <p className="board-inspector-hint">已选中 {selectedCount} 个节点。检查器只编辑最后选中的这一个。</p>
          </section>
        ) : null}

        <section className="board-inspector-section">
          <label className="board-field">
            <span>名称</span>
            <input
              value={titleDraft}
              maxLength={80}
              onChange={(event) => {
                setTitleDraft(event.target.value);
                onUpdateNode(node.id, { title: event.target.value } as Partial<BoardNode>);
              }}
              placeholder="节点名称"
            />
          </label>
        </section>

        {node.type === "text" ? (
          <section className="board-inspector-section">
            <label className="board-field">
              <span>文本</span>
              <textarea
                rows={12}
                maxLength={20000}
                value={textDraft}
                onChange={(event) => {
                  setTextDraft(event.target.value);
                  onUpdateNode(node.id, { text: event.target.value } as Partial<BoardNode>);
                }}
                placeholder="写提示词、文案或说明…"
              />
            </label>
            <p className="board-inspector-hint">{textDraft.length} / 20000 字</p>
          </section>
        ) : null}

        {node.type === "image" || node.type === "video" || node.type === "audio" ? (
          <section className="board-inspector-section">
            <div className="board-inspector-thumb">
              {asset ? (
                node.type === "video"
                  ? <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline />
                  : node.type === "audio"
                    ? <span className="board-inspector-audio"><AudioLines size={20} /><em>{asset.fileName}</em></span>
                    : <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} alt="" />
              ) : (
                <span>
                  {node.type === "audio" ? <AudioLines size={20} /> : <ImageIcon size={20} />}
                  {node.assetId ? "素材已删除" : "还没有素材"}
                </span>
              )}
            </div>
            <div className="board-inspector-actions">
              {asset ? (
                <button type="button" className="secondary-button compact" onClick={() => onPreview(asset)}>预览</button>
              ) : null}
              {asset && node.type === "video" ? <button type="button" className="secondary-button compact" onClick={() => onExtractFrame(node.id)}>提取尾帧</button> : null}
              {asset ? <button type="button" className="secondary-button compact" onClick={() => onCompareVersions(node.id)}>版本对比</button> : null}
              <button type="button" className="secondary-button compact" onClick={() => onPickImage(node.id)}>
                <Upload size={12} />{asset ? "替换素材" : "选择素材"}
              </button>
              {node.assetId ? (
                <button type="button" className="secondary-button compact" onClick={() => onRemoveAsset(node.id)}>
                  <X size={12} />移除
                </button>
              ) : null}
              {(node.type === "image" || node.type === "video" || node.type === "audio") && node.status === "loading" && node.taskId ? (
                <button type="button" className="secondary-button compact" onClick={() => onStopTask(node.taskId!)}>
                  停止
                </button>
              ) : null}
              {(node.type === "image" || node.type === "video" || node.type === "audio") && (node.status === "failed" || node.status === "cancelled") && node.taskId ? (
                <button type="button" className="secondary-button compact" onClick={() => onRetryTask(node.taskId!)}>
                  <RefreshCw size={12} />重试
                </button>
              ) : null}
            </div>
            {asset ? <p className="board-inspector-hint">{asset.fileName}</p> : null}
          </section>
        ) : null}

        {isGenerator ? (
          <>
            <section className="board-inspector-section">
              <div className="board-inspector-label">
                <span>上游</span>
                <em>
                  {upstreamText.length} 段文本 · {upstreamImages.length} 张图
                  {videoCount ? ` · ${videoCount} 个视频` : ""}{audioCount ? ` · ${audioCount} 个音频` : ""}
                  {isVideo && videoHasImages ? " · 按角色分配" : ""}
                </em>
              </div>
              {isVideo ? (
                <div className="board-upstream-list">
                  {upstreamLinks.map(({ edge, node: upstreamNode }) => (
                    <div key={edge.id} className="board-upstream-row">
                      <span className={`board-chip ${upstreamNode.type === "text" ? "is-text" : "is-image"}`}>
                        {upstreamNode.ref} {upstreamNode.title || (upstreamNode.type === "text" ? "文本" : upstreamNode.type === "video" ? "视频" : upstreamNode.type === "audio" ? "音频" : "图片")}
                      </span>
                      {upstreamNode.type === "text" ? (
                        <em className="board-upstream-role">提示词</em>
                      ) : upstreamNode.type === "video" ? (
                        <em className={`board-upstream-role ${!["wan-video", "kling-video"].includes(effectiveAliasInfo?.adapterType ?? "") ? "is-warn" : ""}`}>{["wan-video", "kling-video"].includes(effectiveAliasInfo?.adapterType ?? "") ? "参考视频" : "当前渠道不支持"}</em>
                      ) : upstreamNode.type === "audio" ? (
                        <em className={`board-upstream-role ${effectiveAliasInfo?.adapterType !== "wan-video" ? "is-warn" : ""}`}>{effectiveAliasInfo?.adapterType === "wan-video" ? "参考音频" : "当前渠道不支持"}</em>
                      ) : upstreamNode.type !== "image" ? (
                        <em className="board-upstream-role is-warn">不支持的输入</em>
                      ) : (
                        <select
                          className="board-role-select"
                          value={edge.role ?? ""}
                          onChange={(event) => onUpdateEdge(edge.id, {
                            role: (event.target.value || undefined) as BoardEdgeRole | undefined,
                          })}
                          aria-label={`${upstreamNode.ref} 的视频角色`}
                        >
                          <option value="">自动</option>
                          <option value="reference">参考图</option>
                          <option value="first-frame">首帧</option>
                          <option value="last-frame">尾帧</option>
                        </select>
                      )}
                    </div>
                  ))}
                  {!upstreamLinks.length ? (
                    <span className="board-inspector-hint">连接文本、图片、视频或音频节点作为上游；支持情况取决于所选模型。</span>
                  ) : null}
                  {videoCount ? <span className="board-inspector-hint">生成时参考视频将上传至渠道图床，上传后可通过公网访问。</span> : null}
                </div>
              ) : (
                <div className="board-inspector-chips">
                  {upstreamText.map((item) => (
                    <span key={item.id} className="board-chip is-text">{item.title || item.ref}</span>
                  ))}
                  {upstreamImages.map((item) => (
                    <span key={item.id} className="board-chip is-image">{item.title || item.ref}</span>
                  ))}
                  {!upstreamText.length && !upstreamImages.length ? (
                    <span className="board-inspector-hint">把文本 / 图片节点连到配置节点的左侧端口。</span>
                  ) : null}
                  {(isText || isAudio) && upstreamImages.length ? (
                    <span className="board-inspector-hint is-warn">
                      {isText ? "生文本" : "生音频"}只使用文本上游；图片连线会被服务端拒绝。
                    </span>
                  ) : null}
                </div>
              )}
            </section>
            <section className="board-inspector-section">
              <label className="board-field">
                <span>提示词</span>
                <textarea
                  rows={8}
                  maxLength={20000}
                  value={textDraft}
                  onChange={(event) => {
                    setTextDraft(event.target.value);
                    onUpdateNode(node.id, { prompt: event.target.value } as Partial<BoardNode>);
                  }}
                  placeholder={isAudio
                    ? (audioKind === "speech" ? "要朗读的正文；留空则只用上游文本" : "风格 / 情绪 / 使用场景；留空则只用上游文本")
                    : "留空则只用上游文本"}
                />
              </label>
              <label className="board-config-check">
                <input
                  type="checkbox"
                  checked={node.useUpstreamText}
                  onChange={(event) => onUpdateNode(node.id, { useUpstreamText: event.target.checked } as Partial<BoardNode>)}
                />
                拼接上游文本
              </label>
            </section>
            <section className="board-inspector-section">
              {isText ? (
                <>
                  <div className="board-inspector-label">
                    <span>文本模型</span>
                    <em>跟随无限画布助手</em>
                  </div>
                  <p className="board-inspector-hint">
                    生文本使用创建无限画布时选中的对话模型，直接写进右侧新的文本节点。
                  </p>
                </>
              ) : (
                <>
              <div className="board-inspector-label">
                <span>{isVideo ? "视频模型" : isAudio ? "音频模型" : "模型与尺寸"}</span>
                <em>{effectiveAliasInfo ? effectiveAliasInfo.channelName : "默认"}</em>
              </div>
              {isVideo && !videoAliases.length ? (
                <p className="board-inspector-hint is-warn">还没有可用的视频渠道。先到「模型配置」添加一个，再回来生成视频。</p>
              ) : null}
              {isAudio && !audioAliasList.length ? (
                <p className="board-inspector-hint is-warn">
                  还没有可用的{audioKind === "music" ? "音乐" : "语音"}渠道。先到「模型配置」添加一个。
                </p>
              ) : null}
              {isAudio ? (
                <label className="board-field">
                  <span>音频类型</span>
                  <select
                    value={audioKind}
                    onChange={(event) => {
                      const nextKind = event.target.value as BoardAudioKind;
                      onUpdateNode(node.id, {
                        audioKind: nextKind,
                        model: undefined,
                        channelId: undefined,
                        voice: undefined,
                        ttsStyle: undefined,
                        instrumental: undefined,
                      } as Partial<BoardNode>);
                    }}
                  >
                    <option value="speech">配音 / 朗读</option>
                    <option value="music">音乐</option>
                  </select>
                </label>
              ) : null}
              <ModelPicker
                className="board-model-picker"
                options={modelOptions}
                value={aliasList.some((item) => item.alias === node.model) ? node.model! : ""}
                kind={isAudio ? "audio" : isVideo ? "video" : "image"}
                menuPlacement="down"
                onChange={(value) => {
                  const alias = aliasList.find((item) => item.alias === value);
                  onUpdateNode(node.id, {
                    model: value || undefined,
                    channelId: alias?.channelId,
                    size: undefined,
                    imageSize: undefined,
                    quality: undefined,
                    videoMode: undefined,
                    durationSeconds: undefined,
                    resolution: undefined,
                    audio: undefined,
                    voice: undefined,
                    ttsStyle: undefined,
                    instrumental: undefined,
                  } as Partial<BoardNode>);
                }}
                ariaLabel={isAudio ? "无限画布音频模型" : isVideo ? "无限画布视频模型" : "无限画布生图模型"}
              />

              {isVideo && videoCapability ? <p className="board-inspector-hint">{videoCapability.label}：支持 {videoModeOptions.filter((option) => option.value).map((option) => option.label).join("、")}；时长 {videoCapability.durations.fixed ? `${videoCapability.durations.fixed} 秒` : `${videoCapability.durations.min}–${videoCapability.durations.max} 秒`}；最多 {Math.min(BOARD_LIMITS.maxUpstreamImages, videoCapability.maxReferenceImages)} 张参考图；{videoCapability.supportsAudio ? "支持音频参数" : "不支持音频参数"}。具体组合请以所选模式的校验提示为准。</p> : null}
              {isAudio ? (
                <>
                  {audioKind === "speech" ? (
                    <>
                      <label className="board-field">
                        <span>音色</span>
                        <select
                          value={node.voice ?? TTS_DEFAULT_VOICE}
                          onChange={(event) => onUpdateNode(node.id, { voice: event.target.value } as Partial<BoardNode>)}
                        >
                          {TTS_VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
                        </select>
                      </label>
                      <label className="board-field">
                        <span>语气 / 风格（可选）</span>
                        <input
                          value={node.ttsStyle ?? ""}
                          maxLength={200}
                          placeholder="例如：温柔、放慢，像在讲睡前故事"
                          onChange={(event) => onUpdateNode(node.id, { ttsStyle: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                      <p className="board-inspector-hint">提示词区域就是配音正文；一次生成 1 段音频。</p>
                    </>
                  ) : (
                    <>
                      <label className="board-config-check">
                        <input
                          type="checkbox"
                          checked={node.instrumental ?? false}
                          onChange={(event) => onUpdateNode(node.id, { instrumental: event.target.checked } as Partial<BoardNode>)}
                        />
                        只要纯音乐，不要人声
                      </label>
                      <label className="board-field">
                        <span>歌名（可选）</span>
                        <input
                          value={node.musicTitle ?? ""}
                          maxLength={80}
                          placeholder="不填由上游自动命名"
                          onChange={(event) => onUpdateNode(node.id, { musicTitle: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                      <label className="board-field">
                        <span>曲风标签（可选）</span>
                        <input
                          value={node.musicTags ?? ""}
                          maxLength={1000}
                          placeholder="例如：city pop, rainy night, female vocal"
                          onChange={(event) => onUpdateNode(node.id, { musicTags: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                      <label className="board-field">
                        <span>排除曲风（可选）</span>
                        <input
                          value={node.musicNegativeTags ?? ""}
                          maxLength={1000}
                          placeholder="例如：heavy metal, rap"
                          onChange={(event) => onUpdateNode(node.id, { musicNegativeTags: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                      <p className="board-inspector-hint">
                        提示词写风格 / 情绪 / 使用场景；Suno 一次可能返回 2 首，配置节点会拆成两张结果卡，媒体节点显示第一首。
                      </p>
                    </>
                  )}
                </>
              ) : isVideo ? (
                <>
                  <label className="board-field">
                    <span>视频方式</span>
                    <select
                      value={node.videoMode ?? ""}
                      onChange={(event) => onUpdateNode(node.id, {
                        videoMode: event.target.value ? event.target.value as NonNullable<typeof node.videoMode> : undefined,
                      } as Partial<BoardNode>)}
                    >
                      {videoModeOptions.map((option) => (
                        <option key={option.value || "auto"} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <p className="board-inspector-hint">
                    自动：1 张图按首帧；连了首帧 + 尾帧按首尾帧；多张按参考图；没有图片按文生视频。
                  </p>
                  <div className="board-inspector-grid">
                    <label className="board-field">
                      <span>时长（秒）</span>
                      <input
                        type="number"
                        min={videoCapability?.durations.min ?? 1}
                        max={videoCapability?.durations.max ?? 30}
                        value={node.durationSeconds ?? videoDefaults.duration}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          onUpdateNode(node.id, {
                            durationSeconds: Number.isFinite(value)
                              ? Math.min(videoCapability?.durations.max ?? 30, Math.max(videoCapability?.durations.min ?? 1, value))
                              : undefined,
                          } as Partial<BoardNode>);
                        }}
                      />
                    </label>
                    <label className="board-field">
                      <span>分辨率</span>
                      <select
                        value={node.resolution ?? videoDefaults.resolution}
                        onChange={(event) => onUpdateNode(node.id, { resolution: event.target.value } as Partial<BoardNode>)}
                      >
                        {videoResolutions.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    </label>
                  </div>
                  {videoCapability?.supportsAudio ? (
                    <label className="board-config-check">
                      <input
                        type="checkbox"
                        checked={node.audio ?? videoDefaults.audio}
                        onChange={(event) => onUpdateNode(node.id, { audio: event.target.checked } as Partial<BoardNode>)}
                      />
                      生成音频
                    </label>
                  ) : null}
                  <details className="board-advanced">
                    <summary>高级参数</summary>
                    <div className="board-inspector-grid">
                      <label className="board-field">
                        <span>随机种子（可选）</span>
                        <input
                          type="number"
                          min={0}
                          value={node.seed ?? ""}
                          placeholder="不填随机"
                          onChange={(event) => onUpdateNode(node.id, {
                            seed: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
                          } as Partial<BoardNode>)}
                        />
                      </label>
                      <label className="board-field">
                        <span>画幅比例（可选）</span>
                        <input
                          value={node.aspectRatio ?? ""}
                          maxLength={20}
                          placeholder="例如 16:9"
                          onChange={(event) => onUpdateNode(node.id, { aspectRatio: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                    </div>
                    <label className="board-config-check">
                      <input
                        type="checkbox"
                        checked={node.promptExtend ?? true}
                        onChange={(event) => onUpdateNode(node.id, { promptExtend: event.target.checked } as Partial<BoardNode>)}
                      />
                      允许模型扩写提示词
                    </label>
                    <label className="board-config-check">
                      <input
                        type="checkbox"
                        checked={node.watermark ?? false}
                        onChange={(event) => onUpdateNode(node.id, { watermark: event.target.checked } as Partial<BoardNode>)}
                      />
                      生成水印
                    </label>
                  </details>
                </>
              ) : (
                <>
                  {sizeMode === "none" ? (
                    <p className="board-inspector-hint">Midjourney 的尺寸由画幅参数决定，这里不单独设置。</p>
                  ) : (
                    <label className="board-field">
                      <span>{sizeMode === "gemini" ? "尺寸（imageSize）" : "尺寸（size）"}</span>
                      <select
                        value={sizeMode === "gemini" ? (node.imageSize ?? "") : (node.size ?? "")}
                        onChange={(event) => {
                          const value = event.target.value;
                          onUpdateNode(node.id, sizeMode === "gemini"
                            ? { imageSize: value ? value as "1K" | "2K" | "4K" : undefined, size: undefined } as Partial<BoardNode>
                            : { size: value || undefined, imageSize: undefined } as Partial<BoardNode>);
                        }}
                      >
                        <option value="">自动</option>
                        {(sizeMode === "gemini" ? GEMINI_SIZES : OPENAI_SIZES).map((value) => (
                          <option key={value} value={value}>{value}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {effectiveAliasInfo?.adapterType !== "midjourney" && effectiveAliasInfo?.adapterType !== "gemini-content" ? (
                    <label className="board-field">
                      <span>质量</span>
                      <select
                        value={node.quality ?? ""}
                        onChange={(event) => onUpdateNode(node.id, { quality: event.target.value || undefined } as Partial<BoardNode>)}
                      >
                        <option value="">自动</option>
                        {QUALITIES.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <details className="board-advanced">
                    <summary>高级参数</summary>
                    <label className="board-field">
                      <span>负向提示词（可选）</span>
                      <textarea
                        rows={3}
                        maxLength={2000}
                        value={node.negativePrompt ?? ""}
                        placeholder="不希望出现的元素，例如：文字、水印、多余手指"
                        onChange={(event) => onUpdateNode(node.id, { negativePrompt: event.target.value || undefined } as Partial<BoardNode>)}
                      />
                    </label>
                    <div className="board-inspector-grid">
                      <label className="board-field">
                        <span>画幅比例（可选）</span>
                        <input
                          value={node.aspectRatio ?? ""}
                          maxLength={20}
                          placeholder="例如 16:9"
                          onChange={(event) => onUpdateNode(node.id, { aspectRatio: event.target.value || undefined } as Partial<BoardNode>)}
                        />
                      </label>
                      <label className="board-field">
                        <span>随机种子（可选）</span>
                        <input
                          type="number"
                          min={0}
                          value={node.seed ?? ""}
                          placeholder="不填随机"
                          onChange={(event) => onUpdateNode(node.id, {
                            seed: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
                          } as Partial<BoardNode>)}
                        />
                      </label>
                      <label className="board-field">
                        <span>风格</span>
                        <select
                          value={node.style ?? ""}
                          onChange={(event) => onUpdateNode(node.id, {
                            style: event.target.value ? event.target.value as "auto" | "vivid" | "natural" : undefined,
                          } as Partial<BoardNode>)}
                        >
                          <option value="">自动</option>
                          <option value="vivid">vivid</option>
                          <option value="natural">natural</option>
                          <option value="auto">auto</option>
                        </select>
                      </label>
                      <label className="board-field">
                        <span>背景</span>
                        <select
                          value={node.background ?? ""}
                          onChange={(event) => onUpdateNode(node.id, {
                            background: event.target.value ? event.target.value as "auto" | "opaque" | "transparent" : undefined,
                          } as Partial<BoardNode>)}
                        >
                          <option value="">自动</option>
                          <option value="transparent">透明</option>
                          <option value="opaque">不透明</option>
                          <option value="auto">auto</option>
                        </select>
                      </label>
                      <label className="board-field">
                        <span>输出格式</span>
                        <select
                          value={node.outputFormat ?? ""}
                          onChange={(event) => onUpdateNode(node.id, {
                            outputFormat: event.target.value ? event.target.value as "png" | "jpeg" | "webp" : undefined,
                          } as Partial<BoardNode>)}
                        >
                          <option value="">自动</option>
                          <option value="png">PNG</option>
                          <option value="jpeg">JPEG</option>
                          <option value="webp">WebP</option>
                        </select>
                      </label>
                      <label className="board-field">
                        <span>审核级别</span>
                        <select
                          value={node.moderation ?? ""}
                          onChange={(event) => onUpdateNode(node.id, {
                            moderation: event.target.value ? event.target.value as "auto" | "low" : undefined,
                          } as Partial<BoardNode>)}
                        >
                          <option value="">自动</option>
                          <option value="low">low</option>
                          <option value="auto">auto</option>
                        </select>
                      </label>
                    </div>
                    <p className="board-inspector-hint">不同渠道支持度不同：不支持的高级参数会被适配器忽略。</p>
                  </details>
                </>
              )}
                </>
              )}
            </section>

            <section className={`board-inspector-section ${isVideo || isText ? "" : "board-inspector-grid"}`}>
              {isConfig ? (
                <label className="board-field">
                  <span>模式</span>
                  <select
                    value={node.mode}
                    disabled={node.status === "loading"}
                    title={node.status === "loading" ? "生成中不能切换模式" : undefined}
                    onChange={(event) => {
                      const nextMode = event.target.value as "image" | "video";
                      onUpdateNode(node.id, {
                        mode: nextMode,
                        // 生图 / 视频模型不通用，切模式时清掉另一方参数
                        model: undefined,
                        channelId: undefined,
                        size: undefined,
                        imageSize: undefined,
                        quality: undefined,
                        videoMode: undefined,
                        durationSeconds: undefined,
                        resolution: undefined,
                        audio: undefined,
                        audioKind: "speech",
                        voice: undefined,
                        ttsStyle: undefined,
                        instrumental: undefined,
                        lastTaskId: undefined,
                        status: "idle",
                        error: undefined,
                      } as Partial<BoardNode>);
                    }}
                  >
                    <option value="image">生图</option>
                    <option value="video">生视频</option>
                    <option value="text">生文本</option>
                    <option value="audio">生音频</option>
                  </select>
                </label>
              ) : (
                <label className="board-field">
                  <span>类型</span>
                  <input
                    value={isVideo ? "视频（就地生成）" : isAudio ? (audioKind === "music" ? "音乐（就地生成）" : "配音（就地生成）") : "图片（就地生成）"}
                    readOnly
                  />
                </label>
              )}
              {isConfig && !isVideo && !isText && !isAudio ? (
                <label className="board-field">
                  <span>张数</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={node.count}
                    onChange={(event) => {
                      const count = Math.min(8, Math.max(1, Number(event.target.value) || 1));
                      onUpdateNode(node.id, { count } as Partial<BoardNode>);
                    }}
                  />
                </label>
              ) : null}
            </section>
            <section className="board-inspector-section">
              <div className="board-inspector-actions">
                {isConfig && node.status === "loading" && node.lastTaskId ? (
                  <button type="button" className="secondary-button compact" onClick={() => onStopTask(node.lastTaskId!)}>
                    停止
                  </button>
                ) : null}
                {isConfig && (node.status === "failed" || node.status === "cancelled") && node.lastTaskId ? (
                  <button type="button" className="secondary-button compact" onClick={() => onRetryTask(node.lastTaskId!)}>
                    <RefreshCw size={12} />重试
                  </button>
                ) : null}
                <button
                  type="button"
                  className="primary-button compact board-generate"
                  disabled={node.status === "loading" || generateBlocked || (!textDraft.trim() && upstreamText.length === 0)}
                  title={node.status === "loading"
                    ? "正在生成…"
                    : generateBlocked
                      ? (isAudio ? "还没有可用的音频渠道" : isVideo ? "还没有可用的视频渠道" : "还没有可用的生图渠道")
                      : "按上游文本 / 图片生成"}
                  onClick={() => onGenerate(node.id)}
                >
                  {node.status === "loading"
                    ? "生成中…"
                    : !isConfig && !isText && node.assetId ? "重新生成"
                    : isVideo ? "生成视频"
                      : isText ? "生成文本"
                        : isAudio ? (audioKind === "music" ? "生成音乐" : "生成配音")
                          : "生成"}
                </button>
              </div>
            </section>
          </>
        ) : null}
      </div>

      <footer className="board-inspector-foot">
        <button type="button" className="secondary-button compact is-danger" onClick={() => onDeleteNode(node.id)}>
          <Trash2 size={12} />删除节点
        </button>
      </footer>
    </aside>
  );
}
