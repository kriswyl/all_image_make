import { useState } from "react";
import { Check, ChevronDown, ListTree, Settings2 } from "lucide-react";
import { ModelLogo } from "./ModelLogo";
import type { Channel, TaskKind } from "../../shared/types";

export type CapabilityRow = {
  alias: string;
  kind: TaskKind;
  model: string;
  channelName: string;
  channelId: string;
};

const KINDS: Array<{ kind: TaskKind; label: string }> = [
  { kind: "image", label: "生图" },
  { kind: "video", label: "生视频" },
  { kind: "audio", label: "音频" },
];

/**
 * 对话页的模型面板：切换默认模型 + 看当前能调哪些模型。
 *
 * 早先顶部有三个「默认模型」下拉，下面又是同一批模型的列表，两处做同一件事，
 * 默认项还只靠一行灰字标记。现在改成「类型标签 + 卡片」：
 * 一类模型一屏，点卡片就是设默认，默认卡用黑描边和实心徽标标出来。
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
  const [activeKind, setActiveKind] = useState<TaskKind>("image");

  const aliasesOf = (kind: TaskKind) => capabilities.filter((cap) => cap.kind === kind);
  const effectiveAlias = (configured: string, aliases: CapabilityRow[]) =>
    aliases.some((cap) => cap.alias === configured) ? configured : aliases[0]?.alias ?? "";

  const active = KINDS.find((item) => item.kind === activeKind) ?? KINDS[0];
  const items = aliasesOf(activeKind);
  const effective = effectiveAlias(defaults[activeKind], items);
  const defaultItem = items.find((cap) => cap.alias === effective);

  return (
    <details className="chat-caps" ref={capsRef}>
      <summary title="助手现在能调哪些模型">
        <ListTree size={13} />
        <span>模型</span>
        <ChevronDown size={13} className="chat-caps-chevron" />
      </summary>
      <div className="chat-caps-body">
        <div className="chat-caps-tabs" role="tablist" aria-label="模型类型">
          {KINDS.map(({ kind, label }) => {
            const count = aliasesOf(kind).length;
            return (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={activeKind === kind}
                className={activeKind === kind ? "is-active" : undefined}
                onClick={() => setActiveKind(kind)}
              >
                {label}
                <span className="chat-caps-tab-count">{count}</span>
              </button>
            );
          })}
        </div>

        <p className="chat-caps-default-line">
          <span className="chat-caps-default-label">默认{active.label}模型</span>
          {defaultItem ? (
            <>
              <strong>{defaultItem.model}</strong>
              <span className="chat-caps-default-channel">{defaultItem.channelName}</span>
            </>
          ) : (
            <span className="chat-caps-default-empty">还没有可用的{active.label}模型</span>
          )}
        </p>

        <div className="chat-caps-grid" role="radiogroup" aria-label={`默认${active.label}模型`}>
          {items.map((cap) => {
            const isDefault = cap.alias === effective;
            return (
              <div
                key={`${cap.kind}-${cap.alias}`}
                className={`chat-caps-card ${isDefault ? "is-default" : ""}`}
                role="radio"
                aria-checked={isDefault}
                tabIndex={0}
                title={isDefault ? "当前默认模型" : `把 ${cap.model} 设为默认${active.label}模型`}
                onClick={() => { if (!isDefault) onSetDefaultAlias(cap.kind, cap.alias); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  if (!isDefault) onSetDefaultAlias(cap.kind, cap.alias);
                }}
              >
                <span className="chat-caps-logo">
                  <ModelLogo model={cap.model} kind={cap.kind} />
                </span>
                <span className="chat-caps-model">
                  <strong title={cap.model}>{cap.model}</strong>
                  {isDefault ? (
                    <i className="chat-caps-flag"><Check size={10} strokeWidth={3} />默认</i>
                  ) : null}
                </span>
                <span className="chat-caps-meta">
                  <span className="chat-caps-channel" title={cap.channelName}>{cap.channelName}</span>
                  <span className="chat-caps-meta-sep">·</span>
                  <span className="chat-caps-alias" title={`对话里说「${cap.alias}」就能用它`}>「{cap.alias}」</span>
                </span>
                {onConfigureChannel && cap.channelId ? (
                  <button
                    type="button"
                    className="chat-caps-gear"
                    title="调整这个渠道的配置"
                    aria-label="调整渠道配置"
                    onClick={(event) => {
                      event.stopPropagation();
                      const channel = channels.find((item) => item.id === cap.channelId);
                      if (channel) onConfigureChannel(channel);
                    }}
                  >
                    <Settings2 size={13} />
                  </button>
                ) : null}
              </div>
            );
          })}
          {items.length ? null : (
            <p className="chat-caps-empty">还没有可用的{active.label}模型——到「渠道」里接一个。</p>
          )}
        </div>

        <p className="chat-caps-note">
          点一下卡片就设为默认。助手没点名时用它；你在对话里点名时以你为准。
        </p>
      </div>
    </details>
  );
}
