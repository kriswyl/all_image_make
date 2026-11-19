import { EllipsisVertical, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./image-action-menu.css";

export interface ImageAction {
  label: string;
  tooltip?: string;
  icon: LucideIcon;
  disabled?: boolean;
  onSelect: () => void;
}

export function ImageActionMenu({ className, children, shortcuts, actions }: {
  className: string;
  children: ReactNode;
  shortcuts: ImageAction[];
  actions: ImageAction[];
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ above: true, maxHeight: 240 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      setOpen(false);
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const bounds = trigger.current?.closest(".workspace")?.getBoundingClientRect();
      if (!rect || !panel.current) return;
      const below = Math.min(window.innerHeight, bounds?.bottom ?? Infinity) - rect.bottom - 12;
      const above = rect.top - Math.max(0, bounds?.top ?? 0) - 12;
      const openAbove = above >= panel.current.scrollHeight || above > below;
      const maxHeight = Math.max(0, openAbove ? above : below);
      setPlacement(current => current.above === openAbove && current.maxHeight === maxHeight
        ? current : { above: openAbove, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [actions.length, open]);

  return (
    <div className={`${className} image-action-card${open ? " is-action-open" : ""}`}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setOpen(false);
      }}
      onClickCapture={(event) => {
        if (!(event.target instanceof Node)) return;
        if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setOpen(false);
      }}
    >
      {children}
      <div className="image-action-shortcuts">
        <div className="image-action-shortcut-group" role="group" aria-label="图片快捷操作">
          {shortcuts.map(({ label, tooltip, icon: Icon, disabled, onSelect }) => (
            <button key={label} type="button" className="image-action-shortcut" aria-label={label}
              data-tooltip={tooltip ?? label} data-tooltip-variant="image-action" disabled={disabled} onClick={onSelect}>
              <Icon size={15} aria-hidden="true" />
            </button>
          ))}
          <button ref={trigger} type="button" className="image-action-trigger" aria-label="图片操作"
            aria-expanded={open} aria-controls={menuId}
            onClick={() => setOpen(current => !current)}>
            <EllipsisVertical size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <div ref={panel} id={menuId} className={`image-result-tools image-action-menu${placement.above ? " opens-above" : ""}`}
            role="group" aria-label="图片更多操作" inert={!open} style={{ maxHeight: placement.maxHeight }}>
            {actions.map(({ label, tooltip, icon: Icon, disabled, onSelect }) => (
              <div key={label} className="image-action-row" data-tooltip={tooltip ?? label} data-tooltip-variant="image-action">
                <button type="button" disabled={disabled} onClick={() => {
                  trigger.current?.focus({ preventScroll: true });
                  setOpen(false);
                  onSelect();
                }}>
                  <Icon size={15} aria-hidden="true" />
                  {label}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
