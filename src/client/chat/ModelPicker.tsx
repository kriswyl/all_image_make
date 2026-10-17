/**
 * 大脑模型选择器。
 *
 * 原来是个原生 `<select>`：圆角、每个选项前面挂厂商标识——这些 `<option>` 里都做不到
 * （浏览器不让样式化下拉项），所以换成「一个按钮 + 一个浮层」。
 * 浮层里的排版和「图片 · 视频模型」面板用同一套语言：标识 + 真名 + 渠道。
 */
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ModelLogo, type ModelKind } from "./ModelLogo";

export interface ModelOption {
  /** 提交给服务端的值 */
  value: string;
  /** 展示用的模型名（真名，不是别名） */
  model: string;
  /** 来自哪个渠道——同名模型在不同渠道下是两个东西，得能分开 */
  channelName: string;
}

export function ModelPicker({
  options,
  value,
  disabled = false,
  onChange,
  /** 决定厂商图标的匹配表：同一个 `sd-*` 在视频里是 Seedance、图片里是 Stable Diffusion */
  kind = "chat",
  placeholder = "选模型",
  /** 对话页在底部，浮层向上开；生图 / 生视频页在顶部，浮层向下开 */
  menuPlacement = "up",
  className,
  ariaLabel,
}: {
  options: ModelOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  kind?: ModelKind;
  placeholder?: string;
  menuPlacement?: "up" | "down";
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点别处收起。浮层是自绘的，浏览器不会替我们做这件事
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const current = options.find((item) => item.value === value);

  return (
    <div className={`model-picker ${className ?? ""}`} ref={ref}>
      <button
        type="button"
        className={`model-picker-trigger ${open ? "is-open" : ""}`}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((previous) => !previous)}
        title={current ? `${current.channelName} · ${current.model}` : placeholder}
      >
        {current ? <ModelLogo model={current.model} kind={kind} size={15} /> : null}
        <span className="model-picker-label">{current ? current.model : placeholder}</span>
        <ChevronDown size={13} className="model-picker-chevron" />
      </button>

      {open ? (
        <div
          className={`model-picker-menu ${menuPlacement === "down" ? "is-down" : ""}`}
          role="listbox"
          aria-label={ariaLabel ?? "模型"}
        >
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              role="option"
              aria-selected={item.value === value}
              className={`model-picker-option ${item.value === value ? "is-active" : ""}`}
              onClick={() => { onChange(item.value); setOpen(false); }}
            >
              <span className="model-picker-option-logo">
                <ModelLogo model={item.model} kind={kind} size={16} />
              </span>
              <span className="model-picker-option-name" title={item.model}>{item.model}</span>
              <span className="model-picker-option-channel">{item.channelName}</span>
              {item.value === value ? <Check size={13} className="model-picker-check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
