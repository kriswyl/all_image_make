// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MusicGenerateView } from "../src/client/MusicGenerateView";
import type { SunoSourceSelection } from "../src/shared/suno";
import type { Asset, Channel, Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("带入翻唱歌词和混音源曲，并从源歌曲列表排除音效", () => {
  localStorage.clear();
  const channel = {
    id: "suno", name: "Suno", adapterType: "suno-music", enabled: true, hasKey: true,
    models: ["suno_damobi_music"], baseUrl: "https://example.test",
  } as Channel;
  const asset = (id: string, title: string, lyrics?: string): Asset => ({
    id, taskId: "music", title, lyrics, mimeType: "audio/mp4", remoteClipId: id,
    fileName: id + ".m4a", byteSize: 1, url: "/media/" + id, createdAt: "2026-01-01T00:00:00Z",
  });
  const first = asset("first", "第一首", "[Verse]\n原曲歌词");
  const second = asset("second", "第二首");
  const task: Task = {
    id: "music", channelId: channel.id, channelName: channel.name, model: channel.models[0]!, prompt: "测试",
    status: "succeeded", progress: 100, effectiveParameters: { mv: "chirp-hawk" }, attemptCount: 1,
    errorCode: null, errorMessage: null, assets: [first, second], createdAt: first.createdAt,
    startedAt: null, finishedAt: first.createdAt,
  };
  const sound = { ...task, id: "sound", effectiveParameters: { task: "sound" }, assets: [asset("rain", "雨声")] };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSourceSelectionApplied = vi.fn();
  const render = (sourceSelection: SunoSourceSelection) => act(() => root.render(createElement(MusicGenerateView, {
    channels: [channel], tasks: [task, sound], activeTask: task, selectedChannelId: channel.id,
    selectedModel: task.model, sourceSelection, onSourceSelectionApplied,
    onChannelChange: vi.fn(), onModelChange: vi.fn(), onAddChannel: vi.fn(), onConfigureChannel: vi.fn(),
    onTask: vi.fn(), onSelectTask: vi.fn(), onToast: vi.fn(), onDiagnostics: vi.fn(),
  })));
  try {
    render({ mode: "cover", task, asset: first });
    expect(container.querySelector<HTMLTextAreaElement>("#music-prompt")?.value).toBe(first.lyrics);
    expect(container.querySelector(".song-option[aria-pressed=true]")?.textContent).toContain("第一首");
    expect(container.querySelector(".song-picker")?.textContent).not.toContain("雨声");
    render({ mode: "mashup", task, asset: first });
    render({ mode: "mashup", task, asset: second });
    expect(container.querySelector<HTMLTextAreaElement>("#music-prompt")?.value).toBe("");
    expect(container.querySelectorAll(".song-option[aria-pressed=true]")).toHaveLength(2);
    expect(onSourceSelectionApplied).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  }
});
