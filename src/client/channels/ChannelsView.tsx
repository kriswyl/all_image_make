import { Fragment, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, Plus, Server, Settings2, Trash2 } from "lucide-react";
import { api } from "../api";
import { adapterLabels } from "../labels";
import { isChatAdapter, isVideoAdapter, type Channel } from "../../shared/types";
import type { ToastKind } from "../labels";
import { ModelLogo, type ModelKind } from "../chat/ModelLogo";

/** 模型图标按渠道类目匹配：`sd-*` 在视频里是 Seedance，在图片里是 Stable Diffusion */
function channelModelKind(channel: Channel): ModelKind {
  if (isChatAdapter(channel.adapterType)) return "chat";
  if (isVideoAdapter(channel.adapterType)) return "video";
  return "image";
}

export function ChannelsView({ channels, onAdd, onEdit, onDelete, onToast }: { channels: Channel[]; onAdd: () => void; onEdit: (channel: Channel) => void; onDelete: (channel: Channel) => void; onToast: (kind: ToastKind, message: string) => void }) {
  const [testing, setTesting] = useState<string | null>(null);
  /** 展开了模型清单的渠道（只读：改模型仍然走编辑弹窗，避免在列表里误删） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  function toggleModels(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function test(channel: Channel) {
    setTesting(channel.id);
    try {
      const result = await api.testChannel(channel.id);
      onToast("success", result.message ?? `连接正常 · ${result.httpStatus}${result.durationMs ? ` · ${result.durationMs} ms` : ""}`);
    } catch (error) { onToast("error", error instanceof Error ? error.message : "连接失败"); }
    finally { setTesting(null); }
  }
  return (
    <div className="page">
      <div className="page-header"><div><h1>渠道</h1><span className="page-kicker">CONNECTIONS</span></div><button className="primary-button" onClick={onAdd}><Plus size={17} />添加渠道</button></div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>名称</th><th>协议</th><th>模型</th><th>密钥</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>{channels.map((channel) => {
            const open = expanded.has(channel.id);
            return (
              <Fragment key={channel.id}>
                <tr>
                  <td><button className="table-primary" onClick={() => onEdit(channel)}>{channel.name}</button><span className="table-secondary">{channel.baseUrl}</span></td>
                  <td>{adapterLabels[channel.adapterType]}</td>
                  <td>
                    <button
                      type="button"
                      className={`channel-models-toggle ${open ? "is-open" : ""}`}
                      aria-expanded={open}
                      title={open ? "收起模型清单" : "展开模型清单"}
                      onClick={() => toggleModels(channel.id)}
                    >
                      {channel.models.length} 个模型<ChevronDown size={13} />
                    </button>
                  </td>
                  <td>{channel.authType === "none" ? "无需密钥" : channel.hasKey ? <span className="positive"><CheckCircle2 size={15} />已配置</span> : <span className="warning"><AlertCircle size={15} />未配置</span>}</td>
                  <td><span className={`channel-state ${channel.enabled ? "enabled" : ""}`}>{channel.enabled ? "启用" : "停用"}</span></td>
                  <td><div className="table-actions"><button className="icon-button" title="测试连接" onClick={() => test(channel)} disabled={testing === channel.id}>{testing === channel.id ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}</button><button className="icon-button" title="编辑渠道" onClick={() => onEdit(channel)}><Settings2 size={16} /></button><button className="icon-button danger" title="删除渠道" onClick={() => onDelete(channel)}><Trash2 size={16} /></button></div></td>
                </tr>
                {open ? (
                  <tr className="channel-models-row">
                    <td colSpan={6}>
                      {channel.models.length ? (
                        <div className="chip-row channel-models-list">
                          {channel.models.map((model) => (
                            <span key={model} className="model-chip">
                              <ModelLogo model={model} kind={channelModelKind(channel)} size={13} />
                              {model}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="channel-models-empty">这个渠道还没有配置模型。</span>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}</tbody>
        </table>
        {!channels.length ? <div className="table-empty"><Server size={28} /><span>尚无渠道</span></div> : null}
      </div>
    </div>
  );
}
