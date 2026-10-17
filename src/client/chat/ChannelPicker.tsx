/**
 * 渠道选择器（生图 / 生视频页头）。
 *
 * 和 `ModelPicker` 同一个理由：原生 `<select>` 的 `<option>` 放不下图片，
 * 而渠道也要有站点标识。中转站名字很长，图标反而比字更快认。
 *
 * 图标只认得出预设里的两家（词元流墟 / 向量引擎）；认不出就退回一个中性的
 * 服务器图标——**不要随便给渠道挂一个错的牌子**。
 */
import { Check, ChevronDown, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface ChannelOption {
  value: string;
  name: string;
  baseUrl: string;
}

const SITE_LOGOS: Array<{ test: RegExp; src: string; title: string }> = [
  { test: /tiantoken\.com/i, src: "/logo-tiantoken.svg", title: "词元流墟" },
  { test: /vectorengine\.cn/i, src: "/logo-vectorengine.png", title: "向量引擎" },
];

function siteOf(baseUrl: string) {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

export function ChannelPicker({
  options,
  value,
  disabled = false,
  onChange,
  placeholder = "选择渠道",
  className,
}: {
  options: ChannelOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点别处收起：浮层是自绘的，浏览器不会替我们做
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
        title={current ? current.name : placeholder}
      >
        {current ? <ChannelLogo baseUrl={current.baseUrl} size={15} /> : null}
        <span className="model-picker-label">{current ? current.name : placeholder}</span>
        <ChevronDown size={13} className="model-picker-chevron" />
      </button>

      {open ? (
        <div className="model-picker-menu is-down" role="listbox" aria-label="渠道">
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
                <ChannelLogo baseUrl={item.baseUrl} size={16} />
              </span>
              <span className="model-picker-option-name" title={item.name}>{item.name}</span>
              <span className="model-picker-option-channel">{siteOf(item.baseUrl)}</span>
              {item.value === value ? <Check size={13} className="model-picker-check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 渠道站点标识：认不出就留一个中性图标，不猜 */
export function ChannelLogo({ baseUrl, size = 16 }: { baseUrl: string; size?: number }) {
  const site = SITE_LOGOS.find((item) => item.test.test(baseUrl));
  if (!site) return <Server size={size} className="channel-logo-fallback" />;
  return (
    <img
      className="model-logo"
      src={site.src}
      alt=""
      title={site.title}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
