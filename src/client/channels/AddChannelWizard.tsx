import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, KeyRound, Plus, Server, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { adapterLabels, type ToastKind } from "../labels";
import {
  buildChannelDrafts, findConflictChannels, findProviderPreset,
  ONE_KEY_PRESET, ONE_KEY_SECRET_ENV, PROVIDER_PRESETS, type ChannelDraft, type UnitSelection,
} from "../../shared/provider-presets";
import { channelKindOf, type Channel } from "../../shared/types";
import type { ModelGroupKind } from "../../shared/model-catalog";
import { ModelLogo, modelBrand } from "../chat/ModelLogo";
import { SelectMenu } from "../ui/SelectMenu";
import { openExternal } from "../external";

type SaveMode = "create" | "skip";

/**
 * 渠道单元按用途分组。
 *
 * 一个中转站常常同时卖好几类密钥，平铺十来张卡片时「我要找的那个视频模型组在哪」
 * 全靠肉眼扫。分组之后一眼定位；音乐和语音虽然都是音频任务，但模型完全不同，
 * 选模型时也分开两栏，避免把 Gemini 的配音模型当成写歌的。
 */
const UNIT_GROUPS: ReadonlyArray<{ kind: ModelGroupKind; label: string }> = [
  { kind: "chat", label: "对话（当大脑用）" },
  { kind: "image", label: "生图" },
  { kind: "video", label: "视频" },
  { kind: "music", label: "音乐" },
  { kind: "speech", label: "语音" },
];

function unitGroupOf(adapterType: string): ModelGroupKind {
  if (adapterType === "suno-music") return "music";
  if (adapterType === "gemini-tts") return "speech";
  return channelKindOf(adapterType) as ModelGroupKind;
}
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
  /** 一 key 模式下的唯一密钥；单站点模板仍按单元各填各的 */
  const [sharedKey, setSharedKey] = useState("");
  const [modes, setModes] = useState<Record<string, SaveMode>>({});
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const preset = providerId ? findProviderPreset(providerId) : undefined;
  const keyUrl = preset?.keyUrl;
  const singleKey = Boolean(preset?.singleKey);

  const selections = useMemo<UnitSelection[]>(() => {
    if (!preset) return [];
    return preset.units
      .filter((unit) => units[unit.id]?.enabled)
      .map((unit) => ({
        unitId: unit.id,
        models: units[unit.id].models,
        secretEnv: units[unit.id].secretEnv,
        // 一 key 模式下所有单元拿同一把密钥；单站点模板各填各的
        apiKey: (preset.singleKey ? sharedKey.trim() : units[unit.id].apiKey) || undefined,
      }))
      .filter((selection) => selection.models.length > 0);
  }, [preset, units, sharedKey]);

  interface ReviewRow {
    draft: ChannelDraft;
    duplicate?: Channel;
    mode: SaveMode;
  }

  const reviewRows = useMemo<ReviewRow[]>(() => {
    if (!preset) return [];
    return buildChannelDrafts(preset, selections).map((draft) => {
      const duplicate = findConflictChannels(draft, initialChannels)[0];
      return { draft, duplicate, mode: modes[draft.unitId] ?? (duplicate && duplicate.name.trim() !== draft.name.trim() ? "skip" : "create") };
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
    setSharedKey("");
    setUnits(Object.fromEntries(next.units.map((unit) => [unit.id, {
      enabled: unit.id !== "mj",
      models: [...unit.models],
      secretEnv: unit.secretEnv,
      apiKey: "",
    }])));
    setModes({});
    setResults({});
    setSavedIds({});
    setTests({});
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
    setResults(Object.fromEntries(reviewRows.map((row) => [row.draft.unitId, row.mode === "skip"
      ? { status: "done" as const, message: "已跳过" }
      : { status: "saving" as const }])));
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
        <div
          key={step}
          className={`modal-body wizard-body${step === lastStep ? " wizard-review-body" : ""}`}
          tabIndex={step === lastStep ? 0 : undefined}
          role={step === lastStep ? "region" : undefined}
          aria-label={step === lastStep ? "渠道保存清单" : undefined}
        >
          {step === 0 ? (
            <>
              {/* 一 key 模式放在最上面、单独一档：大多数人只有一个中转站密钥，
                  却在下面十几张「按模型分组」的卡片里找自己属于哪一张 */}
              <section className="onekey-hero-wrap">
                <button
                  type="button"
                  className={`onekey-hero ${providerId === ONE_KEY_PRESET.id ? "is-selected" : ""}`}
                  onClick={() => selectProvider(ONE_KEY_PRESET.id)}
                >
                  <span className="onekey-hero-icon"><KeyRound size={22} /></span>
                  <span className="onekey-hero-text">
                    <span className="onekey-hero-title">
                      一 Key 全开
                      <em><Sparkles size={12} />推荐</em>
                    </span>
                    <span className="onekey-hero-desc">
                      只填一个密钥，自动配好 {ONE_KEY_PRESET.units.length} 个渠道 —— 生图、视频、音乐、语音、对话全部可用
                    </span>
                    <span className="onekey-hero-tags">
                      {ONE_KEY_PRESET.units.slice(0, 6).map((unit) => (
                        <span key={unit.id}>{unit.label}</span>
                      ))}
                      <span>等 {ONE_KEY_PRESET.units.length} 类</span>
                    </span>
                  </span>
                  <span className="onekey-hero-side">
                    <span className="onekey-hero-url">{ONE_KEY_PRESET.baseUrl.replace(/^https?:\/\//, "")}</span>
                    {providerId === ONE_KEY_PRESET.id
                      ? <span className="onekey-hero-go"><CheckCircle2 size={15} />已选</span>
                      : <span className="onekey-hero-go">下一步填 Key<ArrowRight size={14} /></span>}
                  </span>
                </button>
              </section>

              {/* 模板按用途分组：站点在每张卡片自己身上写着（「词元流墟-万相视频」），
                  但平铺成一格一格时，想找「哪个是视频」还是得逐张读——分一层就一眼定位 */}
              {UNIT_GROUPS.map((group) => {
                const items = PROVIDER_PRESETS.filter((item) => unitGroupOf(item.units[0]?.adapterType ?? "") === group.kind);
                if (!items.length) return null;
                return (
                  <section key={group.kind} className="preset-group">
                    <h3 className="unit-group-title">{group.label}<span>{items.length}</span></h3>
                    <div className="preset-grid">
              {items.map((item, index) => {
                // 卡片主图标用模型组自己的牌子（Suno / Gemini / GPT…），
                // 同一站点的十张卡才不会全是同一枚紫色方块；认不出再退回站点图标。
                const unit = item.units[0];
                const brand = unit?.models[0]
                  ? modelBrand(unit.models[0], channelKindOf(unit.adapterType))
                  : null;
                const icon = brand?.logo ?? item.logo;
                return (
                  <button type="button" key={item.id} className={`preset-card ${providerId === item.id ? "selected" : ""}`} onClick={() => selectProvider(item.id)}>
                    {group.kind === "chat" ? <span className="preset-chat-brands" aria-label="支持 DeepSeek、Gemini、GPT 和 Claude">
                      {unit.models.map((model) => <span className="preset-chat-brand" key={model}><ModelLogo model={model} kind="chat" size={19} /></span>)}
                    </span> : <span className={`preset-icon ${icon ? "has-logo" : `tone-${index % 3}`}`}>
                      {icon ? <img src={icon} alt="" loading="lazy" decoding="async" /> : <Server size={21} />}
                    </span>}
                    <span className="preset-title">{item.label}{providerId === item.id ? <CheckCircle2 className="preset-check" size={16} /> : null}</span>
                    <span className="preset-url">{item.baseUrl}</span>
                    {group.kind === "chat" ? <span className="preset-chat-description">DeepSeek · Gemini · GPT · Claude</span> : null}
                    <span className="preset-tags">
                      {item.units.map((entry) => (
                        <span key={entry.id} className="preset-tag">{entry.label}</span>
                      ))}
                    </span>
                  </button>
                );
              })}
                    </div>
                  </section>
                );
              })}
              <div className="preset-grid">
              <button type="button" className="preset-card preset-custom" onClick={onCustom}>
                <span className="preset-icon tone-2"><SlidersHorizontal size={21} /></span>
                <span className="preset-title">自定义配置</span>
                <span className="preset-url">任意 Base URL</span>
                <span className="preset-desc">手动填写站点、协议、路径与模型，适合非标准中转站</span>
              </button>
              </div>
            </>
          ) : null}

          {step === 1 && preset ? (
            <>
              {singleKey ? (
                <section className="onekey-key-panel">
                  <div className="onekey-key-head">
                    <span className="onekey-key-icon"><KeyRound size={16} /></span>
                    <div>
                      <strong>填一次密钥，{selections.length || preset.units.length} 个渠道共用</strong>
                      <small>
                        {preset.baseUrl} · 密钥只存在本机数据目录；想给不同模型用不同密钥，回去选「按站点模板」。
                      </small>
                    </div>
                  </div>
                  <label className="key-input-field">
                    <span><KeyRound size={12} />API Key</span>
                    <input
                      className="key-input onekey-key-input"
                      type="password"
                      value={sharedKey}
                      autoFocus
                      onChange={(event) => setSharedKey(event.target.value)}
                      placeholder={preset.keyHint ?? "在此填入密钥"}
                      autoComplete="off"
                    />
                  </label>
                  {keyUrl ? <button type="button" className="secondary-button" onClick={() => void openExternal(keyUrl)}>去创建 API Key</button> : null}
                  <span className="onekey-key-hint">
                    已有渠道的环境变量 <code className="mono-cell">{ONE_KEY_SECRET_ENV}</code> 也可以留空，服务端会按它兜底。
                  </span>
                </section>
              ) : (
                <p className="wizard-note neutral">每个模型组填上自己的 API Key 即可，密钥保存在本机数据目录，重启后自动载入。</p>
              )}
              {preset.units.map((unit) => {
                const state = units[unit.id];
                if (!state) return null;
                const envConfigured = initialChannels.some((channel) => channel.secretEnv === state.secretEnv && channel.hasKey);
                return (
                  <section key={unit.id} className={`unit-card ${state.enabled ? "" : "muted"} ${singleKey ? "is-onekey" : ""}`}>
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
                        {/* 一 key 模式：密钥和变量名都在上面填一次，这里不再重复出现 */}
                        {singleKey ? null : (
                          <div className="form-grid two key-fields">
                            <label><span><KeyRound size={12} />环境变量</span><input value={state.secretEnv} onChange={(event) => updateUnit(unit.id, { secretEnv: event.target.value })} placeholder={unit.secretEnv} /></label>
                            {/* 密钥是整步里唯一必须动手填的东西，视觉上要压过旁边的环境变量框 */}
                            <label className="key-input-field">
                              <span>
                                <KeyRound size={12} />API Key
                                {envConfigured ? <em className="key-flag-inline">环境变量已配置</em> : <em className="key-required-flag">在此填写</em>}
                              </span>
                              <input
                                className="key-input"
                                type="password"
                                value={state.apiKey}
                                onChange={(event) => updateUnit(unit.id, { apiKey: event.target.value })}
                                placeholder={envConfigured ? "已配置，可留空" : preset.keyHint ?? "在此填入密钥"}
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </>
          ) : null}

          {step === 2 && preset ? (
            <div className="data-table-wrap">
              {singleKey && !sharedKey.trim() ? (
                <p className="wizard-note warning">
                  还没填 Key。保存后这些渠道会读环境变量 <code className="mono-cell">{ONE_KEY_SECRET_ENV}</code>；没有配置的话，生成时才会报「没有可用的 API Key」。
                </p>
              ) : null}
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
                              <div className="wizard-conflict-action">
                                <SelectMenu value={row.mode} ariaLabel={`保存方式：${row.draft.name}`} disabled={saving} minWidth={140}
                                  options={[{ value: "create", label: "覆盖更新" }, { value: "skip", label: "跳过" }]}
                                  onChange={(value) => setModes((current) => ({ ...current, [row.draft.unitId]: value as SaveMode }))} />
                                <span title={row.duplicate.name}>已有：{row.duplicate.name}</span>
                                <span title={row.duplicate.baseUrl}>{row.duplicate.baseUrl}</span>
                              </div>
                            ) : "新建渠道"}
                        </td>
                        <td>
                          {result?.status === "saving" ? <LoadingIndicator variant="dots" size={24} />
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
                {saving ? <LoadingIndicator variant="dots" size={24} /> : <CheckCircle2 size={16} />}开始保存
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
