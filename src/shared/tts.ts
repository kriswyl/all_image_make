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

/** Parse A/B dialogue, accepting optional paired quotes around each turn. */
export function splitTtsDialogue(text: string): Array<{ speaker: "A" | "B"; text: string }> {
  const parts: Array<{ speaker: "A" | "B"; text: string }> = [];
  const pattern = /(^|\n|(?<=[。！？!?；;」』”\"]))\s*([「『“\"])?\s*([ABab])\s*[：:]\s*/g;
  const closing: Record<string, string> = { "「": "」", "『": "』", "“": "”", '"': '"' };
  let current: { speaker: "A" | "B"; opening: string; start: number } | null = null;
  let match: RegExpExecArray | null;
  const add = (end: number) => {
    if (!current) return;
    let value = text.slice(current.start, end).trim();
    const endQuote = closing[current.opening];
    if (endQuote && value.endsWith(endQuote)) value = value.slice(0, -endQuote.length).trimEnd();
    if (value) parts.push({ speaker: current.speaker, text: value });
  };
  while ((match = pattern.exec(text))) {
    if (!current && text.slice(0, match.index).trim()) throw new Error("双人对话开头有未标注说话人的文字，请为每段台词加上 A：或 B：");
    add(match.index);
    current = { speaker: match[3]!.toUpperCase() as "A" | "B", opening: match[2] ?? "", start: pattern.lastIndex };
  }
  add(text.length);
  if (!parts.some((part) => part.speaker === "A") || !parts.some((part) => part.speaker === "B")) throw new Error("双人对话正文需要用「A：」「B：」标出两个说话人的台词");
  return parts;
}

/** Format recognized dialogue without changing quoted words inside a turn. */
export function formatTtsDialogue(text: string): string {
  return splitTtsDialogue(text).map((part) => `${part.speaker}：${part.text}`).join("\n");
}
