import { useCallback, useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentStreamEvent, ChatMessage, ConversationStatus, ConversationView } from "../../shared/agent-types";
import { api } from "../api";
import type { TaskProgress } from "./ToolCard";

function upsert(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...messages, incoming].sort((left, right) => left.seq - right.seq);
  const next = messages.slice();
  next[index] = incoming;
  return next;
}

export function useConversationStream(input: {
  activeId: string | null;
  activeIdRef: Readonly<RefObject<string | null>>;
  setView: Dispatch<SetStateAction<ConversationView | null>>;
  setStatus: Dispatch<SetStateAction<ConversationStatus>>;
  reloadView: (id: string) => Promise<unknown>;
  reloadList: () => Promise<unknown>;
  toast: (kind: "ok" | "error", text: string) => void;
}) {
  const { activeId, activeIdRef, setView, setStatus, reloadView, reloadList, toast } = input;
  const [reasoning, setReasoning] = useState("");
  const [draft, setDraft] = useState("");
  const [plainStream, setPlainStream] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});

  const clearOutput = useCallback(() => {
    setReasoning("");
    setDraft("");
  }, []);

  useEffect(() => {
    if (!activeId) {
      setView(null);
      setStatus("idle");
      return;
    }
    clearOutput();
    setCompressing(false);
    setProgress({});
    void reloadView(activeId);

    let closed = false;
    const isCurrent = () => !closed && activeIdRef.current === activeId;

    const onEvent = (event: AgentStreamEvent) => {
      if (!isCurrent()) return;
      switch (event.type) {
        case "context_compression":
          setCompressing(event.status === "started");
          if (event.status === "finished") toast(/失败|不完整/.test(event.message) ? "error" : "ok", event.message);
          break;
        case "context_summary":
          setView((current) => current && current.id === activeId ? { ...current, contextSummary: { text: event.text, throughSeq: event.throughSeq } } : current);
          break;
        case "reasoning":
          setReasoning((current) => current + event.text);
          break;
        case "text_token":
          setPlainStream(true);
          setDraft((current) => current + event.text);
          break;
        case "token":
          setPlainStream(false);
          setDraft((current) => current + event.text);
          break;
        case "reset":
          // 这一轮要重来：把上一段的流式内容丢掉，别和重试后的正文拼在一起
          clearOutput();
          break;
        case "status":
          setStatus(event.status);
          break;
        case "message":
          if (event.message.conversationId !== activeId) break;
          // 已落库的助手消息接替临时输出。
          if (event.message.role === "assistant") clearOutput();
          setView((current) => current?.id === activeId
            ? { ...current, messages: upsert(current.messages, event.message) }
            : current);
          if (event.message.toolResult?.ok && event.message.toolResult.data?.continuedQuery === true) void reloadView(activeId);
          break;
        case "progress":
          setProgress((current) => ({ ...current, [event.taskId]: { status: event.status, progress: event.progress } }));
          break;
        case "error":
          toast("error", event.message);
          break;
        case "done":
          setStatus(event.status);
          clearOutput();
          // 画布指针、任务额度这些都不在事件里，落定后拉一次最稳
          void reloadView(activeId);
          void reloadList();
          break;
        default:
          break;
      }
    };

    // EventSource 会自动重连，连上后补齐错过的消息。
    const close = api.openConversationStream(activeId, {
      onEvent,
      onOpen: () => { if (isCurrent()) void reloadView(activeId); },
    });
    return () => {
      closed = true;
      close();
    };
  }, [activeId, activeIdRef, reloadView, reloadList, toast, setView, setStatus, clearOutput]);

  return { reasoning, draft, plainStream, compressing, progress, clearOutput, setDraft, setCompressing };
}
