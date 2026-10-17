import { isTauriRuntime } from "./api";

/**
 * 自动更新的前端薄封装。
 *
 * 和 api.ts 里其它 Tauri 能力一样，非桌面运行时要优雅降级：网页版既没有
 * updater 插件，也不该出现「检查更新」这种点不动的入口。
 */
export const UPDATE_DOWNLOAD_PAGE = "https://github.com/kriswyl/all_image_make/releases/latest";

export type UpdateInfo = { version: string; notes: string; date?: string };
export type UpdateProgress = { downloaded: number; total: number | null };

type UpdateHandle = import("@tauri-apps/plugin-updater").Update;

/**
 * check() 拿到的 Update 是一个 Rust 侧资源，下载/安装都得用它。
 * 页面可能反复检查，新的一次结果会替换旧句柄，旧的必须先 close 释放。
 */
let pendingUpdate: UpdateHandle | null = null;

function requireDesktop() {
  if (!isTauriRuntime()) throw new Error("网页版不支持自动更新，请使用桌面版。");
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauriRuntime()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 20_000 });
  if (pendingUpdate && pendingUpdate !== update) {
    await pendingUpdate.close().catch(() => { /* 旧句柄释放失败不影响这次结果 */ });
  }
  pendingUpdate = update;
  if (!update) return null;
  return { version: update.version, notes: update.body ?? "", date: update.date };
}

/**
 * 只下载、先不安装。
 *
 * 下载是最慢的一步，而且失败率最高（网络、GitHub 抽风）。放在停后端之前做，
 * 这样下载失败时应用还是完整可用的；等下载和签名校验都通过了再动后端。
 */
export async function downloadUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  requireDesktop();
  if (!pendingUpdate) throw new Error("没有待安装的更新，请重新检查。");
  let downloaded = 0;
  let total: number | null = null;
  await pendingUpdate.download((event) => {
    if (event.event === "Started") {
      downloaded = 0;
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress({ downloaded, total });
  });
}

/** 结束内置后端并等端口释放，避免 NSIS 覆盖被 node 占着的文件 */
export async function prepareForUpdate(): Promise<void> {
  requireDesktop();
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("prepare_for_update");
}

/**
 * 安装已下载的更新包。
 * Windows 上这一步会启动 NSIS 安装器并退出应用，装完由安装器重新拉起。
 */
export async function installUpdate(): Promise<void> {
  requireDesktop();
  if (!pendingUpdate) throw new Error("没有待安装的更新，请重新检查。");
  await pendingUpdate.install({ restartAfterInstall: true });
}

export async function relaunchApp(): Promise<void> {
  requireDesktop();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}

/** 便携版不自动安装，只提示并跳下载页 */
export async function isPortableBuild(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("is_portable_build");
}

export async function openDownloadPage(): Promise<void> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(UPDATE_DOWNLOAD_PAGE);
    return;
  }
  window.open(UPDATE_DOWNLOAD_PAGE, "_blank", "noopener,noreferrer");
}
