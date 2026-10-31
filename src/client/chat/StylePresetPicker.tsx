/**
 * 风格模板选择器（下拉 + 管理弹窗）。
 *
 * 分镜和画布都用它：下拉里选一个模板，弹窗里维护自定义模板。
 * 内置模板只读——用户改坏了没有恢复入口会很麻烦，想改就先复制一份。
 */
import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { StylePreset, StylePresetInput } from "../../shared/style-presets";

const EMPTY: StylePresetInput = { name: "", description: "", prompt: "", negative: "" };

export function StylePresetPicker({
  value, valueName, onChange, onPresets, label = "风格模板", disabled = false, toast,
}: {
  /** 当前选中的模板 id；空串 = 不套风格 */
  value: string;
  /** 只知道名字时用它反查（分镜的 brief.style 存的是名字） */
  valueName?: string;
  /** 列表加载/变更后回调：父组件要用它反查「上一套风格」的原文才能剥干净 */
  onPresets?: (list: StylePreset[]) => void;
  onChange: (preset: StylePreset | null) => void;
  label?: string;
  disabled?: boolean;
  toast?: (kind: "success" | "error", message: string) => void;
}) {
  const [presets, setPresets] = useState<StylePreset[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StylePreset | null>(null);
  const [form, setForm] = useState<StylePresetInput>(EMPTY);
  const [busy, setBusy] = useState(false);

  const load = () => api.stylePresets().then((list) => { setPresets(list); onPresets?.(list); }).catch(() => undefined);
  const currentId = value || presets.find((item) => item.name === valueName)?.id || "";
  useEffect(() => { void load(); }, []);

  const startEdit = (preset: StylePreset | null) => {
    setEditing(preset);
    setForm(preset
      ? { name: preset.name, description: preset.description, prompt: preset.prompt, negative: preset.negative }
      : { ...EMPTY });
  };

  const save = async () => {
    if (!form.name.trim() || !form.prompt.trim()) { toast?.("error", "名称和风格描述都要填"); return; }
    setBusy(true);
    try {
      const saved = editing
        ? await api.updateStylePreset(editing.id, form)
        : await api.createStylePreset(form);
      await load();
      setEditing(saved);
      onChange(saved);
      toast?.("success", editing ? "已保存" : "已新建并选中");
    } catch (error) {
      toast?.("error", error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing.builtin) return;
    if (!window.confirm(`删除风格「${editing.name}」？已经套用的提示词不会回滚。`)) return;
    setBusy(true);
    try {
      await api.deleteStylePreset(editing.id);
      await load();
      if (currentId === editing.id) onChange(null);
      setEditing(null);
      setForm({ ...EMPTY });
      toast?.("success", "已删除");
    } catch (error) {
      toast?.("error", error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="style-preset-field">
      <select
        aria-label={label}
        value={currentId}
        disabled={disabled}
        onChange={(event) => onChange(presets.find((item) => item.id === event.target.value) ?? null)}
      >
        <option value="">不套风格</option>
        {presets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button type="button" className="style-preset-manage" disabled={disabled} onClick={() => { setOpen(true); startEdit(presets.find((item) => item.id === currentId) ?? null); }}>
        管理
      </button>

      {open ? createPortal(
        <div className="style-preset-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="style-preset-dialog" role="dialog" aria-modal="true" aria-label="风格模板">
            <header>
              <strong>风格模板</strong>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setOpen(false)}><X size={16} /></button>
            </header>
            <div className="style-preset-body">
              <div className="style-preset-list">
                {presets.map((item) => (
                  <button type="button" key={item.id} className={editing?.id === item.id ? "is-active" : ""} onClick={() => startEdit(item)}>
                    <span>{item.name}</span>
                    {item.builtin ? <em>内置</em> : null}
                  </button>
                ))}
                <button type="button" className="style-preset-new" onClick={() => startEdit(null)}><Plus size={13} />新建</button>
              </div>
              <div className="style-preset-form">
                <label>名称<input value={form.name} maxLength={40} disabled={editing?.builtin} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
                <label>说明<input value={form.description} maxLength={120} disabled={editing?.builtin} placeholder="适合什么片" onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
                <label>风格描述（拼在提示词末尾）<textarea rows={4} value={form.prompt} maxLength={400} disabled={editing?.builtin} onChange={(event) => setForm({ ...form, prompt: event.target.value })} /></label>
                <label>负面词（可选）<input value={form.negative} maxLength={200} disabled={editing?.builtin} onChange={(event) => setForm({ ...form, negative: event.target.value })} /></label>
                <div className="style-preset-actions">
                  {editing?.builtin ? <small>内置模板只读，想改就新建一个。</small> : null}
                  <span />
                  {editing && !editing.builtin ? <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void remove()}><Trash2 size={13} />删除</button> : null}
                  <button type="button" className="secondary-button compact" disabled={busy || editing?.builtin} onClick={() => void save()}>{busy ? "保存中…" : editing ? "保存" : "新建"}</button>
                </div>
              </div>
            </div>
          </section>
        </div>, document.body) : null}
    </div>
  );
}
