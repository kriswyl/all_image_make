/**
 * M0 探针：验证对话模型能不能当 Agent 的大脑。
 *
 * 走的完全是产品代码的路径（loadEnvFiles → buildBrainRequest → callBrain），
 * 所以它跑通就说明真实链路可用，而不是"curl 能用但代码接不上"。
 *
 * 用法：
 *   npx tsx scripts/probe-brain.ts [模型名]
 * 密钥从 .env 的 TIANTOKEN_CHAT_API_KEY 读取，不落盘、不进代码。
 */
import type { DbChannel } from "../src/server/db.js";
import { callBrain, type BrainMessage } from "../src/server/brain.js";
import { loadEnvFiles } from "../src/server/security.js";

loadEnvFiles();

const model = process.argv[2] ?? "deepseek-v4-1-flash";
const key = process.env.TIANTOKEN_CHAT_API_KEY;
if (!key) {
  console.error("缺少 TIANTOKEN_CHAT_API_KEY，请在项目根目录的 .env 里配置");
  process.exit(1);
}

const channel: DbChannel = {
  id: "probe",
  name: "词元流墟-对话模型",
  baseUrl: "https://api.tiantoken.com",
  adapterType: "openai-chat",
  authType: "bearer",
  authHeaderName: "",
  secretEnv: "TIANTOKEN_CHAT_API_KEY",
  endpoint: "/v1/chat/completions",
  models: [model],
  allowPrivateNetwork: false,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** 和产品里将要使用的提示词保持同构，否则探针结果没有参考价值 */
const SYSTEM = `你是益达工作台的生成助手。你只能通过工具操作。
绝对不要凭想象描述生成结果——图片还没出来时你并不知道它长什么样。

【可用模型】
alias=gpt-image  图片  尺寸=1024x1024|1536x1024  图生图=✔  视觉=✘
alias=gemini  图片  宽高比=1:1|16:9  尺寸=1K|2K|4K  图生图=✔  视觉=✔
alias=wan  视频  2-30s  720P|1080P  模式=文生|首帧|首尾帧|参考|编辑|延长  音频=✔  提示词扩展=✔

【当前画布】
（无）

【规则】
1. 一次只输出一个 JSON 对象，不要输出解释文字、不要包 markdown 代码块。
2. 模型一律用 alias，不要编造 channelId 或模型 ID。
3. 信息不足时用 ask 工具反问，不要猜。
4. 视频优先开启 promptExtend，不要自己重写提示词。

【输出格式】
{"tool": "...", "args": {...}, "say": "给用户看的一句话"}

可用工具：generate_image{prompt,modelHint,size}, edit_image{prompt,modelHint}, generate_video{prompt,modelHint,duration}, optimize_prompt{prompt,target}, ask{question}, reply{text}`;

interface Case {
  name: string;
  messages: BrainMessage[];
  /** 这个用例期望命中的工具，仅用于打印对照，不做断言 */
  expect: string;
}

const cases: Case[] = [
  {
    name: "1. 直接出图（显式指定模型）",
    expect: "generate_image",
    messages: [{ role: "user", content: "用 gemini 画一张 16:9 的日落海滩，写实风格" }],
  },
  {
    name: "2. 多步链式（先生图再生视频）",
    expect: "generate_image（后续轮次才 generate_video）",
    messages: [{ role: "user", content: "画一只戴墨镜的柴犬，然后让它点头" }],
  },
  {
    name: "3. 信息不足应当反问",
    expect: "ask",
    messages: [{ role: "user", content: "帮我做个视频" }],
  },
  {
    name: "4. 纯聊天应当走 reply",
    expect: "reply",
    messages: [{ role: "user", content: "你能做什么？" }],
  },
];

async function main() {
  let failures = 0;
  for (const item of cases) {
    console.log(`\n${"=".repeat(60)}\n${item.name}\n期望: ${item.expect}\n${"=".repeat(60)}`);
    let streamed = "";
    try {
      const result = await callBrain({
        channel,
        key: key!,
        model,
        messages: [{ role: "system", content: SYSTEM }, ...item.messages],
        onDelta: (delta) => {
          if (delta.content) streamed += delta.content;
        },
      });
      console.log(`延迟      ${result.durationMs}ms${result.usedFallback ? "（站点忽略了 stream，走了非流式兜底）" : ""}`);
      console.log(`finish    ${result.finishReason}${result.truncated ? "  ⚠️ 输出被截断" : ""}`);
      if (result.usage) {
        console.log(
          `用量      prompt=${result.usage.promptTokens} completion=${result.usage.completionTokens}` +
            ` reasoning=${result.usage.reasoningTokens}`,
        );
      }
      console.log(`推理      ${result.reasoning.replace(/\s+/g, " ").slice(0, 120) || "（无）"}`);
      console.log(`正文      ${result.content}`);

      // 流式拼出来的正文必须和非流式累积结果一致，否则 SSE 解析有问题
      if (!result.usedFallback && streamed !== result.content) {
        console.log(`⚠️  流式拼接与最终正文不一致：streamed=${JSON.stringify(streamed.slice(0, 80))}`);
        failures += 1;
      }
      const parsed = tryParsePlan(result.content);
      if (!parsed) {
        console.log("⚠️  正文不是合法 JSON，Agent 层需要走重试分支");
        failures += 1;
      } else {
        console.log(`解析      tool=${parsed.tool}`);
      }
    } catch (error) {
      failures += 1;
      console.log(`❌ 调用失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(failures ? `有 ${failures} 处需要关注` : "全部用例通过");
}

/** 允许模型把 JSON 包在 markdown 代码块里——Agent 层最终会用 zod 严格校验，这里只做粗判 */
function tryParsePlan(content: string): { tool: string } | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(trimmed) as { tool?: unknown };
    return typeof parsed.tool === "string" ? { tool: parsed.tool } : null;
  } catch {
    return null;
  }
}

void main();
