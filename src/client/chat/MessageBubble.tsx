/**
 * 用户气泡、助手正文、系统提示条、以及流式输出的临时气泡（AGENT_PLAN.md §14）。
 */
import { AlertCircle, FileText, Info } from "lucide-react";
import { assetRef, type ChatMessage } from "../../shared/agent-types";
import { api } from "../api";

/**
 * 用户自己传的那条消息（需求.md 问题 4）。
 *
 * 只写「上传了图片 猫.png」一句，用户回头翻记录时看不出当时传的是哪张，
 * 所以把图直接摆在气泡里。缩略图 404 就退回原图——缩略图只是省流量，
 * 不该成为用户看不见自己那张图的原因（和 AssetStrip 一样的回退）。
 */
export function UserBubble({ message, onPreview }: { message: ChatMessage; onPreview?: (assetId: string) => void }) {
  // 产出/上传的那一张走 assetId，从画布拖进来的那几张走 assetRefs，两者不重叠
  const thumbs = [...(message.assetId ? [message.assetId] : []), ...(message.assetRefs ?? [])];
  return (
    <div className="chat-row chat-row-user">
      <div className="chat-bubble chat-bubble-user">
        {thumbs.length ? (
          <div className="chat-bubble-thumbs">
            {thumbs.map((assetId) => (
              <button
                key={assetId}
                type="button"
                className="chat-bubble-thumb"
                title={`${assetRef(assetId)} · 点开看`}
                onClick={() => onPreview?.(assetId)}
              >
                <img
                  src={api.assetUrl(`/api/assets/${assetId}/thumb`)}
                  alt=""
                  loading="lazy"
                  onError={(event) => {
                    const image = event.currentTarget;
                    if (image.dataset.fallback === "1") return;
                    image.dataset.fallback = "1";
                    image.src = api.assetUrl(`/api/assets/${assetId}/file`);
                  }}
                />
              </button>
            ))}
          </div>
        ) : null}
        {message.documents.length ? (
          <div className="chat-bubble-documents">
            {message.documents.map((document) => (
              <span key={document.id} className="chat-document-chip" title="脚本文档，全文已交给助手">
                <FileText size={13} />
                <span>{document.name}</span>
                <small>{document.charCount.toLocaleString()} 字</small>
              </span>
            ))}
          </div>
        ) : null}
        {message.content}
      </div>
    </div>
  );
}

/**
 * 助手正文。底部可以挂一排「可选回答」按钮（`ask` 工具带 options 时的形态）。
 *
 * 以前 ask 的 options 是**直接丢掉**的：落库只取 `text ?? question ?? say`，
 * 模型问「你要 A 还是 B」，用户面前只有一句话，得自己把答案再打一遍。
 * 选项本来就在 `plan.args.options` 里存着，渲染出来即可。
 */
export function AssistantBubble({
  message,
  options = [],
  disabled = false,
  onPick,
}: {
  message: ChatMessage;
  /** 可点的答案；只有「还没被回答的那一条」才由外面传进来 */
  options?: string[];
  disabled?: boolean;
  onPick?: (option: string) => void;
}) {
  // 批量那一轮的表头行可能没有 `say`（`say` 在协议里是可选的），只带着 plan.calls。
  // 它要落库——大脑回放时得看见自己请求过什么——但没必要在界面上占一个空气泡。
  if (!message.content?.trim() && !options.length) return null;
  return (
    <div className="chat-row chat-row-assistant">
      {message.content?.trim() ? (
        <div className={`chat-bubble chat-bubble-assistant ${message.status === "error" ? "is-error" : ""}`}>
          {message.content}
        </div>
      ) : null}
      {options.length ? (
        <div className="chat-options" role="group" aria-label="可选回答">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="chat-option"
              disabled={disabled}
              onClick={() => onPick?.(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 系统消息居中显示：状态变化、「已取消」这类不该被当成助手说的话 */
export function SystemNote({ message }: { message: ChatMessage }) {
  const isError = message.status === "error";
  return (
    <div className={`chat-note ${isError ? "is-error" : ""}`} role="status">
      {isError ? <AlertCircle size={13} /> : <Info size={13} />}
      <span>{message.content}</span>
    </div>
  );
}

/**
 * 从**半个** JSON 里捞一个字符串字段。
 *
 * 大脑的输出就是一个 JSON 对象，直接流给用户看到的会是 `{"tool":"generate_i` 这种。
 * 但它里面那个 `say` 字段正好是「要跟用户说的那句话」——边生成边显示这句，
 * 用户就能看到字一个个打出来（推理模型一次调用要好几秒，这段等待必须有东西可看）。
 * 引号没闭合时返回已经拿到的部分，闭合了就返回完整值。
 */
export function extractPartialString(json: string, field: string): string | null {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (!match) return null;
  const start = match.index + match[0].length;
  let out = "";
  for (let index = start; index < json.length; index += 1) {
    const char = json[index];
    if (char === "\\") {
      const next = json[index + 1];
      if (next === undefined) break; // 转义还没写完
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "r") continue;
      else out += next;
      index += 1;
      continue;
    }
    if (char === '"') return out; // 闭合了，值已经完整
    out += char;
  }
  return out || null;
}

/** 说话字段各家模型叫法不一，按可能性依次找 */
function liveSay(content: string): string | null {
  for (const field of ["say", "text", "answer", "message"]) {
    const found = extractPartialString(content, field);
    if (found) return found;
  }
  return null;
}

/**
 * 正在流式输出、还没有落库的那一段。
 *
 * 推理内容放折叠面板里默认展开——推理模型的前几秒只有它可看；
 * 正文里能捞到 `say` 就实时显示，捞不到（比如这一轮直接调工具、没有 say）
 * 就退回到一句「正在组织回复」。
 */
export function StreamingBubble({ reasoning, content }: { reasoning: string; content: string }) {
  const say = content ? liveSay(content) : null;
  return (
    <div className="chat-row chat-row-assistant">
      {reasoning ? (
        <details className={`chat-reasoning ${content ? "" : "is-live"}`} open={!content}>
          <summary>{content ? "思考过程" : "思考中…"}</summary>
          <div className="chat-reasoning-body">{reasoning}</div>
        </details>
      ) : null}
      {content ? (
        <div className="chat-bubble chat-bubble-assistant">
          {say ?? <span className="chat-typing">正在准备生成…</span>}
          <span className="chat-caret" aria-hidden="true" />
        </div>
      ) : reasoning ? null : (
        <div className="chat-bubble chat-bubble-assistant">
          <span className="chat-typing">正在思考…</span>
          <span className="chat-caret" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
