import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, Server, X } from "lucide-react";
import { api } from "../api";
import { VECTORENGINE_KEY_ENV, VECTORENGINE_KEY_PLACEHOLDER } from "../../shared/app-config";
import { adapterDefaultEndpoint } from "../../shared/provider-presets";
import { adapterLabels } from "../labels";
import type { AdapterType, Channel, ChannelInput } from "../../shared/types";

export function ChannelDialog({ channel, onClose, onSaved }: { channel: Channel | null; onClose: () => void; onSaved: (channel: Channel) => void }) {
  const [form, setForm] = useState(() => ({
    name: channel?.name ?? "", baseUrl: channel?.baseUrl ?? "", adapterType: channel?.adapterType ?? "openai-images" as AdapterType,
    authType: channel?.authType ?? "bearer" as ChannelInput["authType"], authHeaderName: channel?.authHeaderName ?? "",
    secretEnv: channel?.secretEnv ?? VECTORENGINE_KEY_ENV, endpoint: channel?.endpoint ?? "",
    modelsText: channel?.models.join("\n") ?? "", apiKey: "", allowPrivateNetwork: channel?.allowPrivateNetwork ?? false, enabled: channel?.enabled ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const defaults = useMemo(() => adapterDefaultEndpoint(form.adapterType), [form.adapterType]);

  function update<K extends keyof typeof form>(key: K, value: typeof form[K]) { setForm((current) => ({ ...current, [key]: value })); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const models = [...new Set(form.modelsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
    if (!models.length) return;
    setSaveError("");
    setSaving(true);
    try {
      const saved = await api.saveChannel({
        name: form.name, baseUrl: form.baseUrl, adapterType: form.adapterType, authType: form.authType,
        authHeaderName: form.authHeaderName, secretEnv: form.secretEnv, endpoint: form.endpoint || defaults.endpoint,
        models, apiKey: form.apiKey || undefined,
        allowPrivateNetwork: form.allowPrivateNetwork, enabled: form.enabled,
      }, channel?.id);
      onSaved(saved);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请检查配置后重试");
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal channel-modal" onSubmit={save}>
        <div className="modal-header"><div><Server size={18} /><h2>{channel ? "编辑渠道" : "添加渠道"}</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="form-grid two"><label><span>名称</span><input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="中转渠道" /></label><label><span>适配器</span><select value={form.adapterType} onChange={(event) => update("adapterType", event.target.value as AdapterType)}>{Object.entries(adapterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label><span>Base URL</span><input required type="url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://relay.example.com" /></label>
          <div className="form-grid two"><label><span>生成路径</span><input value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder={defaults.endpoint} /></label><label><span>鉴权方式</span><select value={form.authType} onChange={(event) => update("authType", event.target.value as ChannelInput["authType"])}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom-header">自定义 Header</option><option value="query">Query 参数</option><option value="none">无需鉴权</option></select></label></div>
          {form.authType !== "none" ? <div className="form-grid two"><label><span>环境变量</span><input value={form.secretEnv} onChange={(event) => update("secretEnv", event.target.value)} placeholder={VECTORENGINE_KEY_ENV} /></label><label><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={channel?.hasKey ? "已配置，留空不修改" : form.baseUrl.includes("vectorengine.cn") ? VECTORENGINE_KEY_PLACEHOLDER : "仅保存在本次服务会话"} /></label></div> : null}
          {form.authType === "custom-header" || form.authType === "query" ? <label><span>{form.authType === "query" ? "参数名" : "Header 名称"}</span><input value={form.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder={form.authType === "query" ? "key" : "x-api-key"} /></label> : null}
          <label><span>模型 ID</span><textarea required className="models-input" value={form.modelsText} onChange={(event) => update("modelsText", event.target.value)} placeholder={"每行一个模型，例如：\ngpt-image-2\ngemini-image"} /></label>
          <div className="toggle-row"><Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用渠道" /><Toggle checked={form.allowPrivateNetwork} onChange={(value) => update("allowPrivateNetwork", value)} label="允许本地/内网地址" /></div>
          {saveError ? <div className="form-error" role="alert"><AlertCircle size={16} />{saveError}</div> : null}
        </div>
        <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <CheckCircle2 size={17} />}保存</button></div>
      </form>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><span /></span><span>{label}</span></label>;
}
