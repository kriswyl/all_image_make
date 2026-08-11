import type { ApiResponse, BootstrapData, Channel, ChannelInput, Diagnostic, GenerationInput, Task } from "../shared/types";

const apiBase = import.meta.env.VITE_API_BASE_URL
  || (typeof window !== "undefined" && (window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost")
    ? "http://127.0.0.1:17892"
    : "");

function apiUrl(url: string) {
  return `${apiBase}${url}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload.data;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  saveChannel: (input: ChannelInput, id?: string) => request<Channel>(id ? `/api/channels/${id}` : "/api/channels", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(input),
  }),
  deleteChannel: (id: string) => request<{ deleted: true }>(`/api/channels/${id}`, { method: "DELETE" }),
  testChannel: (id: string) => request<{ reachable: boolean; httpStatus: number; durationMs?: number; message?: string }>(`/api/channels/${id}/test`, { method: "POST" }),
  generate: (input: GenerationInput) => request<Task>("/api/generations", { method: "POST", body: JSON.stringify(input) }),
  task: (id: string) => request<Task>(`/api/generations/${id}`),
  tasks: () => request<Task[]>("/api/generations"),
  cancel: (id: string) => request<Task>(`/api/generations/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<Task>(`/api/generations/${id}/retry`, { method: "POST" }),
  diagnostics: (id: string) => request<Diagnostic[]>(`/api/generations/${id}/diagnostics`),
  assetUrl: (url: string) => apiUrl(url),
};
