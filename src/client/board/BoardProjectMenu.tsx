import { useEffect, useRef, useState } from "react";
import { Download, FileJson, FileUp, History, LayoutTemplate, MoreHorizontal } from "lucide-react";

export function BoardProjectMenu({ hasBoard, onHistory, onTemplates, onImport, onExport }: {
  hasBoard: boolean;
  onHistory: () => void;
  onTemplates: () => void;
  onImport: () => void;
  onExport: (mode: "package" | "json") => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent | FocusEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function choose(action: () => void) {
    setOpen(false);
    trigger.current?.focus();
    action();
  }

  return <div className="board-project-menu" ref={root}>
    <button type="button" className="secondary-button compact board-topbar-icon" ref={trigger} aria-label="项目菜单" title="项目菜单"
      aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} /></button>
    {open ? <div className="board-project-menu-popover" role="group" aria-label="项目操作">
      <button type="button" disabled={!hasBoard} onClick={() => choose(onHistory)}><History size={15} />画布版本</button>
      <button type="button" onClick={() => choose(onTemplates)}><LayoutTemplate size={15} />使用模板</button>
      <div className="board-project-menu-divider" />
      <button type="button" onClick={() => choose(onImport)}><FileUp size={15} />导入画布</button>
      <button type="button" disabled={!hasBoard} onClick={() => choose(() => onExport("package"))}><Download size={15} />导出工程包</button>
      <button type="button" disabled={!hasBoard} onClick={() => choose(() => onExport("json"))}><FileJson size={15} />导出画布结构（JSON）</button>
    </div> : null}
  </div>;
}
