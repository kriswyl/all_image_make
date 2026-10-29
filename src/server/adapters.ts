import type { DbChannel } from "./db.js";
import type { GenerationInput, KlingVideoMode } from "../shared/types.js";
import { TTS_DEFAULT_VOICE } from "../shared/tts.js";
import { defaultEndpointFor } from "../shared/adapter-endpoints.js";
import { assertEndpoint, joinEndpoint, redactHeaders, safeFetch } from "./security.js";

export interface PreparedRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  formData?: FormData;
  diagnosticBody?: Record<string, unknown>;
  allowPrivateNetwork: boolean;
  /** 等待远端响应的超时时长（毫秒） */
  timeoutMs?: number;
}

export interface ImageCandidate {
  url?: string;
  base64?: string;
  mimeType?: string;
}

export interface VideoCandidate {
  url: string;
  duration?: number;
  /**
   * 字段名带 video，或地址本身就是视频扩展名。
   * 中转生成完却不更新 status 时，只有这类候选能单独作为“已经生成好”的依据，
   * 避免把封面图之类的弱候选（cover_url、thumbnail.url）当成成品。
   */
  strong?: boolean;
}

export class RemoteApiError extends Error {
  constructor(public status: number, public payload: unknown, message = "中转接口返回错误") {
    super(message);
  }
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

/**
 * 带蒙版时自动补一句约束。
 *
 * mask 是**引导式**编辑，不是 DALL·E 2 那种像素级硬约束：中转站背后的模型
 * 可能只把它当区域提示，仍会按提示词改动蒙版外。明确写一次「只改蒙版区域」，
 * 能把这类整图重画压下去；真正的像素级保证不做，避免让用户误以为蒙版外绝不会变。
 */
const MASK_PROMPT_SUFFIX = "\n\n只修改蒙版标记的区域；蒙版以外的画面保持完全不变。用户对颜色、材质或物体的描述只作用于蒙版区域内的对象，不要应用到蒙版外的相似物体上；不要重新绘制整张图。";

function withMaskInstruction(prompt: string) {
  return `${prompt}${MASK_PROMPT_SUFFIX}`;
}


function openAiImageParameters(input: GenerationInput) {
  return compact({
    negative_prompt: input.negativePrompt,
    size: input.size,
    n: input.count,
    quality: input.quality,
    output_format: input.outputFormat,
    background: input.background,
    moderation: input.moderation,
    style: input.style,
    response_format: input.responseFormat,
    stream: input.stream,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageDataUrl(input: NonNullable<GenerationInput["referenceImage"]>) {
  return `data:${input.mimeType};base64,${input.base64}`;
}

function referenceImages(input: GenerationInput) {
  return input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
}

function imageSummary(input: { base64: string; mimeType: string; fileName: string }) {
  return { fileName: input.fileName, mimeType: input.mimeType, byteSize: Buffer.byteLength(input.base64, "base64") };
}

function buildWanMedia(input: GenerationInput, references: NonNullable<GenerationInput["referenceImages"]>) {
  // 优先使用 wanVideoMedia（前端模式选择器构造的）
  if (input.wanVideoMedia?.length) {
    return input.wanVideoMedia;
  }
  // 降级：兼容旧的 referenceImages（全部标记为 reference_image）
  if (references.length) {
    return references.map((ref) => ({
      type: "reference_image" as const,
      url: imageDataUrl(ref),
    }));
  }
  return [];
}

function appendFormValue(formData: FormData, key: string, value: unknown) {
  if (value === undefined || value === "") return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    formData.append(key, String(value));
    return;
  }
  formData.append(key, JSON.stringify(value));
}

function summarizeImageData(value: unknown): unknown {
  if (typeof value === "string" && /^data:audio\/[^;]+;base64,/i.test(value)) {
    return `[AUDIO_DATA ${Buffer.byteLength(value.slice(value.indexOf(",") + 1), "base64")} bytes]`;
  }
  if (typeof value === "string" && /^data:image\/[^;]+;base64,/i.test(value)) {
    const base64 = value.slice(value.indexOf(",") + 1);
    return `[IMAGE_DATA ${Buffer.byteLength(base64, "base64")} bytes]`;
  }
  if (typeof value === "string" && /^[A-Za-z0-9+/]{64,}={0,2}$/.test(value)) {
    return `[IMAGE_DATA ${Buffer.byteLength(value, "base64")} bytes]`;
  }
  if (Array.isArray(value)) return value.map(summarizeImageData);
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  const containsInlineImage = typeof value.mimeType === "string" && value.mimeType.startsWith("image/") && typeof value.data === "string";
  for (const [key, item] of Object.entries(value)) {
    output[key] = containsInlineImage && key === "data"
      ? `[IMAGE_DATA ${Buffer.byteLength(String(item), "base64")} bytes]`
      : summarizeImageData(item);
  }
  return output;
}

function geminiGenerationConfig(input: GenerationInput, raw: Record<string, unknown>) {
  const rawConfig = isRecord(raw.generationConfig) ? raw.generationConfig : {};
  const rawImageConfig = isRecord(rawConfig.imageConfig) ? rawConfig.imageConfig : {};
  const { imageConfig: _rawImageConfig, ...rawConfigWithoutImage } = rawConfig;
  const imageConfig = compact({
    aspectRatio: input.aspectRatio,
    imageSize: input.imageSize,
    ...rawImageConfig,
  });
  return {
    ...compact({
      candidateCount: input.count,
      temperature: input.temperature,
      topP: input.topP,
      topK: input.topK,
      maxOutputTokens: input.maxOutputTokens,
      responseModalities: input.responseModalities ?? ["IMAGE"],
      seed: input.seed,
    }),
    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    ...rawConfigWithoutImage,
  };
}

export function defaultEndpoint(adapterType: DbChannel["adapterType"]) {
  return defaultEndpointFor(adapterType);
}

/** Suno 各模式支持的 mv 不同，缺省值也跟着模式走 */
function sunoDefaultVersion(mode: string) {
  switch (mode) {
    case "cover":
    case "playlist": return "chirp-v3-5-tau";
    case "mashup":
    case "sound":
    case "sample": return "chirp-crow";
    default: return "chirp-v3-5";
  }
}

/** 大脑调用（brain.ts）复用同一套鉴权，避免两处逻辑漂移 */
export function applyAuth(url: string, headers: Record<string, string>, channel: DbChannel, key: string) {
  if (channel.authType === "none") return url;
  if (!key) throw new Error("该渠道尚未配置 API Key");
  if (channel.authType === "bearer") headers.Authorization = `Bearer ${key}`;
  if (channel.authType === "x-api-key") headers[ channel.authHeaderName || "x-api-key" ] = key;
  if (channel.authType === "custom-header") headers[channel.authHeaderName || "x-api-key"] = key;
  if (channel.authType === "query") {
    const parsed = new URL(url);
    parsed.searchParams.set(channel.authHeaderName || "key", key);
    return parsed.toString();
  }
  return url;
}

/** 把带「A：」「B：」标签的正文切成逐说话人的 part */
function splitSpeakerParts(text: string): Array<{ speaker: "A" | "B"; text: string }> {
  const parts: Array<{ speaker: "A" | "B"; text: string }> = [];
  // 支持换行分段，也支持「A：你好。B：你好。」这种同一行写法
  const pattern = /(^|\n|(?<=[。！？!?；;]))\s*([AB])\s*[：:]\s*/g;
  let speaker: "A" | "B" | null = null;
  let lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const chunk = text.slice(lastIndex, match.index).trim();
    if (speaker && chunk) parts.push({ speaker, text: chunk });
    speaker = match[2] as "A" | "B";
    lastIndex = pattern.lastIndex;
  }
  const tail = text.slice(lastIndex).trim();
  if (speaker && tail) parts.push({ speaker, text: tail });
  return parts;
}

/** 没显式给模式时，按素材反推一个最合理的模式 */
function resolveKlingMode(input: GenerationInput): KlingVideoMode {
  return input.klingVideoMode
    ?? (input.klingVideoMedia?.some((item) => item.type === "reference_image")
      ? "reference"
      : input.klingVideoMedia?.length ? "first-frame" : "text-to-video");
}

/**
 * 可灵原生端点。模型固定在路径里，body 不带 model。
 * 文档按模型开放能力：运动控制只有 kling-3.0，首尾帧/参考图只有 omni。
 */
function klingEndpoint(model: string, mode: KlingVideoMode) {
  const encoded = encodeURIComponent(model);
  if (mode === "motion-control") {
    if (/omni|turbo/i.test(model)) throw new Error("运动控制只支持 kling-3.0，不能用于 Omni / Turbo 模型");
    return `/motion-control/${encoded}`;
  }
  if (/omni/i.test(model)) return `/omni-video/${encoded}`;
  if (mode === "reference") {
    throw new Error("参考图生成只支持 kling-3.0-omni 模型");
  }
  // 文档说尾帧暂未开放，实测 /image-to-video 能接 first_frame + last_frame
  if (mode === "first-frame" || mode === "first-last-frame") return `/image-to-video/${encoded}`;
  return `/text-to-video/${encoded}`;
}

/** MJ 的宽高比/负面词都写在提示词里，没有独立字段 */
function midjourneyPrompt(input: GenerationInput) {
  let prompt = input.prompt.trim();
  if (!/--\s*ar\s+\S+/i.test(prompt) && input.aspectRatio && input.aspectRatio !== "auto") {
    prompt += ` --ar ${input.aspectRatio}`;
  }
  if (input.midjourneyVersion?.trim() && !/--\s*v\s+\S+/i.test(prompt)) {
    prompt += ` --v ${input.midjourneyVersion.trim()}`;
  }
  if (input.negativePrompt?.trim() && !/--\s*no\s+/i.test(prompt)) {
    prompt += ` --no ${input.negativePrompt.trim()}`;
  }
  return prompt;
}

export function buildGenerationRequest(channel: DbChannel, input: GenerationInput, key: string): PreparedRequest {
  const references = referenceImages(input);
  let endpoint = channel.endpoint || defaultEndpoint(channel.adapterType);
  if (references.length && channel.adapterType === "openai-images"
    && (!channel.endpoint || channel.endpoint === defaultEndpoint(channel.adapterType))) {
    endpoint = "/v1/images/edits";
  }
  if (channel.adapterType === "kling-video") {
    endpoint = klingEndpoint(input.model, resolveKlingMode(input));
  }
  if (channel.adapterType === "midjourney") {
    endpoint = input.midjourneyAction
      ? "/mj/submit/action"
      : references.length ? "/mj/submit/edits" : "/mj/submit/imagine";
  }
  endpoint = endpoint.replaceAll("{model}", encodeURIComponent(input.model));
  assertEndpoint(endpoint);
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: Record<string, unknown> | undefined;
  let formData: FormData | undefined;
  let diagnosticBody: Record<string, unknown> | undefined;
  const raw = input.rawParameters ?? {};

  if (channel.adapterType === "wan-video") {
    // 万相视频生成必须启用异步，否则会超时
    headers["X-DashScope-Async"] = "enable";

    const media = buildWanMedia(input, references);
    // 文档要求：传入 file 或 link 素材时 prompt_extend 必须为 true
    const forcePromptExtend = media.some((item) => item.type === "file" || item.type === "link");

    body = {
      model: input.model,
      input: compact({
        prompt: input.prompt,
        ...(media.length ? { media } : {}),
      }),
      parameters: compact({
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.duration,
        audio: input.audio,
        prompt_extend: forcePromptExtend ? true : input.promptExtend,
        seed: input.seed,
        watermark: input.watermark,
        ...raw,
      }),
    };
  } else if (channel.adapterType === "grok-video") {
    body = compact({
      model: input.model,
      prompt: input.prompt,
      duration: input.duration ?? 8,
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      ...(references.length ? {
        reference_images: references.map((ref) => ({
          url: imageDataUrl(ref),
        })),
      } : {}),
      ...raw,
    });
  } else if (channel.adapterType === "seedance-video") {
    const content: Array<{ type: string; text?: string; image_url?: { url: string }; role?: string }> = [];
    if (input.prompt) {
      content.push({ type: "text", text: input.prompt });
    }
    if (input.seedanceVideoMedia && input.seedanceVideoMedia.length) {
      input.seedanceVideoMedia.forEach((media) => {
        if (media.type === "image_url") {
          content.push({
            type: "image_url",
            image_url: { url: media.url },
            ...(media.role ? { role: media.role } : {}),
          });
        }
      });
    }
    body = compact({
      model: input.model,
      content,
      resolution: input.resolution,
      ratio: input.ratio,
      duration: input.duration,
      generate_audio: input.audio ?? false,
      seed: input.seed,
      watermark: input.watermark,
      ...raw,
    });
  } else if (channel.adapterType === "kling-video") {
    const media = input.klingVideoMedia ?? [];
    const omni = /omni/i.test(input.model);
    const mode = resolveKlingMode(input);
    if (mode === "motion-control" && input.resolution === "4k") {
      throw new Error("运动控制最高支持 1080p，没有 4K 档");
    }

    const settings = compact({
      resolution: input.resolution || "720p",
      // 运动控制的时长由参考视频决定，文档里没有 duration
      duration: mode === "motion-control" ? undefined : input.duration ?? 5,
      // 图生视频与运动控制的文档没有 aspect_ratio
      aspect_ratio: mode === "motion-control" || (!omni && mode !== "text-to-video")
        ? undefined
        : input.aspectRatio || "16:9",
      // 运动控制只认 original / off，其余模式是 native / off
      audio: mode === "motion-control"
        ? (input.audio === false ? "off" : "original")
        : (input.audio ? "native" : "off"),
      multi_shot: mode === "motion-control" ? undefined : input.klingMultiShot ?? true,
      character_orientation: mode === "motion-control"
        ? input.klingCharacterOrientation ?? "video"
        : undefined,
    });
    const options = compact({
      watermark_info: { enabled: input.watermark ?? false },
    });

    let contents: Array<Record<string, unknown>> | undefined;
    if (mode === "motion-control") {
      const image = media.find((item) => item.type === "image");
      const video = media.find((item) => item.type === "video");
      if (!image) throw new Error("运动控制需要一张角色图片");
      if (!video) throw new Error("运动控制需要参考视频的公网地址");
      contents = [
        ...(input.prompt ? [{ type: "prompt", text: input.prompt }] : []),
        { type: "image", url: image.url },
        { type: "video", url: video.url },
      ];
    } else if (omni || mode === "first-frame" || mode === "first-last-frame") {
      if (!omni) {
        if (mode === "first-frame" && (media.length !== 1 || media[0]?.type !== "first_frame")) {
          throw new Error("首帧生视频需要且只需要 1 张首帧图");
        }
        if (mode === "first-last-frame" && (
          media.length !== 2
          || media[0]?.type !== "first_frame"
          || media[1]?.type !== "last_frame"
        )) {
          throw new Error("首尾帧生视频需要按顺序提供 1 张首帧和 1 张尾帧");
        }
        if (media.some((item) => item.type !== "first_frame" && item.type !== "last_frame")) {
          throw new Error("普通图生视频不支持参考图；请改用 kling-3.0-omni");
        }
      }
      contents = [
        ...(input.prompt ? [{ type: "prompt", text: input.prompt }] : []),
        ...media.map((item) => ({
          type: item.type === "reference_image" ? "refer_image" : item.type,
          url: item.url,
        })),
      ];
    }

    body = contents
      ? compact({ contents, settings, options, ...raw })
      : compact({ prompt: input.prompt, settings, options, ...raw });
  } else if (channel.adapterType === "suno-music") {
    // 文档的部分音乐接口要求 New-Api-User；补上不影响已验证的灵感/自定义模式
    headers["New-Api-User"] = "1";
    const mode = input.musicMode ?? "inspiration";
    const mv = input.musicVersion?.trim() || sunoDefaultVersion(mode);
    const instrumental = input.musicInstrumental ?? false;
    const customMetadata = { create_mode: "custom" as const };

    if (mode === "custom" && !input.musicTags?.trim()) {
      throw new Error("自定义模式需要填写曲风（tags）");
    }
    if (mode === "cover" && !input.musicCoverClipId?.trim()) {
      throw new Error("翻唱模式需要选择一首源歌曲");
    }
    if (mode === "mashup") {
      const ids = input.musicMashupClipIds ?? [];
      if (ids.length !== 2 || !ids[0]?.trim() || !ids[1]?.trim() || ids[0] === ids[1]) {
        throw new Error("混音模式需要选择两首不同的歌曲");
      }
    }

    if (mode === "custom") {
      body = compact({
        prompt: input.prompt,
        tags: input.musicTags,
        negative_tags: input.musicNegativeTags,
        mv,
        title: input.musicTitle,
        make_instrumental: instrumental,
        ...raw,
      });
    } else if (mode === "cover") {
      body = compact({
        task: "cover",
        prompt: input.prompt,
        mv,
        cover_clip_id: input.musicCoverClipId,
        metadata: customMetadata,
        ...raw,
      });
    } else if (mode === "mashup") {
      body = compact({
        task: "mashup_condition",
        generation_type: "TEXT",
        title: input.musicTitle,
        mv,
        prompt: input.prompt,
        make_instrumental: instrumental,
        metadata: customMetadata,
        mashup_clip_ids: input.musicMashupClipIds,
        ...raw,
      });
    } else if (mode === "sound") {
      body = compact({
        task: "sound",
        generation_type: "TEXT",
        title: input.musicTitle,
        tags: input.musicTags,
        negative_tags: input.musicNegativeTags,
        mv,
        prompt: "",
        // 音效一定是纯音乐，和文档示例保持一致
        make_instrumental: true,
        metadata: {
          ...customMetadata,
          sound_configs: {
            user_tempo: input.musicSoundConfigs?.tempo ?? 99,
            user_key: input.musicSoundConfigs?.key?.trim() || "C",
            user_loop: input.musicSoundConfigs?.loop ?? false,
          },
        },
        ...raw,
      });
    } else if (mode === "playlist") {
      body = compact({
        task: "playlist_condition",
        generation_type: "TEXT",
        mv,
        prompt: input.prompt,
        make_instrumental: instrumental,
        metadata: customMetadata,
        ...raw,
      });
    } else if (mode === "sample") {
      body = compact({
        task: "chop_sample_condition",
        generation_type: "TEXT",
        mv,
        prompt: input.prompt,
        make_instrumental: instrumental,
        metadata: customMetadata,
        ...raw,
      });
    } else {
      body = compact({
        gpt_description_prompt: input.prompt,
        mv,
        make_instrumental: instrumental,
        ...raw,
      });
    }
  } else if (channel.adapterType === "openai-images" && references.length) {
    /**
     * 显式蒙版优先于 `rawParameters.mask`。
     *
     * 两个都发会让上游收到两个同名 part，行为取决于中转站怎么解析；而「高级 JSON 里写了个
     * 字符串 mask」是给旧用法留的逃生口，不应该盖住用户在画布上亲手涂抹的那张图。
     * 同时只接受 1 张参考图：OpenAI 的 mask 只作用于第一张图，多图配一张蒙版会让用户
     * 以为其余几张也被局部编辑了。
     */
    const mask = input.maskImage && references.length === 1 ? input.maskImage : undefined;
    const rawFields = mask && Object.hasOwn(raw, "mask")
      ? Object.fromEntries(Object.entries(raw).filter(([field]) => field !== "mask"))
      : raw;
    const fields = compact({
      model: input.model,
      prompt: mask ? withMaskInstruction(input.prompt) : input.prompt,
      ...openAiImageParameters(input),
      ...rawFields,
    });
    formData = new FormData();
    for (const [field, value] of Object.entries(fields)) {
      if (field !== "image" && field !== "image[]" && field !== "mask") appendFormValue(formData, field, value);
    }
    if (Object.hasOwn(fields, "image") || Object.hasOwn(fields, "image[]")) {
      if (Object.hasOwn(fields, "image")) appendFormValue(formData, "image", fields.image);
      else appendFormValue(formData, "image[]", fields["image[]"]);
    } else {
      const fieldName = references.length > 1 ? "image[]" : "image";
      for (const reference of references) {
        const bytes = Buffer.from(reference.base64, "base64");
        formData.append(fieldName, new Blob([Uint8Array.from(bytes)], { type: reference.mimeType }), reference.fileName);
      }
    }
    if (mask) {
      const bytes = Buffer.from(mask.base64, "base64");
      const maskFileName = mask.fileName.toLowerCase().endsWith(".png") ? mask.fileName : "mask.png";
      formData.append("mask", new Blob([Uint8Array.from(bytes)], { type: "image/png" }), maskFileName);
    } else if (Object.hasOwn(fields, "mask")) {
      // 老用法：rawParameters 里的 mask 当文本字段发出去，行为保持不变
      appendFormValue(formData, "mask", fields.mask);
    }
    const rawImageField = Object.hasOwn(fields, "image") ? "image" : Object.hasOwn(fields, "image[]") ? "image[]" : undefined;
    const rawImage = rawImageField ? summarizeImageData(fields[rawImageField]) : undefined;
    const diagnosticFields = Object.fromEntries(Object.entries(fields).filter(([field]) => field !== "image" && field !== "image[]" && field !== "mask"));
    diagnosticBody = {
      ...diagnosticFields,
      ...(mask
        ? { mask: imageSummary(mask) }
        : Object.hasOwn(fields, "mask")
          ? { mask: summarizeImageData(fields.mask) }
          : {}),
      ...(rawImageField ? { [rawImageField]: rawImage } : references.length > 1 ? { "image[]": references.map(imageSummary) } : { image: imageSummary(references[0]) }),
    };
  } else if (channel.adapterType === "openai-chat-image") {
    const content = references.length
      ? [{ type: "text", text: input.prompt }, ...references.map((reference) => ({ type: "image_url", image_url: { url: imageDataUrl(reference) } }))]
      : input.prompt;
    body = {
      model: input.model,
      messages: [{ role: "user", content }],
      ...openAiImageParameters(input),
      ...raw,
    };
  } else if (channel.adapterType === "gemini-content") {
    const text = input.negativePrompt ? `${input.prompt}\n\nNegative prompt: ${input.negativePrompt}` : input.prompt;
    const { generationConfig: _rawGenerationConfig, ...rawBody } = raw;
    const parts: Array<Record<string, unknown>> = references.length
      ? [...references.map((reference) => ({ inlineData: { mimeType: reference.mimeType, data: reference.base64 } })), { text }]
      : [{ text }];
    body = {
      contents: [{ role: "user", parts }],
      generationConfig: geminiGenerationConfig(input, raw),
      ...rawBody,
    };
  } else if (channel.adapterType === "gemini-tts") {
    if (references.length) throw new Error("TTS 不支持参考图，请只提交文本");
    const speakers = (input.ttsSpeakers ?? []).filter((item) => item.speaker.trim() && item.voice.trim());
    if (input.ttsSpeakers?.length && speakers.length !== 2) {
      throw new Error("双人对话必须正好提供 2 个说话人音色");
    }
    const style = input.ttsStyle?.trim();
    /**
     * 单人：一个 text part，风格放 annotations。
     *
     * 双人：3.8 实测要求每个 text part 都带 `speech_metadata.speaker`；
     * 把整段「A：… B：…」塞进一个 part 会被 400 拒绝。所以先按 A/B 标签切段，
     * 每段一个 part，annotations 里同时写 speaker 和 style。
     */
    const speakerParts = speakers.length === 2 ? splitSpeakerParts(input.prompt) : [];
    if (speakers.length === 2 && (!speakerParts.some((item) => item.speaker === "A")
      || !speakerParts.some((item) => item.speaker === "B"))) {
      throw new Error("双人对话正文需要用「A：」「B：」标出两个说话人的台词");
    }
    const parts = speakers.length === 2
      ? speakerParts.map((item) => ({
        text: item.text,
        annotations: [{ type: "speech_metadata", speaker: item.speaker, ...(style ? { style } : {}) }],
      }))
      : [compact({
        text: input.prompt,
        // style 必须放在 annotations 里；写进正文有被念出来的风险
        annotations: style ? [{ type: "speech_metadata", style }] : undefined,
      })];
    const speechConfig = compact({
      ...(input.ttsLanguage?.trim() ? { languageCode: input.ttsLanguage.trim() } : {}),
      ...(speakers.length === 2
        ? {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: speakers.map((item) => ({
              speaker: item.speaker.trim(),
              voiceConfig: { prebuiltVoiceConfig: { voiceName: item.voice.trim() } },
            })),
          },
        }
        : {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: input.ttsVoice?.trim() || TTS_DEFAULT_VOICE },
          },
        }),
    });
    body = compact({
      contents: [{ role: "user", parts }],
      // 文档实测：只认 AUDIO；不要传 maxOutputTokens，会截断音频
      generationConfig: { responseModalities: ["AUDIO"], speechConfig },
      ...raw,
    });
  } else if (channel.adapterType === "midjourney") {
    if (!input.midjourneyAction && input.model === "mj_edits" && !references.length) {
      throw new Error("mj_edits 需要 1 张参考图；纯文生图请用 mj_imagine");
    }
    if (input.midjourneyAction) {
      body = compact({
        taskId: input.midjourneyAction.taskId,
        customId: input.midjourneyAction.customId,
        ...raw,
      });
    } else if (references.length) {
      // edits 只认 image；实测 base64Array 会被上游当成没传图
      body = compact({
        prompt: midjourneyPrompt(input),
        image: imageDataUrl(references[0]!),
        ...raw,
      });
    } else {
      body = compact({ prompt: midjourneyPrompt(input), ...raw });
    }
  } else {
    const referencePayload = references.length === 1 ? { image: imageDataUrl(references[0]) } : references.length > 1 ? { images: references.map(imageDataUrl) } : {};
    body = compact({
      model: input.model,
      prompt: input.prompt,
      ...openAiImageParameters(input),
      ...referencePayload,
      ...raw,
    });
  }

  if (body) headers["Content-Type"] = "application/json";
  let url = joinEndpoint(channel.baseUrl, endpoint);
  url = applyAuth(url, headers, channel, key);
  return {
    url, method: "POST", headers, body, formData, diagnosticBody,
    allowPrivateNetwork: channel.allowPrivateNetwork,
    timeoutMs: normalizeTimeout(input.timeoutMs),
  };
}

export const MIN_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_TIMEOUT_MS = 180_000;

/** 超时时长约束在 10 秒到 30 分钟之间，缺省沿用原有的 180 秒 */
export function normalizeTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs == null) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(timeoutMs)));
}


export function buildConnectionTestRequest(channel: DbChannel, key: string): PreparedRequest {
  const endpoint = channel.adapterType === "gemini-content" ? "/v1beta/models" : channel.adapterType.startsWith("openai-") ? "/v1/models" : "/";
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = joinEndpoint(channel.baseUrl, endpoint);
  url = applyAuth(url, headers, channel, key);
  return { url, method: "GET", headers, allowPrivateNetwork: channel.allowPrivateNetwork };
}

export function requestForDiagnostic(request: PreparedRequest) {
  const parsed = new URL(request.url);
  for (const key of ["key", "api_key", "token"]) if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[REDACTED]");
  return {
    url: parsed.toString(),
    method: request.method,
    headers: redactHeaders(request.headers),
    body: request.diagnosticBody ?? summarizeImageData(request.body ?? null),
  };
}

export async function sendPreparedRequest(request: PreparedRequest) {
  const started = Date.now();
  const response = await safeFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.formData ?? (request.body ? JSON.stringify(request.body) : undefined),
    ...(request.timeoutMs ? { signal: AbortSignal.timeout(request.timeoutMs) } : {}),
  }, { allowPrivateNetwork: request.allowPrivateNetwork });
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown;
  if (contentType.startsWith("image/")) {
    payload = { directImage: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: contentType.split(";")[0] };
  } else {
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text: text.slice(0, 50000) }; }
  }
  const durationMs = Date.now() - started;
  if (!response.ok) throw new RemoteApiError(response.status, payload, extractErrorMessage(payload));
  return { payload, status: response.status, durationMs };
}

/** 上游的英文错误里，mask 不支持这一类翻成人话；其余原样保留 */
function translateMaskError(message: string) {
  if (/mask/i.test(message) && /not\s*supported|unsupported|not\s*support/i.test(message)) {
    return "当前渠道的这个模型不支持局部重绘（mask），请换用其他模型或去掉蒙版";
  }
  return message;
}

/**
 * 从中转站的错误响应里抠出一句人话。
 *
 * 以前只认 `message` / `error.message`，其余形状一律退化成常量「中转接口返回错误」——
 * 用户在界面上因此看不到任何线索，只能反复描述「它说参数没带上」。
 * 现在把常见的几种形状都认掉，最后再兜一个 JSON 片段，宁长勿丢。
 */
function extractErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return "中转接口返回错误";
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message) return translateMaskError(record.message);
  const nested = record.error;
  if (nested && typeof nested === "object") {
    const inner = nested as Record<string, unknown>;
    if (typeof inner.message === "string" && inner.message) return translateMaskError(inner.message);
    // 有的站点只回 code / status，把这半句也留下，好过换成一句常量
    if (typeof inner.code === "string" || typeof inner.code === "number") return `上游错误 ${inner.code}`;
    if (typeof inner.status === "string") return `上游错误 ${inner.status}`;
  }
  if (typeof nested === "string" && nested) return translateMaskError(nested);
  // 非 JSON 的响应体被上游包成 { text }，原文比常量有用得多
  if (typeof record.text === "string" && record.text.trim()) return translateMaskError(record.text.trim().slice(0, 300));
  if (typeof record.code === "string" || typeof record.code === "number") return `上游错误 ${record.code}`;
  try {
    const text = JSON.stringify(record);
    if (text && text !== "{}") return translateMaskError(`上游返回了无法识别的错误：${text.slice(0, 300)}`);
  } catch {
    // 循环引用之类，退回常量
  }
  return "中转接口返回错误";
}

function looksLikeBase64(value: string) {
  return value.length > 128 && /^[A-Za-z0-9+/=_\r\n-]+$/.test(value);
}

function addCandidate(target: ImageCandidate[], seen: Set<string>, candidate: ImageCandidate) {
  const identity = candidate.url ?? candidate.base64?.slice(0, 80);
  if (!identity || seen.has(identity)) return;
  seen.add(identity);
  target.push(candidate);
}

export function extractImageCandidates(payload: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown, parentKey = "", depth = 0, mimeType?: string) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && /url|image|output|result/i.test(parentKey)) addCandidate(candidates, seen, { url: value });
      if (/^data:image\//i.test(value)) {
        const match = value.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) addCandidate(candidates, seen, { mimeType: match[1], base64: match[2] });
      } else if (looksLikeBase64(value) && /b64|base64|data|image/i.test(parentKey)) {
        addCandidate(candidates, seen, { base64: value, mimeType });
      }
      const markdown = value.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/i);
      if (markdown) addCandidate(candidates, seen, { url: markdown[1] });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, parentKey, depth + 1, mimeType));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const nextMime = typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : mimeType;
    if (typeof record.b64_json === "string") addCandidate(candidates, seen, { base64: record.b64_json, mimeType: nextMime });
    if (typeof record.url === "string" && (/image|output|result|data/i.test(parentKey) || Object.keys(record).length <= 4)) {
      addCandidate(candidates, seen, { url: record.url });
    }
    if (record.image_url && typeof record.image_url === "object" && typeof (record.image_url as Record<string, unknown>).url === "string") {
      addCandidate(candidates, seen, { url: String((record.image_url as Record<string, unknown>).url) });
    }
    for (const [key, item] of Object.entries(record)) walk(item, key, depth + 1, nextMime);
  };

  walk(payload);
  return candidates;
}

/** 给裸 PCM 补一个 44 字节 WAV 头；3.1 preview 实测返回 audio/l16，不补浏览器放不了 */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface AudioCandidate {
  /** data:audio/wav;base64,... 或公网音频地址 */
  url: string;
  mimeType?: string;
  duration?: number;
  title?: string;
}

/**
 * Gemini TTS 的响应是 `candidates[].content.parts[].inlineData`：
 * 音频以 base64 内联在 JSON 里，不是可下载的 URL。
 * 统一转成 data URI，后面的音频保存逻辑就能和 Suno 共用同一套。
 */
export function extractAudioCandidates(payload: unknown): AudioCandidate[] {
  const candidates = (payload && typeof payload === "object")
    ? (payload as Record<string, unknown>).candidates
    : null;
  const list = Array.isArray(candidates)
    ? candidates
    : candidates && typeof candidates === "object" ? [candidates] : [];
  const results: AudioCandidate[] = [];
  const seen = new Set<string>();

  const push = (url: string, mimeType?: string, title?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({ url, ...(mimeType ? { mimeType } : {}), ...(title ? { title } : {}) });
  };

  for (const candidate of list) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = (candidate as Record<string, unknown>).content;
    const parts = content && typeof content === "object"
      ? (content as Record<string, unknown>).parts
      : null;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      const inline = record.inlineData ?? record.inline_data;
      if (!inline || typeof inline !== "object") continue;
      const data = (inline as Record<string, unknown>).data;
      if (typeof data !== "string" || !data) continue;
      const mimeType = typeof (inline as Record<string, unknown>).mimeType === "string"
        ? String((inline as Record<string, unknown>).mimeType)
        : typeof (inline as Record<string, unknown>).mime_type === "string"
          ? String((inline as Record<string, unknown>).mime_type)
          : "audio/wav";
      /*
       * Gemini 的图片也走 inlineData。以前这里不看 mimeType，只要是 inlineData
       * 就当成音频交给 saveAudios：图片能被存下来，但文件名叫 `xxx.m4a`、
       * 没有缩略图，下载下来还打不开。音频候选必须真的以 audio/ 开头。
       */
      if (!/^audio\//i.test(mimeType) && !/^data:audio\//i.test(data)) continue;
      // 3.1 preview 即使非流式也返回裸 PCM（audio/l16; rate=...; channels=...）
      if (/audio\/(?:l16|pcm)/i.test(mimeType) && !data.startsWith("data:")) {
        const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24_000);
        const channels = Number(/channels=(\d+)/i.exec(mimeType)?.[1] ?? 1);
        const pcm = Buffer.from(data, "base64");
        const wav = pcmToWav(pcm, Number.isFinite(rate) ? rate : 24_000, Number.isFinite(channels) ? channels : 1);
        push(`data:audio/wav;base64,${wav.toString("base64")}`, "audio/wav");
        continue;
      }
      push(data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`, mimeType);
    }
  }
  return results;
}

/** 视频地址常见的字段名：顶层 video_url、嵌套 video.url、万相的 output.video_url 等 */
const VIDEO_KEY_PATTERN = /video|url|output|result|media|download/i;
const VIDEO_EXTENSION_PATTERN = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;

export function extractVideoCandidates(payload: unknown): VideoCandidate[] {
  const candidates: VideoCandidate[] = [];
  const seen = new Set<string>();

  /** 字段名带 video、或地址带视频扩展名，才算能单独断定“这就是成品视频”的强候选 */
  const isStrong = (key: string, url: string) => /video/i.test(key) || VIDEO_EXTENSION_PATTERN.test(url);

  const add = (url: string, duration: unknown, strong: boolean) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, duration: typeof duration === "number" ? duration : undefined, strong });
  };

  /**
   * inheritedDuration 让 duration 向下传递：Seedance 把它放在 content 的兄弟节点
   * （{ content: { video_url }, duration: 5 }），URL 本身拿不到时长，得从父级带下来。
   */
  const walk = (value: unknown, parentKey = "", depth = 0, inheritedDuration?: unknown) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (!/^https?:\/\//i.test(value)) return;
      // 扩展名能认出来的直接收，否则看字段名是否像视频地址
      if (VIDEO_EXTENSION_PATTERN.test(value) || VIDEO_KEY_PATTERN.test(parentKey)) {
        add(value, inheritedDuration, isStrong(parentKey, value));
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, parentKey, depth + 1, inheritedDuration));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    // 本层的 duration 供子节点兜底使用
    const duration = typeof record.duration === "number" ? record.duration : inheritedDuration;
    // { video: { url, duration } } 这类嵌套结构，duration 要和 url 一起取出来
    if (typeof record.url === "string" && /^https?:\/\//i.test(record.url)) {
      add(record.url, record.duration ?? inheritedDuration, isStrong(parentKey, record.url));
    }
    for (const [key, item] of Object.entries(record)) walk(item, key, depth + 1, duration);
  };

  walk(payload);
  // 强候选排前面：saveVideos 只取第一个，别让封面图抢先
  return candidates.sort((a, b) => Number(Boolean(b.strong)) - Number(Boolean(a.strong)));
}
