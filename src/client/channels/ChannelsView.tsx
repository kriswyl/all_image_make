import { useState } from "react";
import { Activity, AlertCircle, CheckCircle2, LoaderCircle, Plus, Server, Settings2, Trash2 } from "lucide-react";
import { api } from "../api";
import { adapterLabels } from "../labels";
import type { Channel } from "../../shared/types";
import type { ToastKind } from "../labels";

export function ChannelsView({ channels, onAdd, onEdit, onDelete, onToast }: { channels: Channel[]; onAdd: () => void; onEdit: (channel: Channel) => void; onDelete: (channel: Channel) => void; onToast: (kind: ToastKind, message: string) => void }) {
  const [testing, setTesting] = useState<string | null>(null);
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
          <tbody>{channels.map((channel) => (
            <tr key={channel.id}>
              <td><button className="table-primary" onClick={() => onEdit(channel)}>{channel.name}</button><span className="table-secondary">{channel.baseUrl}</span></td>
              <td>{adapterLabels[channel.adapterType]}</td><td>{channel.models.length}</td>
              <td>{channel.authType === "none" ? "无需密钥" : channel.hasKey ? <span className="positive"><CheckCircle2 size={15} />已配置</span> : <span className="warning"><AlertCircle size={15} />未配置</span>}</td>
              <td><span className={`channel-state ${channel.enabled ? "enabled" : ""}`}>{channel.enabled ? "启用" : "停用"}</span></td>
              <td><div className="table-actions"><button className="icon-button" title="测试连接" onClick={() => test(channel)} disabled={testing === channel.id}>{testing === channel.id ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}</button><button className="icon-button" title="编辑渠道" onClick={() => onEdit(channel)}><Settings2 size={16} /></button><button className="icon-button danger" title="删除渠道" onClick={() => onDelete(channel)}><Trash2 size={16} /></button></div></td>
            </tr>
          ))}</tbody>
        </table>
        {!channels.length ? <div className="table-empty"><Server size={28} /><span>尚无渠道</span></div> : null}
      </div>
    </div>
  );
}
