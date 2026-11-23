import { Check, Upload, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "../../shared/types";
import type { VideoReuseKind, VideoReuseSlot, VideoTaskReuse } from "../../shared/video-reuse";
import { api } from "../api";
import { LoadingScreen } from "../task-ui";
import { referenceImageMimeType } from "../app-shared";
import { referenceMediaType } from "../../shared/reference-media";
import { withReferenceMediaType } from "../media-files";
import { mediaDuration } from "./media-builders";

export interface ReuseFile {
  slot: VideoReuseSlot;
  file?: File;
  duration?: number;
  problem?: string;
  replaced?: boolean;
}

const roleLabels: Record<string, string> = { first_frame: "首帧", last_frame: "尾帧", reference_image: "参考图", image: "角色图" };
const kindLabels: Record<VideoReuseKind, string> = { image: "参考图", video: "参考视频", audio: "参考音频" };
const accept: Record<VideoReuseKind, string> = { image: "image/png,image/jpeg,image/webp", video: ".mp4,.mov", audio: ".mp3,.wav,.m4a,.aac" };

async function readDuration(file: File, kind: VideoReuseKind) {
  return kind !== "image" && file.size ? mediaDuration(file, kind) : 0;
}

export function VideoTaskReuseDialog({ task, onClose, onApply }: {
  task: Task;
  onClose: () => void;
  onApply: (data: VideoTaskReuse, files: ReuseFile[]) => void;
}) {
  const titleId = useId();
  const close = useRef<HTMLButtonElement>(null);
  const [data, setData] = useState<VideoTaskReuse | null>(null);
  const [entries, setEntries] = useState<ReuseFile[] | null>(null);
  const [problem, setProblem] = useState("");
  const [replacing, setReplacing] = useState<number | null>(null);
  const [acceptOmissions, setAcceptOmissions] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const opener = document.activeElement;
    close.current?.focus();
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      try {
        const details = await api.videoTaskReuse(task.id, signal);
        if (signal.aborted) return;
        setData(details);
        const files: ReuseFile[] = [];
        for (const slot of details.slots) {
          if (signal.aborted) return;
          if (!slot.available) { files.push({ slot, problem: slot.reason }); continue; }
          try {
            const blob = await api.videoTaskReuseFile(task.id, slot.index, signal);
            const file = new File([blob], slot.name, { type: slot.mimeType ?? blob.type });
            if (!file.size) throw new Error("素材为空");
            files.push({ slot, file, duration: await readDuration(file, slot.kind) });
          } catch { files.push({ slot, problem: "原素材无法读取，请重新选择" }); }
        }
        if (!signal.aborted) setEntries(files);
      } catch (error) {
        if (!signal.aborted) setProblem(error instanceof Error ? error.message : "无法读取历史任务");
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [task.id]);

  async function replace(slot: VideoReuseSlot, file: File) {
    setReplacing(slot.index);
    setProblem("");
    try {
      if (slot.kind === "image" ? !referenceImageMimeType(file) : referenceMediaType(file)?.kind !== slot.kind) {
        throw new Error(`请选择受支持的${kindLabels[slot.kind]}文件`);
      }
      const limit = slot.kind === "image" ? 20 : slot.kind === "video" ? 100 : 15;
      if (!file.size || file.size > limit * 1024 * 1024) throw new Error(`单个${kindLabels[slot.kind]}需小于 ${limit} MB`);
      const typed = slot.kind === "image" ? file : withReferenceMediaType(file);
      const duration = await readDuration(typed, slot.kind);
      if (mounted.current) setEntries((current) => current?.map((entry) => entry.slot.index === slot.index ? { slot, file: typed, duration, replaced: true } : entry) ?? null);
    } catch (error) {
      if (mounted.current) setProblem(error instanceof Error ? error.message : "素材读取失败");
    } finally { if (mounted.current) setReplacing(null); }
  }

  const missing = entries?.filter((entry) => !entry.file).length ?? 0;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal video-reuse-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
        <header className="modal-header"><h2 id={titleId}>以此任务新建</h2>
          <button ref={close} type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="modal-body">
          <p className="modal-lead">{task.channelName} · {task.model}</p>
          {data?.unsupportedReason ? <p className="form-error" role="alert">{data.unsupportedReason}</p> : null}
          {problem ? <p className="form-error" role="alert">{problem}</p> : null}
          {!entries && !problem ? <LoadingScreen compact /> : null}
          {entries?.length ? <ul className="conversation-trash-list">{entries.map(({ slot, file, problem: missingReason, replaced }) => (
            <li key={slot.index}>
              <div className="conversation-trash-info"><strong>{roleLabels[slot.role] ?? kindLabels[slot.kind]} · {file?.name ?? slot.name}</strong>
                {missingReason ? <small>{missingReason}</small> : null}
              </div>
              <div className="conversation-trash-actions">
              {file ? <span className="positive"><Check size={14} /> {replaced ? "已补齐" : "已找回"}</span> : null}
              <label className="secondary-button compact video-reuse-file">
                <Upload size={14} />{file ? "更换" : "重新选择"}
                <input type="file" accept={accept[slot.kind]} disabled={replacing !== null} onChange={(event) => {
                  const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
                  if (file) void replace(slot, file);
                }} />
              </label></div>
            </li>
          ))}</ul> : null}
          {data?.omittedRawFields.length ? <label className="video-reuse-omissions">
            <input type="checkbox" checked={acceptOmissions} onChange={(event) => setAcceptOmissions(event.currentTarget.checked)} />
            <span>我会在创作框中重新核对素材。历史高级参数覆盖了素材字段（{data.omittedRawFields.join("、")}）。</span>
          </label> : null}
          {entries ? <p className="modal-lead">应用后会替换对应模式的当前输入，确认生成时才会提交。</p> : null}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={!data || !entries || missing > 0 || replacing !== null || Boolean(data.unsupportedReason) || (data.omittedRawFields.length > 0 && !acceptOmissions)}
            onClick={() => { if (data && entries) onApply(data, entries); }}>{missing ? `补齐 ${missing} 项素材后应用` : "应用到创作框"}</button>
        </footer>
      </section>
    </div>, document.body,
  );
}
