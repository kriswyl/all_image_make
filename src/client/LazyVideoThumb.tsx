import { useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";

/**
 * 视频缩略图：滚到可见范围内才真正挂 `<video>`。
 *
 * 每个 `<video preload="metadata">` 都会向后端要一次文件头，历史或「最近」条里
 * 一次挂十几个，渲染和网络请求都会明显变慢；占位到可见再加载可以省掉大部分。
 */
export function LazyVideoThumb({ src, alt = "" }: { src: string; alt?: string }) {
  const holder = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    // 没有 IntersectionObserver（老内核）时直接加载，宁可慢也不要空着
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <span ref={holder} className="lazy-video">
      {visible
        ? <video src={src} muted playsInline preload="metadata" aria-label={alt || undefined} />
        : <span className="lazy-video-placeholder" aria-hidden="true"><Film size={14} /></span>}
    </span>
  );
}
