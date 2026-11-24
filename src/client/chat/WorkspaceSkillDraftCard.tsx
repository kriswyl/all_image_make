import { useEffect, useRef, useState } from "react";
import { BookOpen, CheckCircle2 } from "lucide-react";
import type { WorkspaceSkillDraft } from "../../shared/local-workspace";
import { api } from "../api";

export function WorkspaceSkillDraftCard({ conversationId, draft, onSaved }: {
  conversationId: string;
  draft: WorkspaceSkillDraft;
  onSaved?: () => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => {
    let current = true;
    void api.workspaceSkillDraftStatus(conversationId, draft.id).then((status) => {
      if (current && status.path) setPath(status.path);
    }).catch(() => {});
    return () => { current = false; };
  }, [conversationId, draft.id]);

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.saveWorkspaceSkillDraft(conversationId, draft.id);
      setPath(result.path);
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存 Skill");
    } finally { saving.current = false; setBusy(false); }
  }

  return <section className="workspace-skill-draft" aria-label="审阅 Skill 草稿">
    <details open={!path}>
      <summary><BookOpen size={14} /><strong>{`$${draft.name}`}</strong></summary>
      <p>{draft.description}</p>
      <pre>{draft.instructions}</pre>
    </details>
    <div className="workspace-skill-actions">
      {path ? <span role="status"><CheckCircle2 size={14} />已保存到 <code>{path}</code></span>
        : <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void save()}>{busy ? "正在保存…" : "保存到工作区"}</button>}
      {error ? <span role="alert" className="workspace-skill-error">{error}</span> : null}
    </div>
  </section>;
}
