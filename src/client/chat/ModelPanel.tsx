import { ListTree } from "lucide-react";
import { ModelLogo } from "./ModelLogo";
import type { Channel, TaskKind } from "../../shared/types";

export type CapabilityRow = {
  alias: string;
  kind: TaskKind;
  model: string;
  channelName: string;
  channelId: string;
};

/**
 * 对话页的模型面板：默认模型 + 当前能调的模型清单。
 *
 * 原来这块 JSX 长在 ChatView 里，和 SSE、上传、会话列表混在一起；
 * 它本身只依赖 props，拆出来后 ChatView 的主渲染轻了一半。
 */
export function ModelPanel({
  capabilities,
  defaults,
  channels,
  capsRef,
  onSetDefaultAlias,
  onConfigureChannel,
}: {
  capabilities: CapabilityRow[];
  defaults: Record<TaskKind, string>;
  channels: Channel[];
  capsRef: React.RefObject<HTMLDetailsElement | null>;
  onSetDefaultAlias: (kind: TaskKind, alias: string) => void;
  onConfigureChannel?: (channel: Channel) => void;
}) {
  const aliasesOf = (kind: TaskKind) => capabilities.filter((cap) => cap.kind === kind);
  const effectiveAlias = (configured: string, aliases: CapabilityRow[]) =>
    aliases.some((cap) => cap.alias === configured) ? configured : aliases[0]?.alias ?? "";

  const kinds: Array<{ kind: TaskKind; label: string }> = [
    { kind: "image", label: "生图" },
    { kind: "video", label: "生视频" },
    { kind: "audio", label: "音乐" },
  ];

  return (
    <details className="chat-caps" ref={capsRef}>
      <summary title="助手现在能调哪些模型"><ListTree size={13} />图片 · 视频 · 音乐模型</summary>
      <div className="chat-caps-body">
        <div className="chat-caps-defaults">
          <div className="chat-caps-defaults-grid">
            {kinds.map(({ kind, label }) => {
              const aliases = aliasesOf(kind);
              return (
                <label key={kind}>
                  <span>默认{label}模型</span>
                  <select
                    value={defaults[kind]}
                    disabled={!aliases.length}
                    onChange={(event) => onSetDefaultAlias(kind, event.target.value)}
                  >
                    <option value="">自动（用第一个）</option>
                    {aliases.map((cap) => (
                      <option key={cap.alias} value={cap.alias}>{cap.alias} · {cap.model}</option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
          <p className="chat-caps-hint">
            助手没说用哪个模型时，就用这里的——也可以直接点下面列表里的那一行。
          </p>
        </div>
        <div className="chat-caps-columns">
          {kinds.map(({ kind, label }) => {
            const items = aliasesOf(kind);
            const aliases = aliasesOf(kind);
            const defaultValue = defaults[kind];
            return (
              <section key={kind} className="chat-caps-column">
                <h4>{label}模型{items.length ? `（${items.length}）` : ""}</h4>
                {items.length ? items.map((cap) => {
                  const effective = cap.alias === effectiveAlias(defaultValue, aliases);
                  return (
                    <div
                      key={`${cap.kind}-${cap.alias}`}
                      className={`chat-caps-item ${effective ? "is-default" : ""}`}
                      role="button"
                      tabIndex={0}
                      title={effective ? "当前默认" : `点一下把 ${cap.model} 设为默认`}
                      onClick={() => { if (!effective) onSetDefaultAlias(cap.kind, cap.alias); }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        if (!effective) onSetDefaultAlias(cap.kind, cap.alias);
                      }}
                    >
                      <span className="chat-caps-logo">
                        <ModelLogo model={cap.model} kind={cap.kind} />
                      </span>
                      <span className="chat-caps-model">
                        <strong title={cap.model}>{cap.model}</strong>
                        {effective ? <i className="chat-caps-flag">默认</i> : null}
                      </span>
                      <span className="chat-caps-meta">{cap.channelName} · 叫「{cap.alias}」</span>
                      {onConfigureChannel && cap.channelId ? (
                        <button
                          type="button"
                          className="chat-caps-adjust"
                          title="调整这个渠道的配置"
                          onClick={(event) => {
                            event.stopPropagation();
                            const channel = channels.find((item) => item.id === cap.channelId);
                            if (channel) onConfigureChannel(channel);
                          }}
                        >
                          调整
                        </button>
                      ) : null}
                    </div>
                  );
                }) : (
                  <p className="chat-caps-empty">还没有可用的{label}模型——到「渠道」里接一个。</p>
                )}
              </section>
            );
          })}
        </div>
        <p className="chat-caps-note">上面是真名，下面那个是对话里用的简称——你在对话里说「用 Gemini 画」就够了，不必记真实模型 ID。</p>
      </div>
    </details>
  );
}
