import { callBrain, type BrainMessage } from "./brain.js";
import type { AppDatabase } from "./db.js";
import type { KeyStore } from "./key-store.js";
import { AppError } from "./tasks.js";

export type PromptTarget = "image" | "video" | "dialogue" | "sound";

function optimizeMessages(prompt: string, target: PromptTarget): BrainMessage[] {
  if (target === "dialogue") {
    return [
      {
        role: "system",
        content: [
          "你是影视台词编剧。把用户给的台词改写得自然、口语化、适合演员说出口，保留原意和人物关系。",
          "每行一句；有多个人物时保留「角色：台词」前缀，同一人物全篇用同一个名字。",
          "只改台词本身，不要写画面描述、动作说明、旁白解释或镜头语言。",
          "只输出改写后的台词，不要解释、不要加引号、不要包 markdown 代码块。",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ];
  }
  if (target === "sound") {
    return [
      {
        role: "system",
        content: [
          "你是影视声音设计。把用户给的环境声 / 音效描述改写得具体、可执行：写清声源、远近、强弱、节奏和空间混响。",
          "不要写台词、配乐旋律或画面描述；只输出声音设计本身。",
          "只输出改写后的音效描述，不要解释、不要加引号、不要包 markdown 代码块。",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ];
  }
  const label = target === "video" ? "视频" : "图片";
  return [
    {
      role: "system",
      content: [
        `你是${label}提示词工程师。把用户给的提示词重写成一段具体、可直接使用的${label}提示词。`,
        "补全主体、构图、光线、材质、镜头语言、风格等要素；保留用户的原意和所有具体设定，不要添加用户没提过的品牌、文字或人物。",
        target === "video" ? "视频提示词要写清运动方式和镜头运动。" : "",
        "只输出重写后的提示词本身，不要解释、不要加引号、不要包 markdown 代码块。",
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: prompt },
  ];
}

/**
 * 生图 / 生视频工作台的「润色」。
 *
 * 和 Agent 的 `optimize_prompt` 走同一条 `callBrain` 通道，但不需要会话：
 * 直接挑一个可用的对话渠道，用它的第一个模型改提示词。输出是纯文本，
 * 不做 Agent 那套 JSON 工具协议，按钮拿到结果就能填回输入框。
 */
export async function optimizePromptForWorkbench(
  db: AppDatabase,
  sessionKeys: KeyStore,
  input: { prompt: string; target: PromptTarget },
) {
  const channels = db.listChannels().filter((channel) => channel.enabled && channel.adapterType === "openai-chat");
  if (!channels.length) {
    throw new AppError("NO_CHAT_CHANNEL", "还没有可用的对话模型渠道，请先在「渠道」里添加对话模型", 400);
  }
  for (const channel of channels) {
    const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
    if (!key && channel.authType !== "none") continue;
    const model = channel.models[0];
    if (!model) continue;
    const result = await callBrain({
      channel,
      key,
      model,
      messages: optimizeMessages(input.prompt, input.target),
      timeoutMs: 120_000,
    });
    const prompt = result.content.trim();
    if (!prompt) throw new AppError("EMPTY_RESPONSE", "对话模型没有返回润色结果", 502);
    return { prompt, channelName: channel.name, model };
  }
  throw new AppError("CHANNEL_AUTH_FAILED", "对话模型渠道没有可用的密钥", 400);
}
