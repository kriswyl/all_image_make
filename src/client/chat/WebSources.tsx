import { ExternalLink } from "lucide-react";
import { chatWebProviderLabels, type ChatWebToolResult } from "../../shared/chat-web";
import { isTauriRuntime } from "../api";
import { openExternal } from "../external";

export function WebSources({ evidence, failed, onError }: {
  evidence: ChatWebToolResult;
  failed: boolean;
  onError?: () => void;
}) {
  return <div className="tool-card-web">
    {!failed ? <div className="tool-card-web-service">联网服务 · {chatWebProviderLabels[evidence.provider]}</div> : null}
    {evidence.attempts.length ? <ul className="tool-card-web-attempts">
      {evidence.attempts.map(attempt => <li key={attempt.provider}>{chatWebProviderLabels[attempt.provider]} · {attempt.error}</li>)}
    </ul> : null}
    {evidence.sources.length ? <ol className="tool-card-web-sources" aria-label="网页来源">
      {evidence.sources.map(source => <li key={source.url}>
        <a href={source.url} target="_blank" rel="noreferrer"
          onClick={event => {
            if (!isTauriRuntime()) return;
            event.preventDefault();
            void openExternal(source.url).catch(() => onError?.());
          }}>{source.title}<ExternalLink size={12} aria-hidden="true" /></a>
        <small>{new URL(source.url).hostname}</small>
        {source.snippet ? <p>{source.snippet}</p> : null}
      </li>)}
    </ol> : null}
  </div>;
}
