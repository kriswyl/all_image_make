import { Fragment, useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, ChevronDown, LoaderCircle, Plus, QrCode, Server, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../api";
import { adapterLabels } from "../labels";
import { channelKindOf, type Channel } from "../../shared/types";
import type { ToastKind } from "../labels";
import { ModelLogo, type ModelKind } from "../chat/ModelLogo";

/** 模型图标按渠道类目匹配：`sd-*` 在视频里是 Seedance，在图片里是 Stable Diffusion */
function channelModelKind(channel: Channel): ModelKind {
  return channelKindOf(channel.adapterType);
}

export function ChannelsView({ channels, onAdd, onQuickSetup, onEdit, onDelete, onToast }: {
  channels: Channel[];
  onAdd: () => void;
  /** 按模型快速配置：先选模型，再自动归并成渠道配置 */
  onQuickSetup?: () => void;
  onEdit: (channel: Channel) => void;
  onDelete: (channel: Channel) => void;
  onToast: (kind: ToastKind, message: string) => void;
}) {
  const [testing, setTesting] = useState<string | null>(null);
  /** 展开了模型清单的渠道（只读：改模型仍然走编辑弹窗，避免在列表里误删） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** 词元流墟官方客服二维码：声明为官方联系方式，和作者不是同一个联系人 */
  const [contactOpen, setContactOpen] = useState(false);
  const contactRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contactOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!contactRef.current?.contains(event.target as Node)) setContactOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setContactOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [contactOpen]);
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
      <div className="page-header">
        <div><h1>模型设置</h1><span className="page-kicker">MODEL CONFIGURATION</span></div>
        <div className="page-header-actions">
          <div className="provider-contact" ref={contactRef}>
            <button
              type="button"
              className="secondary-button"
              aria-expanded={contactOpen}
              onClick={() => setContactOpen((value) => !value)}
            >
              <QrCode size={16} />词元流墟技术支持
            </button>
            {contactOpen ? (
              <div className="provider-contact-popover" role="dialog" aria-label="词元流墟官方联系方式">
                <div className="provider-contact-head">
                  <strong>词元流墟官方企业微信</strong>
                  <button type="button" className="icon-button compact" title="关闭" onClick={() => setContactOpen(false)}>
                    <X size={14} />
                  </button>
                </div>
                <img src="/tiantoken-wechat.png" alt="词元流墟官方企业微信二维码，客服主管泡泡" />
                <p>
                  扫码添加客服「泡泡」 · 成都天相科技
                  <span>词元流墟官方联系方式，非作者联系方式</span>
                </p>
              </div>
            ) : null}
          </div>
          {onQuickSetup ? <button className="secondary-button" onClick={onQuickSetup}><Sparkles size={16} />按模型快速配置</button> : null}
          <button className="primary-button" onClick={onAdd}><Plus size={17} />添加渠道</button>
        </div>
      </div>
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
