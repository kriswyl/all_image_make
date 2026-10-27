import { useState } from "react";
import { LoaderCircle, Wand2 } from "lucide-react";
import { api } from "./api";
import type { Toast } from "./app-shared";

/**
 * 提示词润色按钮。只改提示词、不触发生成，调用的是对话模型；
 * 工作台不绑定会话，所以服务端会挑一个可用的对话渠道。
 */
export function PromptPolishButton(props: {
  prompt: string;
  target: "image" | "video" | "dialogue" | "sound";
  disabled?: boolean;
  onPolished: (prompt: string) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [polishing, setPolishing] = useState(false);

  async function polish() {
    const prompt = props.prompt.trim();
    if (!prompt || polishing) return;
    setPolishing(true);
    try {
      const result = await api.optimizePrompt(prompt, props.target);
      props.onPolished(result.prompt);
      props.onToast("success", `提示词已由 ${result.channelName} · ${result.model} 润色`);
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "提示词润色失败");
    } finally {
      setPolishing(false);
    }
  }

  return (
    <button
      type="button"
      className="prompt-polish"
      onClick={() => void polish()}
      disabled={props.disabled || polishing || !props.prompt.trim()}
      title="调用对话模型润色提示词（不会生成图片）"
    >
      {polishing ? <LoaderCircle className="spin" size={14} /> : <Wand2 size={14} />}
      {polishing ? "润色中" : "润色"}
    </button>
  );
}
