import { useState } from "react";
import { Crosshair, Search, X } from "lucide-react";
import { boardGroups, type BoardDoc } from "../../shared/board";

export function BoardNodeSearch({ doc, onLocate, onClose }: { doc: BoardDoc; onLocate: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  const groups = new Map(boardGroups(doc).flatMap((group) => group.nodeIds.map((id) => [id, group.title] as const)));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = doc.nodes.filter((node) => (!failed || (node.type !== "text" && node.status === "failed")) && terms.every((term) =>
    `${node.ref} ${node.title} ${groups.get(node.id) ?? ""}`.toLowerCase().includes(term)));
  function locate(id: string) { onLocate(id); onClose(); }

  return <aside className="board-command-panel" aria-label="查找节点" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header><Search size={17} /><strong>查找节点</strong><button type="button" className="icon-button" aria-label="关闭搜索" onClick={onClose}><X size={16} /></button></header>
    <div className="board-command-toolbar">
      <input autoFocus type="search" aria-label="节点名称、编号或分组" placeholder="节点名称、编号或分组" value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && results[0]) locate(results[0].id); }} />
      <label><input type="checkbox" checked={failed} onChange={(event) => setFailed(event.target.checked)} />失败</label>
    </div>
    <div className="board-command-list">{results.length ? results.map((node) => <button type="button" key={node.id} onClick={() => locate(node.id)}>
      <span><strong>{node.title || node.ref}</strong><small>{[node.ref, groups.get(node.id)].filter(Boolean).join(" · ")}</small></span><Crosshair size={15} />
    </button>) : <p className="board-command-empty">没有匹配的节点</p>}</div>
  </aside>;
}
