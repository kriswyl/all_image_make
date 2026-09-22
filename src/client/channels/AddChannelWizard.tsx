import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, LoaderCircle, Plus, Server, SlidersHorizontal, X } from "lucide-react";
import { api } from "../api";
import { adapterLabels, type ToastKind } from "../labels";
import {
  buildChannelDrafts, findConflictChannels, findProviderPreset,
  PROVIDER_PRESETS, type ChannelDraft, type UnitSelection,
} from "../../shared/provider-presets";
import type { Channel } from "../../shared/types";

type SaveMode = "create" | "skip";
type RowResult = { status: "saving" | "done" | "error"; message?: string };
type TestResult = { status: "testing" | "ok" | "error"; message?: string };

interface UnitState {
  enabled: boolean;
  models: string[];
  secretEnv: string;
  apiKey: string;
}

const stepLabels = ["选择站点", "模型组与密钥", "确认保存"];

export function AddChannelWizard({ channels, onClose, onSaved, onRemoved, onCustom, onToast }: {
  channels: Channel[];
  onClose: () => void;
  onSaved: (channel: Channel) => void;
  onRemoved: (id: string) => void;
  onCustom: () => void;
  onToast: (kind: ToastKind, message: string) => void;
}) {
  // 保存过程中父组件会刷新 channels，冲突计划以打开向导时的快照为准
  const initialChannels = useMemo(() => channels, []);
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [units, setUnits] = useState<Record<string, UnitState>>({});
  const [modes, setModes] = useState<Record<string, SaveMode>>({});
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const preset = providerId ? findProviderPreset(providerId) : undefined;

  const selections = useMemo<UnitSelection[]>(() => {
    if (!preset) return [];
    return preset.units
      .filter((unit) => units[unit.id]?.enabled)
      .map((unit) => ({
        unitId: unit.id,
        models: units[unit.id].models,
        secretEnv: units[unit.id].secretEnv,
        apiKey: units[unit.id].apiKey || undefined,
      }))
      .filter((selection) => selection.models.length > 0);
  }, [preset, units]);

  interface ReviewRow {
    draft: ChannelDraft;
    duplicate?: Channel;
    mode: SaveMode;
  }

  const reviewRows = useMemo<ReviewRow[]>(() => {
    if (!preset) return [];
    return buildChannelDrafts(preset, selections).map((draft) => {
      const duplicate = findConflictChannels(draft, initialChannels)[0];
      return { draft, duplicate, mode: modes[draft.unitId] ?? (duplicate ? "skip" : "create") };
    });
  }, [preset, selections, modes, initialChannels]);

  const selectedCount = selections.length;
  const lastStep = stepLabels.length - 1;
  const canNext = step === 0 ? Boolean(providerId) : selectedCount > 0;
  const saveFinished = Object.keys(results).length > 0;

  function selectProvider(id: string) {
    const next = findProviderPreset(id);
    if (!next) return;
    setProviderId(id);
    setUnits(Object.fromEntries(next.units.map((unit) => [unit.id, {
      enabled: unit.id !== "mj",
      models: [...unit.models],
      secretEnv: unit.secretEnv,
      apiKey: "",
    }])));
    setModes({});
  }

  function updateUnit(unitId: string, patch: Partial<UnitState>) {
    setUnits((current) => ({ ...current, [unitId]: { ...current[unitId], ...patch } }));
  }

  function addModel(unitId: string, value: string) {
    const model = value.trim();
    if (!model) return;
    setUnits((current) => {
      const state = current[unitId];
      if (state.models.includes(model)) return current;
      return { ...current, [unitId]: { ...state, models: [...state.models, model] } };
    });
  }

  async function save() {
    setSaving(true);
    setResults(Object.fromEntries(reviewRows.filter((row) => row.mode !== "skip").map((row) => [row.draft.unitId, { status: "saving" as const }])));
    let savedCount = 0;
    try {
      for (const row of reviewRows) {
        if (row.mode === "skip") continue;
        try {
          const saved = row.duplicate
            ? await api.saveChannel(row.draft.input, row.duplicate.id)
            : await api.saveChannel(row.draft.input);
          savedCount += 1;
          onSaved(saved);
          setSavedIds((current) => ({ ...current, [row.draft.unitId]: saved.id }));
          setResults((current) => ({ ...current, [row.draft.unitId]: { status: "done", message: row.duplicate ? "已覆盖更新" : "已创建" } }));
        } catch (error) {
          setResults((current) => ({ ...current, [row.draft.unitId]: { status: "error", message: error instanceof Error ? error.message : "保存失败" } }));
        }
      }
      onToast("success", `渠道配置完成：${savedCount} 个已保存`);
    } finally {
      setSaving(false);
    }
  }

  async function testAll() {
    for (const row of reviewRows) {
      const id = savedIds[row.draft.unitId];
      if (!id || results[row.draft.unitId]?.status !== "done") continue;
      setTests((current) => ({ ...current, [row.draft.unitId]: { status: "testing" } }));
      try {
        const result = await api.testChannel(id);
        setTests((current) => ({ ...current, [row.draft.unitId]: { status: "ok", message: `HTTP ${result.httpStatus}${result.durationMs != null ? ` · ${result.durationMs} ms` : ""}` } }));
      } catch (error) {
        setTests((current) => ({ ...current, [row.draft.unitId]: { status: "error", message: error instanceof Error ? error.message : "连接失败" } }));
      }
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div className="modal wizard-modal">
        <div className="modal-header">
          <div><Server size={18} /><h2>添加渠道</h2></div>
          <button type="button" className="icon-button" title="关闭" onClick={onClose} disabled={saving}><X size={18} /></button>
        </div>
        <ol className="wizard-steps">
          {stepLabels.map((label, index) => (
            <li key={label} className={`wizard-step ${index === step ? "active" : ""} ${index < step ? "passed" : ""}`}>
              <span className="wizard-step-dot">{index < step ? <CheckCircle2 size={13} /> : index + 1}</span>
              <span className="wizard-step-label">{label}</span>
            </li>
          ))}
        </ol>
        <div className="modal-body wizard-body">
          {step === 0 ? (
            <div className="preset-grid">
              {PROVIDER_PRESETS.map((item, index) => (
                <button type="button" key={item.id} className={`preset-card ${providerId === item.id ? "selected" : ""}`} onClick={() => selectProvider(item.id)}>
                  <span className={`preset-icon tone-${index % 3}`}><Server size={21} /></span>
                  <span className="preset-title">{item.label}{providerId === item.id ? <CheckCircle2 className="preset-check" size={16} /> : null}</span>
                  <span className="preset-url">{item.baseUrl}</span>
                  <span className="preset-tags">{item.units.map((unit) => <span key={unit.id} className="preset-tag">{unit.label}</span>)}</span>
                </button>
              ))}
              <button type="button" className="preset-card preset-custom" onClick={onCustom}>
                <span className="preset-icon tone-2"><SlidersHorizontal size={21} /></span>
                <span className="preset-title">自定义配置</span>
                <span className="preset-url">任意 Base URL</span>
                <span className="preset-desc">手动填写站点、协议、路径与模型，适合非标准中转站</span>
              </button>
            </div>
          ) : null}

          {step === 1 && preset ? (
            <>
              <p className="wizard-note neutral">中转站通常按模型系列分别售卖密钥，每个模型组会生成一个独立渠道并使用各自的密钥。推荐在项目 .env 中配置环境变量，密钥会随服务重启保留；直接填写的 API Key 仅保存在当前服务进程内存中。</p>
              {preset.units.map((unit) => {
                const state = units[unit.id];
                if (!state) return null;
                const envConfigured = initialChannels.some((channel) => channel.secretEnv === state.secretEnv && channel.hasKey);
                return (
                  <section key={unit.id} className={`unit-card ${state.enabled ? "" : "muted"}`}>
                    <label className="unit-head">
                      <input type="checkbox" checked={state.enabled} onChange={(event) => updateUnit(unit.id, { enabled: event.target.checked })} />
                      <span className="unit-title">{unit.label}</span>
                      <span className="unit-adapter">{adapterLabels[unit.adapterType]}</span>
                      <span className="unit-count">{state.models.length} 个模型</span>
                    </label>
                    {state.enabled ? (
                      <div className="unit-detail">
                        <span className="unit-desc">{unit.description}</span>
                        <div className="chip-row">
                          {state.models.map((model) => (
                            <span key={model} className="model-chip">
                              {model}
                              <button type="button" className="chip-remove" title="移除模型"
                                onClick={() => updateUnit(unit.id, { models: state.models.filter((item) => item !== model) })}><X size={12} /></button>
                            </span>
                          ))}
                          {!state.models.length ? <span className="wizard-hint">该组暂无模型，至少保留一个</span> : null}
                        </div>
                        <ModelInput onAdd={(value) => addModel(unit.id, value)} />
                        <div className="form-grid two key-fields">
                          <label><span><KeyRound size={12} />环境变量</span><input value={state.secretEnv} onChange={(event) => updateUnit(unit.id, { secretEnv: event.target.value })} placeholder={unit.secretEnv} /></label>
                          <label>
                            <span>API Key{envConfigured ? <em className="key-flag-inline">环境变量已配置</em> : "（可选）"}</span>
                            <input type="password" value={state.apiKey} onChange={(event) => updateUnit(unit.id, { apiKey: event.target.value })} placeholder={envConfigured ? "已配置，可留空" : preset.keyHint ?? "仅当前服务会话有效"} />
                          </label>
                        </div>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </>
          ) : null}

          {step === 2 && preset ? (
            <div className="data-table-wrap">
              <table className="data-table review-table">
                <thead><tr><th>渠道</th><th>协议</th><th>模型</th><th>密钥变量</th><th>保存方式</th><th>结果</th></tr></thead>
                <tbody>
                  {reviewRows.map((row) => {
                    const result = results[row.draft.unitId];
                    const test = tests[row.draft.unitId];
                    return (
                      <tr key={row.draft.unitId}>
                        <td><span className="table-primary">{row.draft.name}</span><span className="table-secondary">{row.draft.input.baseUrl}</span></td>
                        <td>{adapterLabels[row.draft.input.adapterType]}</td>
                        <td>{row.draft.input.models.length}</td>
                        <td><code className="mono-cell">{row.draft.input.secretEnv}</code></td>
                        <td>
                          {saveFinished ? (result?.message ?? "已跳过")
                            : row.duplicate ? (
                              <select value={row.mode} onChange={(event) => setModes((current) => ({ ...current, [row.draft.unitId]: event.target.value as SaveMode }))} disabled={saving}>
                                <option value="skip">跳过（已存在同名渠道）</option>
                                <option value="create">覆盖更新</option>
                              </select>
                            ) : "新建渠道"}
                        </td>
                        <td>
                          {result?.status === "saving" ? <LoaderCircle className="spin" size={15} />
                            : result?.status === "done" ? (
                              <span className="positive"><CheckCircle2 size={15} />{test
                                ? test.status === "testing" ? "测试中" : test.status === "ok" ? `连接正常 ${test.message}` : `连接失败：${test.message}`
                                : result.message}</span>
                            )
                            : result?.status === "error" ? <span className="warning"><AlertCircle size={15} />{result.message}</span>
                            : null}
                        </td>
                      </tr>
                    );
                  })}
                  {!reviewRows.length ? <tr><td colSpan={6}><span className="wizard-hint">没有可保存的渠道，请返回上一步选择模型组</span></td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
        <div className="modal-footer">
          {step === 1 ? <span className="wizard-summary">已选 {selectedCount} 个渠道</span> : null}
          <button type="button" className="secondary-button" onClick={step > 0 ? () => setStep((current) => current - 1) : onClose} disabled={saving}>
            {step > 0 ? <ArrowLeft size={16} /> : null}{step > 0 ? "上一步" : "取消"}
          </button>
          {step === lastStep ? (
            saveFinished ? (
              <>
                <button type="button" className="secondary-button" onClick={testAll} disabled={saving}><Server size={16} />全部测试</button>
                <button type="button" className="primary-button" onClick={onClose}><CheckCircle2 size={16} />完成</button>
              </>
            ) : (
              <button type="button" className="primary-button" onClick={save} disabled={saving || !reviewRows.length}>
                {saving ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}开始保存
              </button>
            )
          ) : (
            <button type="button" className="primary-button" onClick={() => setStep((current) => current + 1)} disabled={!canNext}>
              下一步<ArrowRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelInput({ onAdd }: { onAdd: (value: string) => void }) {
  const [value, setValue] = useState("");
  function submit() {
    if (!value.trim()) return;
    onAdd(value);
    setValue("");
  }
  return (
    <div className="model-add">
      <input value={value} placeholder="添加模型 ID"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} />
      <button type="button" className="secondary-button" onClick={submit}><Plus size={14} />添加</button>
    </div>
  );
}
