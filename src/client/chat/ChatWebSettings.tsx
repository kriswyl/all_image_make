import { useEffect, useState } from "react";
import { CHAT_WEB_PROVIDERS, chatWebProviderLabels, type ChatWebProvider, type ChatWebSettings as WebSettings } from "../../shared/chat-web";
import { api } from "../api";

export function ChatWebSettings({ disabled }: { disabled?: boolean }) {
  const [settings, setSettings] = useState<WebSettings>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.chatWebSettings().then(value => { if (!cancelled) setSettings(value); })
      .catch(() => { if (!cancelled) setError("无法读取联网服务设置"); });
    return () => { cancelled = true; };
  }, []);

  async function save(removeKey = false) {
    if (!settings || busy || disabled) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      setSettings(await api.updateChatWebSettings({
        preferred: settings.preferred,
        fallback: settings.fallback,
        ...(removeKey ? { tavilyKey: "" } : key.trim() ? { tavilyKey: key.trim() } : {}),
      }));
      setKey("");
      setSaved(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法保存联网服务设置");
    } finally {
      setBusy(false);
    }
  }

  const canUseTavily = settings?.hasTavilyKey || Boolean(key.trim());
  return <div className="chat-web-settings">
    {error ? <small role="alert">{error}</small> : null}
    {settings ? <fieldset disabled={disabled || busy} onChange={() => setSaved(false)}>
      <label>首选服务
        <select aria-label="首选联网服务" value={settings.preferred} onChange={event => setSettings({ ...settings, preferred: event.target.value as ChatWebProvider })}>
          {CHAT_WEB_PROVIDERS.map(provider => <option key={provider} value={provider} disabled={provider === "tavily" && !canUseTavily}>{chatWebProviderLabels[provider]}</option>)}
        </select>
      </label>
      <label>首选失败时切换
        <input type="checkbox" checked={settings.fallback} disabled={!canUseTavily} onChange={event => setSettings({ ...settings, fallback: event.target.checked })} />
      </label>
      <label className="chat-web-key">Tavily API Key
        <input type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key}
          placeholder={settings.hasTavilyKey ? "已保存，填写可替换" : "填入你自己的 Key"}
          onChange={event => {
            const next = event.target.value;
            setKey(next);
            if (!next.trim() && !settings.hasTavilyKey) setSettings({ ...settings, preferred: "firecrawl", fallback: false });
          }} />
      </label>
      <small>应用内对话共用这组服务设置。Firecrawl 按出口 IP 限流，Tavily 使用所填账号的额度。</small>
      <div className="chat-web-settings-actions">
        <button type="button" className="secondary-button compact" onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button>
        {settings.hasTavilyKey ? <button type="button" className="secondary-button compact" onClick={() => void save(true)}>移除 Key</button> : null}
        {saved ? <small role="status">已保存</small> : null}
      </div>
    </fieldset> : !error ? <small role="status">正在读取设置…</small> : null}
  </div>;
}
