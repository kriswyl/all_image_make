import type { ApiResponse, Asset, BootstrapData, Channel, ChannelInput, Diagnostic, GenerationInput, Task } from "../shared/types";

const apiBase = import.meta.env.VITE_API_BASE_URL
  || (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost")
    ? "http://127.0.0.1:17892"
    : "");

function apiUrl(url: string) {
  return `${apiBase}${url}`;
}

function isTauriRuntime() {
  return typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window
      || window.location.protocol === "tauri:"
      || window.location.hostname === "tauri.localhost");
}

function imageExtension(asset: Asset) {
  const fileExtension = asset.fileName.split(".").pop()?.toLowerCase();
  if (fileExtension && /^[a-z0-9]+$/.test(fileExtension)) return fileExtension;
  if (asset.mimeType === "image/jpeg") return "jpg";
  if (asset.mimeType === "image/webp") return "webp";
  return "png";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const response = await fetch(apiUrl(url), {
    ...init,
    headers: isFormData ? { ...(init?.headers ?? {}) } : { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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
  generate: (input: GenerationInput, referenceFiles: File[] = []) => {
    if (!referenceFiles.length) return request<Task>("/api/generations", { method: "POST", body: JSON.stringify(input) });
    const formData = new FormData();
    const payload = { ...input, referenceImages: undefined, referenceImage: undefined };
    formData.append("payload", JSON.stringify(payload));
    referenceFiles.forEach((file) => formData.append("referenceImages", file, file.name));
    return request<Task>("/api/generations", { method: "POST", body: formData });
  },
  task: (id: string) => request<Task>(`/api/generations/${id}`),
  tasks: () => request<Task[]>("/api/generations"),
  cancel: (id: string) => request<Task>(`/api/generations/${id}/cancel`, { method: "POST" }),
  retry: (id: string) => request<Task>(`/api/generations/${id}/retry`, { method: "POST" }),
  diagnostics: (id: string) => request<Diagnostic[]>(`/api/generations/${id}/diagnostics`),
  assetUrl: (url: string) => apiUrl(url),
  downloadAsset: async (asset: Asset) => {
    const separator = asset.url.includes("?") ? "&" : "?";

    if (isTauriRuntime()) {
      const [{ save }, { writeFile }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
      ]);
      const extension = imageExtension(asset);
      const destination = await save({
        title: "保存图片",
        defaultPath: asset.fileName,
        filters: [{ name: "图片", extensions: [extension] }],
      });
      if (!destination) return false;

      const response = await fetch(apiUrl(`${asset.url}${separator}download=1`));
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
      return true;
    }

    const response = await fetch(apiUrl(`${asset.url}${separator}download=1`));
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = asset.fileName;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    return true;
  },
};
