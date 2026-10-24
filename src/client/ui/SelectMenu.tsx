/**
 * 自绘下拉菜单。
 *
 * 原生 `<select>` 收起时能改样式，但**展开后的选项列表由浏览器画**：
 * 灰色高亮、系统字体、行高，和整站的圆角卡片完全不是一套。分镜里又特别多
 * （类型、画幅、选已有图），所以换成「按钮 + 浮层」。
 *
 * 浮层挂在 body 上，避免被镜头列表的滚动容器裁掉；键盘支持上下/Home/End/Enter/Esc。
 */
import { Check, ChevronDown, Images } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

export interface SelectOption {
  value: string;
  label: string;
}

function useMenuStyle(open: boolean, triggerRef: RefObject<HTMLElement | null>, width: number, maxHeight: number) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      setStyle(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const menuWidth = Math.min(Math.max(width, rect.width), window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8);
    const openUp = rect.bottom + maxHeight + 12 > window.innerHeight && rect.top > maxHeight + 12;
    setStyle(openUp
      ? { left, width: menuWidth, bottom: window.innerHeight - rect.top + 6 }
      : { left, width: menuWidth, top: rect.bottom + 6 });
  }, [open, width, maxHeight, triggerRef]);

  return style;
}

/** 点外面 / Esc / 滚动 / 缩放都收起。浮层是 portal，得同时认触发键和菜单本身 */
function useDismiss(
  open: boolean,
  close: () => void,
  refs: Array<RefObject<HTMLElement | null>>,
  onEscape?: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      onEscape?.();
    };
    const onLayout = () => close();
    const onScroll = (event: Event) => {
      // 菜单自己的内部滚动不能把菜单关掉——这正是「图片列表滚不动」的原因
      const target = event.target;
      if (target instanceof Node && refs.some((ref) => ref.current?.contains(target))) return;
      close();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close, refs, onEscape]);
}

export function SelectMenu({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  disabled = false,
  className,
  leading,
  minWidth = 160,
  title,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  /** 加在触发按钮上的额外类名（分镜里用 shot-kind / shot-aspect） */
  className?: string;
  /** 触发按钮最前面的小图标 */
  leading?: ReactNode;
  minWidth?: number;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useMenuStyle(open, triggerRef, minWidth, 300);
  const current = options.find((option) => option.value === value);

  const close = useCallback(() => setOpen(false), []);
  const refs = useMemo(() => [triggerRef, menuRef], []);
  const restoreFocus = useCallback(() => triggerRef.current?.focus(), []);
  useDismiss(open, close, refs, restoreFocus);

  useEffect(() => {
    if (!open) return;
    const index = options.findIndex((option) => option.value === value);
    setActive(index < 0 ? 0 : index);
    menuRef.current?.focus();
    // 只在打开时定位一次；选项变化不需要重新对焦
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(option: SelectOption) {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (index + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[active];
      if (option) choose(option);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-menu-trigger ${open ? "is-open" : ""} ${className ?? ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? current?.label}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {leading}
        <span className="select-menu-label">{current?.label ?? placeholder}</span>
        <ChevronDown size={12} className="select-menu-chevron" />
      </button>

      {open && style ? createPortal(
        <div
          ref={menuRef}
          className="select-menu-popover"
          style={style}
          role="listbox"
          aria-label={ariaLabel}
          tabIndex={-1}
          onKeyDown={onMenuKeyDown}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {options.length ? options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              className={`select-menu-option ${option.value === value ? "is-selected" : ""} ${index === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={13} /> : null}
            </button>
          )) : <p className="select-menu-empty">没有可选项</p>}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/**
 * 可自由输入、带建议列表的输入框。
 *
 * 角色 / 场景原来是 `<input list=...>`：输入框本身能改样式，
 * 但浏览器弹出的建议列表同样不受控。这里换成同一套浮层。
 */
export function SuggestInput({
  value,
  onChange,
  onBlur,
  suggestions,
  placeholder,
  disabled = false,
  maxLength,
  ariaLabel,
  multiple = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  suggestions: string[];
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  ariaLabel: string;
  /** 多人物：点建议是「追加」而不是替换，已有的名字带勾 */
  multiple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useMenuStyle(open, inputRef, 190, 280);
  const close = useCallback(() => setOpen(false), []);
  const refs = useMemo(() => [inputRef, menuRef], []);
  useDismiss(open, close, refs, () => inputRef.current?.focus());

  const query = value.trim().toLowerCase();
  // 只看最后一个名字：多人物时用户正在追加的是最后一段
  const tokens = query.split(/[、,，/\s]+/).filter(Boolean);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const exact = suggestions.some((name) => name.toLowerCase() === lastToken);
  const filtered = suggestions
    .filter((name) => {
      // 已经是一个完整名字（或还没输入）时列出全部，方便继续加人 / 换人
      if (!lastToken || exact) return true;
      const lower = name.toLowerCase();
      return lower.includes(lastToken) || lastToken.includes(lower);
    })
    .slice(0, 16);

  useEffect(() => {
    if (open) setActive(0);
  }, [open, query]);

  function choose(name: string) {
    if (multiple) {
      const current = value.split(/[、,，/]+/).map((item) => item.trim()).filter(Boolean);
      if (!current.some((item) => item.toLowerCase() === name.toLowerCase())) current.push(name);
      onChange(current.join("、"));
    } else {
      onChange(name);
    }
    setOpen(false);
    // 保持焦点：父级的 onChange 会防抖保存；这时主动 blur 会拿旧的 draft 再存一遍
  }

  const selectedNames = value.split(/[、,，/]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const isSelected = (name: string) => multiple
    ? selectedNames.includes(name.toLowerCase())
    : name === value;

  return (
    <>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(event) => { onChange(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          // 让「点建议项」的 click 先落地，再收起并触发父级的保存
          window.setTimeout(() => setOpen(false), 120);
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) { setOpen(true); return; }
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (index + delta + filtered.length) % Math.max(1, filtered.length));
            return;
          }
          if (event.key === "Enter" && open && filtered[active]) {
            event.preventDefault();
            choose(filtered[active]!);
            return;
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />

      {open && style && filtered.length ? createPortal(
        <div
          ref={menuRef}
          className="select-menu-popover suggest-menu"
          style={style}
          role="listbox"
          aria-label={ariaLabel}
          onMouseDown={(event) => event.preventDefault()}
        >
          {filtered.map((name, index) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={isSelected(name)}
              tabIndex={-1}
              className={`select-menu-option ${isSelected(name) ? "is-selected" : ""} ${index === active ? "is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(name)}
            >
              <span>{name}</span>
              {isSelected(name) ? <Check size={13} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export interface ImageChoice {
  id: string;
  label: string;
  url: string;
}

/**
 * 「选本会话已有的图」。
 *
 * 原来这一项是原生 `<select>`，二十多张图全变成「分镜第 N 镜」一行字，
 * 选图时根本分不清是哪张。这里换成缩略图网格，图本身就能当选项。
 */
export function ImagePickerMenu({
  options,
  onSelect,
  disabled = false,
  label = "选已有图",
}: {
  options: ImageChoice[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useMenuStyle(open, triggerRef, 340, 400);

  const close = useCallback(() => setOpen(false), []);
  const refs = useMemo(() => [triggerRef, menuRef], []);
  const restoreFocus = useCallback(() => triggerRef.current?.focus(), []);
  useDismiss(open, close, refs, restoreFocus);

  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`image-picker-trigger ${open ? "is-open" : ""}`}
        disabled={disabled || !options.length}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={options.length ? `${label}（${options.length} 张）` : "本会话还没有可用的图"}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Images size={12} />
        {label}
        <ChevronDown size={11} className="select-menu-chevron" />
      </button>

      {open && style ? createPortal(
        <div
          ref={menuRef}
          className="image-picker-menu"
          style={style}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); } }}
        >
          <div className="image-picker-head">
            <strong>本会话的图</strong>
            <span>{options.length} 张</span>
          </div>
          <div className="image-picker-grid">
            {options.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                className="image-picker-option"
                title={option.label}
                onClick={() => { onSelect(option.id); setOpen(false); }}
              >
                <img src={option.url} alt="" loading="lazy" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
