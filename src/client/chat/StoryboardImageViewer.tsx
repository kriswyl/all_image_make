import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Maximize2, Scan, X } from "lucide-react";

export function StoryboardImageViewer({ url, title, position, count, onNavigate, onUse, onClose }: {
  url: string;
  title: string;
  position?: number;
  count?: number;
  onNavigate?: (delta: number) => void;
  onUse?: () => void;
  onClose: () => void;
}) {
  const viewer = useRef<HTMLElement>(null);
  const [zoom, setZoom] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const previous = position !== undefined && position > 0;
  const next = position !== undefined && count !== undefined && position < count - 1;

  useEffect(() => {
    const opener = document.activeElement;
    viewer.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);

  return <div className="story-image-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={viewer} className="story-image-viewer" role="dialog" tabIndex={-1} aria-modal="true" aria-label="原图预览"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "ArrowLeft" && previous) { event.preventDefault(); onNavigate?.(-1); }
        if (event.key === "ArrowRight" && next) { event.preventDefault(); onNavigate?.(1); }
      }}>
      <header>
        <div><strong>{title}</strong><small>{[
          position !== undefined && count ? `${position + 1} / ${count}` : "",
          dimensions ? `${dimensions.width} × ${dimensions.height}` : "",
        ].filter(Boolean).join(" · ")}</small></div>
        <button type="button" className="storydesk-icon" aria-label="关闭原图预览" onClick={onClose}><X size={20} /></button>
      </header>
      <div className="story-image-stage" data-zoom={zoom}>
        {failed ? <p role="alert">原图加载失败</p> : <img src={url} alt={title} onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          setDimensions({ width: naturalWidth, height: naturalHeight });
        }} onError={() => setFailed(true)} />}
      </div>
      <footer>
        {onNavigate ? <div className="storydesk-actions">
          <button type="button" className="storydesk-icon" aria-label="上一张图" disabled={!previous} onClick={() => onNavigate(-1)}><ChevronLeft size={18} /></button>
          <button type="button" className="storydesk-icon" aria-label="下一张图" disabled={!next} onClick={() => onNavigate(1)}><ChevronRight size={18} /></button>
        </div> : null}
        <div className="storydesk-actions">
          <button type="button" className="storydesk-button" disabled={!dimensions || failed} onClick={() => setZoom(!zoom)}>
            {zoom ? <Scan size={15} /> : <Maximize2 size={15} />}{zoom ? "适应窗口" : "原始大小"}
          </button>
          {onUse ? <button type="button" className="storydesk-button is-primary" onClick={onUse}><Check size={16} />使用这张图</button> : null}
        </div>
      </footer>
    </section>
  </div>;
}
