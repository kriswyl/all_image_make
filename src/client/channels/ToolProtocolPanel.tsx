import { useEffect, useState } from "react";
import { api } from "../api";
import type { ToolProtocol } from "../../shared/tool-protocol";

const labels = { tools: "原生工具", parallel: "多调用", streaming: "流式调用", toolChoice: "指定工具", nestedSchema: "嵌套参数" } as const;
export function ToolProtocolPanel({ channelId, model }: { channelId: string; model: string }) {
  const [protocol,setProtocol] = useState<ToolProtocol>({});
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  useEffect(() => {
    let active = true;
    api.toolProtocol(channelId,model).then(value => { if (active) setProtocol(value); }).catch(() => { if (active) setMessage("能力记录暂不可用"); });
    return () => { active = false; };
  },[channelId,model]);
  const probe = async () => {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await api.probeToolProtocol(channelId,model);
      setProtocol(result.protocol);
      const tokens = result.results.reduce((total,row) => total+(row.tokens ?? 0),0);
      setMessage(`已检测 ${result.results.length} 项，${result.results.filter(row => row.status === "passed").length} 项验证通过 · ${tokens} tokens${result.results.some(row => row.tokens === null) ? "（部分用量未知）" : ""}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "检测失败"); }
    finally { setBusy(false); }
  };
  return <div className="tool-protocol-panel">
    <strong>{model}</strong>
    <div>{Object.entries(labels).map(([feature,label]) => {
      const evidence = protocol[feature as keyof typeof labels];
      return <span className="model-chip" key={feature} title={evidence ? `${evidence.source === "probe" ? "检测" : "实际调用"} · ${evidence.at}` : "尚未验证"}>
        {label} · {evidence ? evidence.supported ? "已验证" : "已拒绝" : "未验证"}
      </span>;
    })}</div>
    <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void probe()}>{busy ? "正在检测…" : "检测工具能力"}</button>
    <small>仅发送虚构测试数据，最多 3 次模型请求，按渠道计费</small>
    {message ? <div role="status">{message}</div> : null}
  </div>;
}
