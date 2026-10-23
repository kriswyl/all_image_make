/**
 * Gemini TTS 的固定契约。
 *
 * 音色表来自 2026-10-23 对天Token 网关的实测：只有这 30 个预置音色，
 * 没有克隆、没有自定义音色、没有 SSML，也没有 speed 参数。
 * 前端下拉和 Agent 工具都用这一份，避免两边各写一份然后慢慢漂移。
 */

export const TTS_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number];

export const TTS_DEFAULT_VOICE: TtsVoice = "Kore";

/** 常用语种；留空表示让模型按文本自动判断 */
export const TTS_LANGUAGES = [
  { value: "", label: "自动判断" },
  { value: "zh-CN", label: "中文（普通话）" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "es-ES", label: "Español" },
] as const;

export const TTS_STYLE_PRESETS = [
  "自然、像聊天",
  "亲切、温和",
  "正式、播报腔",
  "纪录片旁白",
  "深夜电台",
  "开心、轻快",
  "悲伤、低沉",
  "轻声耳语，放慢语速",
  "逐字清晰，稍慢",
  "有笑意、活泼",
] as const;

/** 双人对话只支持两个说话人，正文用 A：/ B： 标注 */
export const TTS_SPEAKERS = ["A", "B"] as const;
