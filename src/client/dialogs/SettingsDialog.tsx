import { useEffect, useState } from "react";
import { AlertCircle, Eye, FolderOpen, Monitor, Moon, RotateCcw, Settings2, Sun, X } from "lucide-react";
import { api, isTauriRuntime } from "../api";
import { IMAGE_SIZE_VALUES, type ImageSizeValue } from "../../shared/types";
import { setThemeMode, useTheme, type ThemeMode } from "../theme";
import type { Toast } from "../app-shared";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: React.ReactNode }> = [
  { value: "system", label: "跟随系统", icon: <Monitor size={15} /> },
  { value: "light", label: "浅色", icon: <Sun size={15} /> },
  { value: "dark", label: "深色", icon: <Moon size={15} /> },
];

/**
 * 设置：外观主题 + 素材目录 + gemini 渠道的缺省输出尺寸。
 *
 * 目录由桌面版的原生选择器挑，服务端只负责校验和落库；切换只影响之后生成的
 * 产物，历史记录里的旧产物按各自记录保存的目录读取，不会被搬动。
 *
 * 输出尺寸这一项是需求.md 问题 1 的产物：gemini 系站点要求请求体里必须带
 * `imageConfig.imageSize`，缺了上游直接回「Unsupported resolution」。补默认值
 * 时必须让用户看得见、也改得动——所以它在这儿，而不是藏在某个常量里。
 */
export function SettingsDialog({ assetsDir, defaultAssetsDir, dataPath, onClose, onChanged, onToast }: {
  assetsDir: string;
  defaultAssetsDir: string;
  dataPath: string;
  onClose: () => void;
  onChanged: (assetsDir: string) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isDefault = assetsDir === defaultAssetsDir;
  const canPick = isTauriRuntime();
  const [imageSize, setImageSize] = useState<ImageSizeValue | null>(null);
  const { mode: theme } = useTheme();

  useEffect(() => {
    void api.settings().then((current) => setImageSize(current.geminiImageSize)).catch(() => undefined);
  }, []);

  async function applyImageSize(next: ImageSizeValue) {
    setBusy(true);
    try {
      const result = await api.updateSettings({ geminiImageSize: next });
      setImageSize(result.geminiImageSize);
      onToast("success", `gemini 渠道的缺省尺寸已改为 ${result.geminiImageSize}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "尺寸设置更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function apply(next: string) {
    setBusy(true);
    try {
      const result = await api.updateSettings({ assetsDir: next });
      onChanged(result.assetsDir);
      onToast("success", next === "" ? "已恢复默认素材目录" : "素材目录已更新");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "素材目录更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    try {
      const picked = await api.pickDirectory();
      if (!picked) return; // 用户取消
      await apply(picked);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "无法打开目录选择器");
    }
  }

  async function reveal() {
    try {
      const result = await api.revealMedia();
      onToast("success", `已打开素材目录：${result.opened}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "打开素材目录失败");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-header">
          <div><Settings2 size={18} /><h2>设置</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="settings-section">
            <h3>外观</h3>
            <p className="modal-lead">深色主题适合夜间使用；「跟随系统」会随 Windows 的浅色 / 深色设置自动切换。</p>
            <div className="settings-segment">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`secondary-button ${theme === option.value ? "is-on" : ""}`}
                  aria-pressed={theme === option.value}
                  onClick={() => setThemeMode(option.value)}
                >
                  {option.icon}{option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-section">
            <h3>画布数据</h3>
            <p className="modal-lead">
              无限画布的节点、连线、分组、版本历史和素材索引都存在下面这个 SQLite 文件里。
            </p>
            <div className="settings-path">{dataPath || "（未获取到）"}</div>
            <div className="modal-note">
              <AlertCircle size={15} />
              <span>
                数据库路径不在运行中切换，避免画布和历史写到一半。要整体搬到别的盘，用启动环境变量
                <code>DATA_DIR</code> 指向新目录后再启动；素材文件可以单独在下面改目录。
              </span>
            </div>
          </div>

          <div className="settings-section">
            <h3>素材目录</h3>
            <p className="modal-lead">生成的图片和视频保存到下面这个目录。{isDefault ? "当前是默认位置。" : "当前使用自定义位置。"}</p>
            <div className="settings-path">{assetsDir || "（未获取到）"}</div>
            <div className="settings-actions">
              <button className="secondary-button" onClick={() => void choose()} disabled={busy || !canPick}>
                <FolderOpen size={16} />更改目录
              </button>
              <button className="secondary-button" onClick={() => void reveal()} disabled={busy}>
                <Eye size={16} />打开目录
              </button>
              <button className="secondary-button" onClick={() => void apply("")} disabled={busy || isDefault}>
                <RotateCcw size={16} />恢复默认
              </button>
            </div>
            <div className="modal-note">
              <AlertCircle size={15} />
              <span>
                {canPick
                  ? "更改目录只影响之后生成的产物。历史记录里的旧图片、视频仍从原来的目录读取，不会被搬动，也不会失效。"
                  : "只有桌面版支持用原生对话框选择目录；Web 开发模式下这里不可用。"}
              </span>
            </div>
          </div>

          <div className="settings-section">
            <h3>gemini 渠道的输出尺寸</h3>
            <p className="modal-lead">
              这类站点要求请求体里必须带 <code>imageConfig.imageSize</code>，缺了直接回「Unsupported resolution」。
              你和助手都没指定尺寸时，就用这里的值补上——工具卡片上会标出「尺寸：{imageSize ?? "2K"}（默认）」，
              不让你猜它到底发了什么。
            </p>
            <div className="settings-segment">
              {IMAGE_SIZE_VALUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`secondary-button ${imageSize === value ? "is-on" : ""}`}
                  disabled={busy || imageSize === null}
                  onClick={() => void applyImageSize(value)}
                >
                  {value}{value === "2K" ? "（推荐）" : ""}
                </button>
              ))}
            </div>
            <div className="modal-note">
              <AlertCircle size={15} />
              <span>只影响 gemini 系的渠道，别的渠道不认这个参数。尺寸越大越贵、也越慢，2K 是这类站点最稳的一档。</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>
  );
}

