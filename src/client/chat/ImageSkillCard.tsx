import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Download, FolderOpen, RotateCcw, Sparkles } from "lucide-react";
import { SAMPLE_FIELDS, type ImageSkillRun, type SampleField, type SavedImageSkill } from "../../shared/skills";
import type { Asset } from "../../shared/types";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { StatusBadge, terminalStatuses } from "../task-ui";
import { LoadingIndicator } from "../ui/LoadingIndicator";

type Props = {
  conversationId: string;
  runId: string;
  canConfirm: boolean;
  onConfirmed?: () => void;
  onCompleted: () => void;
  onSaved?: (skill: SavedImageSkill) => void;
  onPreview: (asset: Asset) => void;
};

const fields = Object.entries(SAMPLE_FIELDS) as [SampleField, string][];

export function ImageSkillCard({ conversationId, runId, canConfirm, onConfirmed, onCompleted, onSaved, onPreview }: Props) {
  const [run, setRun] = useState<ImageSkillRun | null>(null);
  const [selected, setSelected] = useState<SampleField[][]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [rules, setRules] = useState("");
  const completedCallback = useRef(onCompleted);
  completedCallback.current = onCompleted;
  const pending = Boolean(run?.confirmed && (run.submitting || run.items.some(({ task }) => task && !terminalStatuses.includes(task.status))));
  const completed = Boolean(run?.confirmed && run.items.every(({ task }) => task?.status === "succeeded" && task.assets.length));
  const resumable = Boolean(run?.confirmed && !pending && run.items.some(({ task, error }) => !task && !error));
  const requested = useRef(false);

  useEffect(() => {
    let current = true;
    void api.skillRun(conversationId, runId).then((next) => {
      if (!current) return;
      setRun(next);
      setSelected(next.items.map(({ fields: active }) => active));
      setRules(next.reusableRules ?? "");
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : "读取方案失败");
    });
    return () => { current = false; };
  }, [conversationId, runId]);

  useEffect(() => {
    if (!pending) return;
    let current = true;
    let timer: number;
    async function refresh() {
      try {
        const next = await api.skillRun(conversationId, runId);
        if (current && !requested.current) {
          setRun(next);
          setError("");
        }
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : "更新任务状态失败");
      }
      if (current) timer = window.setTimeout(() => void refresh(), 1600);
    }
    timer = window.setTimeout(() => void refresh(), 1600);
    return () => { current = false; window.clearTimeout(timer); };
  }, [conversationId, runId, pending]);

  const succeeded = run?.items.filter(({ task }) => task?.status === "succeeded").length ?? 0;
  useEffect(() => { if (succeeded) completedCallback.current(); }, [succeeded]);

  async function action(work: () => Promise<void>) {
    if (requested.current) return;
    requested.current = true;
    setWorking(true);
    setError("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { requested.current = false; setWorking(false); }
  }

  function toggleField(index: number, field: SampleField) {
    setSelected((current) => current.map((item, i) => {
      if (index !== i) return item;
      if (!item.includes(field)) return [...item, field];
      return item.length > 1 ? item.filter((value) => value !== field) : item;
    }));
  }

  if (!run) return error ? <p className="image-skill-error" role="alert">{error}</p> : null;
  const editable = !run.confirmed && canConfirm;
  const dimensions = run.target.size ?? run.target.aspectRatio;

  return <section className="image-skill-card" aria-label="样片出图方案">
    <header><FolderOpen size={16} /><strong>{run.confirmed ? "样片出图结果" : "样片出图方案"}</strong>
      <small>{run.confirmed ? `${succeeded}/${run.items.length} 已完成` : `${run.items.length} 张样片 · ${run.items.length} 张成品`}</small>
    </header>
    <div className="image-skill-card-meta">
      <span>{run.target.model}{dimensions ? ` · ${dimensions}` : ""}</span>
      {run.requirements ? <p>{run.requirements}</p> : null}
    </div>
    <ol className="image-skill-rows">
      {run.items.map((item, index) => {
        const output = item.task?.assets[0];
        const failure = item.error ?? item.task?.errorMessage;
        const canRetry = !pending && item.task?.errorCode !== "SUBMISSION_UNKNOWN" && (Boolean(item.error && !item.task)
          || item.task?.status === "failed" || item.task?.status === "cancelled");
        return <li key={`${item.sample.id}:${index}`}>
          <button type="button" className="image-skill-thumb" aria-label={`查看样片 ${item.name}`} onClick={() => onPreview(item.sample)}>
            <img src={api.assetUrl(item.sample.thumbUrl || item.sample.url)} alt="" loading="lazy" />
          </button>
          <details>
            <summary><span title={item.name}>{item.name}</span><ChevronDown size={13} /></summary>
            <div className="image-skill-fields">{fields.map(([field, label]) => {
              const checked = Boolean(selected[index]?.includes(field));
              return editable
                ? <label key={field}><input type="checkbox" checked={checked} disabled={working} onChange={() => toggleField(index, field)} />{label} · {item.analysis[field]}</label>
                : item.fields.includes(field) ? <span key={field}>{label} · {item.analysis[field]}</span> : null;
            })}</div>
          </details>
          {run.confirmed ? <div className="image-skill-output">
            {output ? <button type="button" className="image-skill-thumb" aria-label={`查看成品 ${item.name}`} onClick={() => onPreview(output)}>
              <img src={api.assetUrl(output.thumbUrl || output.url)} alt="" loading="lazy" />
            </button> : item.task ? <StatusBadge status={item.task.status} /> : <small>{item.error ? "失败" : run.submitting ? "待提交" : "未提交"}</small>}
            {failure ? <small className="image-skill-error" title={failure}>{failure}</small> : null}
            {canRetry ? <button className="image-skill-button" disabled={working} type="button" onClick={() => {
              if (confirmGeneration({ kind: "样片改图", model: run.target.model, retry: true, detail: item.name }))
                void action(async () => setRun(await api.retryImageSkill(conversationId, runId, index)));
            }}><RotateCcw size={12} />重试</button> : null}
          </div> : null}
        </li>;
      })}
    </ol>
    {error ? <p className="image-skill-error" role="alert">{error}</p> : null}
    <footer>
      {pending ? <span role="status"><LoadingIndicator variant="dots" size={20} />正在处理任务</span> : null}
      {editable || resumable ? <button type="button" className="image-skill-button is-primary" disabled={working || !selected.length}
        onClick={() => void action(async () => {
          setRun(await api.confirmImageSkill(conversationId, runId, selected));
          onConfirmed?.();
        })}><ArrowUpRight size={14} />{resumable ? "继续提交剩余任务" : `确认生成 ${run.items.length} 张`}</button> : null}
      {editable ? <small>确认后会逐张提交请求，费用由渠道计收。</small> : null}
      {!run.confirmed && !editable ? <small>仅当前方案可确认生成。</small> : null}
      {completed && !saving && !run.savedSkillId ? <button type="button" className="image-skill-button" onClick={() => setSaving(true)}><Sparkles size={14} />认可流程，保存为 Skill</button> : null}
      {run.savedSkillId ? <button type="button" disabled={working} className="image-skill-button" onClick={() => void action(async () => {
        await api.downloadImageSkill(run.savedSkillId!);
      })}><Download size={14} />下载 SKILL.md</button> : null}
      {run.savedSkillId ? <small>{`已保存 · $${run.savedSkillId}`}</small> : null}
    </footer>
    {saving && !run.savedSkillId ? <form className="image-skill-save" onSubmit={(event) => {
      event.preventDefault();
      void action(async () => {
        const saved = await api.saveImageSkill(conversationId, runId, name, rules);
        setRun({ ...run, savedSkillId: saved.id });
        onSaved?.(saved);
        setSaving(false);
      });
    }}>
      <label>Skill 名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 电商产品图" maxLength={80} required /></label>
      <label>以后沿用的偏好<textarea value={rules} onChange={(event) => setRules(event.target.value)} rows={3} maxLength={2200} /></label>
      <div><button type="button" className="image-skill-button" disabled={working} onClick={() => setSaving(false)}>取消</button>
        <button className="image-skill-button is-primary" disabled={working || !name.trim()}>保存 Skill</button></div>
    </form> : null}
  </section>;
}
