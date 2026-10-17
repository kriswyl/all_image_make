import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, RefreshCw, X } from "lucide-react";
import { APP_VERSION } from "../shared/app-config";
import { isTauriRuntime } from "./api";
import {
  checkForUpdate, downloadUpdate, installUpdate, isPortableBuild, openDownloadPage, prepareForUpdate, relaunchApp,
} from "./updater";
import type { UpdateInfo } from "./updater";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error";

/**
 * 侧栏底部的版本号 + 更新面板。
 *
 * 启动后静默检查一次（失败完全静默，不能因为 GitHub 抽风就在启动时弹错）；
 * 发现新版本只在版本号旁边点一个小圆点，用户点开才看到详情和「下载并安装」。
 */
export function UpdateStatus() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null }>({ downloaded: 0, total: null });
  const [portable, setPortable] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const desktop = isTauriRuntime();

  const check = async (announce: boolean) => {
    if (!desktop) return;
    setPhase("checking");
    setError("");
    try {
      const result = await checkForUpdate();
      setInfo(result);
      setPhase(result ? "available" : "current");
    } catch (cause) {
      // 启动时的静默检查失败就当没这回事；用户手动点开时才把原因说出来
      setPhase(announce ? "error" : "idle");
      if (announce) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  useEffect(() => {
    if (!desktop) return;
    void isPortableBuild().then(setPortable).catch(() => {});
    // 延迟几秒再查：别和启动时的后端启动、首屏渲染抢资源
    const timer = window.setTimeout(() => { void check(false); }, 5_000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 已经有结果（有更新 / 已是最新）时直接展开，不重复请求；
    // 只有还没查过或上次失败时才在打开面板时补查一次。
    if (next && (phase === "idle" || phase === "error")) void check(true);
  };

  const startUpdate = async () => {
    if (portable) {
      await openDownloadPage().catch((cause) => {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      });
      return;
    }
    setError("");
    setProgress({ downloaded: 0, total: null });
    try {
      setPhase("downloading");
      await downloadUpdate(setProgress);
      setPhase("installing");
      // 下载和签名校验都过了才停后端：下载失败时应用仍然是完整可用的
      await prepareForUpdate();
      await installUpdate();
      // Windows 的 install() 会直接退出应用；走到这里说明是别的平台
      await relaunchApp();
    } catch (cause) {
      setPhase("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const percent = progress.total && progress.total > 0
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;
  const hasUpdate = phase === "available" && Boolean(info);
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    <div className="update-status" ref={rootRef}>
      {open ? (
        <div className="update-popover" role="dialog" aria-label="软件更新">
          <div className="update-head">
            <strong>{hasUpdate ? "有可用更新" : "软件更新"}</strong>
            <button type="button" className="update-close" aria-label="关闭" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          {!desktop ? (
            <p className="update-note">网页版不支持自动更新，请使用桌面版。</p>
          ) : phase === "checking" ? (
            <p className="update-note update-inline"><LoaderCircle size={14} className="spin" />正在检查新版本…</p>
          ) : phase === "downloading" ? (
            <div className="update-progress">
              <div className="update-progress-row">
                <span>正在下载 v{info?.version ?? ""}</span>
                <span>{percent === null ? "" : `${percent}%`}</span>
              </div>
              <div className="update-progress-track">
                <div className="update-progress-bar" style={{ width: percent === null ? "35%" : `${percent}%` }} />
              </div>
              <p className="update-note">下载完成后才会停掉本地服务并安装。</p>
            </div>
          ) : phase === "installing" ? (
            <p className="update-note update-inline"><LoaderCircle size={14} className="spin" />正在安装，应用即将自动重启…</p>
          ) : phase === "available" && info ? (
            <>
              <p className="update-version-line">
                {info.version} <span>当前 v{APP_VERSION}</span>
              </p>
              {info.notes ? <div className="update-notes">{info.notes}</div> : null}
              <div className="update-actions">
                <button type="button" className="update-primary" onClick={() => void startUpdate()}>
                  <Download size={14} />{portable ? "去下载新版本" : "下载并安装"}
                </button>
                <button type="button" className="update-secondary" onClick={() => setOpen(false)}>稍后</button>
              </div>
              {portable ? <p className="update-note">便携版不会自动覆盖安装，下载新包后替换原目录即可。</p> : null}
            </>
          ) : phase === "current" ? (
            <>
              <p className="update-note">已是最新版本 v{APP_VERSION}。</p>
              <div className="update-actions">
                <button type="button" className="update-secondary" onClick={() => void check(true)}>
                  <RefreshCw size={14} />重新检查
                </button>
                <button type="button" className="update-secondary" onClick={() => void openDownloadPage()}>打开发布页</button>
              </div>
            </>
          ) : phase === "error" ? (
            <>
              <p className="update-note update-error">{error || "检查更新失败，请稍后再试。"}</p>
              <div className="update-actions">
                <button type="button" className="update-secondary" onClick={() => void check(true)}>
                  <RefreshCw size={14} />重试
                </button>
                <button type="button" className="update-secondary" onClick={() => void openDownloadPage()}>手动下载</button>
              </div>
              {error.includes("内置后端") || error.includes("端口") ? (
                <p className="update-note">本地服务已停止，请关闭应用后重新打开，或手动安装新版本。</p>
              ) : null}
            </>
          ) : (
            <div className="update-actions">
              <button type="button" className="update-primary" onClick={() => void check(true)}>
                <RefreshCw size={14} />检查更新
              </button>
            </div>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className={`version update-trigger ${hasUpdate ? "has-update" : ""}`}
        title={desktop ? "检查更新" : "网页版不支持自动更新"}
        aria-expanded={open}
        onClick={toggle}
      >
        v{APP_VERSION}
        {hasUpdate ? <span className="update-dot" aria-label="有新版本" /> : null}
        {busy ? <LoaderCircle size={11} className="spin" /> : null}
      </button>
    </div>
  );
}
