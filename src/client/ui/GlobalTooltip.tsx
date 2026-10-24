/**
 * 全局自绘 tooltip。
 *
 * 原生 `title` 的白框由浏览器绘制，样式、延迟、换行都不可控，而且项目里
 * 几十处都在用它。这里不逐个改组件：
 *   1. 启动时把 DOM 里的 `title` 搬到 `data-tooltip`，并移除 `title`；
 *   2. MutationObserver 继续处理 React 后续挂载/更新的 `title`；
 *   3. 鼠标悬停 / 键盘聚焦后延迟 700ms，在目标附近显示深色提示卡。
 *
 * 对只有图标的按钮，会顺手补一个 `aria-label`，避免移除 title 后失去可访问名称。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY = 700;
const GAP = 8;

interface Tip {
  text: string;
  /** 目标元素中心点；实际 left 在渲染后按提示卡真实宽度再居中 */
  center: number;
  top?: number;
  bottom?: number;
}

function convertTitle(element: Element) {
  if (!(element instanceof HTMLElement)) return;
  const title = element.getAttribute("title");
  if (!title?.trim()) return;
  const text = title.trim();
  element.dataset.tooltip = text;
  element.removeAttribute("title");
  // 图标按钮原本靠 title 当可访问名称；换成 aria-label 补回来
  if (!element.hasAttribute("aria-label") && !element.textContent?.trim()) {
    element.setAttribute("aria-label", text);
  }
}

function convertWithin(root: ParentNode) {
  if (root instanceof Element && root.hasAttribute("title")) convertTitle(root);
  root.querySelectorAll?.("[title]").forEach(convertTitle);
}

export function GlobalTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // 提示卡宽度由内容决定，先隐藏渲染、量到真实宽度后再水平居中，避免短文本偏左
  useLayoutEffect(() => {
    const element = tipRef.current;
    if (!tip || !element) return;
    const width = element.getBoundingClientRect().width;
    const left = Math.max(8, Math.min(tip.center - width / 2, window.innerWidth - width - 8));
    element.style.left = `${left}px`;
    element.style.visibility = "visible";
  }, [tip]);

  useEffect(() => {
    convertWithin(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          if (mutation.target instanceof Element) convertTitle(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) convertWithin(node);
        });
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    const clearTimer = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
    };

    const hide = () => {
      clearTimer();
      current.current = null;
      setTip(null);
    };

    const showFor = (element: HTMLElement) => {
      const text = element.dataset.tooltip?.trim();
      if (!text) return;
      const rect = element.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      // 下方放不下就翻到上方；用 bottom 定位，不需要提前知道提示卡高度
      const above = rect.bottom + 160 > window.innerHeight && rect.top > 160;
      setTip(above
        ? { text, center, bottom: window.innerHeight - rect.top + GAP }
        : { text, center, top: rect.bottom + GAP });
    };

    const schedule = (element: HTMLElement) => {
      if (current.current === element) return;
      hide();
      current.current = element;
      timer.current = window.setTimeout(() => showFor(element), SHOW_DELAY);
    };

    const onOver = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const element = target.closest<HTMLElement>("[data-tooltip]");
      if (element) schedule(element);
    };

    const onOut = (event: MouseEvent) => {
      const related = event.relatedTarget;
      if (current.current && related instanceof Node && current.current.contains(related)) return;
      hide();
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const element = target.closest<HTMLElement>("[data-tooltip]");
      if (element) schedule(element);
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("mousedown", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      observer.disconnect();
      clearTimer();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("mousedown", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      className="global-tooltip"
      style={{ left: 0, top: tip.top, bottom: tip.bottom, visibility: "hidden" }}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
