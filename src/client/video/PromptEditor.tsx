import { useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { Ref } from "react";
import type { MentionItem } from "./VideoMentionPanel";
import type { PanelAnchorRect } from "./useAnchoredPanel";

/**
 * 提示词输入框（富文本版）。
 *
 * 为什么不是 textarea：`@图片1` 要一直是**带缩略图的胶囊**。textarea 里画不了
 * 内联元素，只能靠一层盖在上面的展示层去画；而展示层的胶囊一旦和文字宽度不同，
 * 光标、选区、点击定位就全错位。所以这里换成 contenteditable：文字和胶囊是同一棵
 * DOM，光标自然落在它们之间，宽度怎么变都不会错。
 *
 * 三条约束：
 * 1. **真源是文本**。每次输入都从 DOM 读出纯文本交给上层（`@图片1` 从胶囊的
 *    data-token 读回来），上层拿到的永远是可以直接提交的字符串。
 * 2. **不每次按键都重建 DOM**。只有「文本里该出现胶囊的位置」和「DOM 里实际的
 *    胶囊」对不上时才重建，并按字符偏移复位光标——否则撤销栈被清空、输入法被打断。
 * 3. **组字期间一律不动 DOM**。中文输入法的拼音必须由浏览器自己管。
 */

export interface PromptEditorHandle {
  focus: () => void;
  /** 把 `@图片N` 插到光标处（光标前正好是刚敲的 @ 时替换掉它） */
  insertMention: (label: string) => void;
}

export interface PromptEditorProps {
  value: string;
  items: MentionItem[];
  placeholder: string;
  maxLength?: number;
  onChange: (next: string) => void;
  onFocusChange: (focused: boolean) => void;
  /** 在输入框里敲下一个 @：把面板锚到光标处 */
  onTypedAt: (rect: PanelAnchorRect | null) => void;
  onOpenItem: (item: MentionItem, rect: PanelAnchorRect) => void;
  ref?: Ref<PromptEditorHandle>;
}

const TOKEN_SOURCE = "@(视频|图片|音频)(\\d+)";
const AUDIO_ICON =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const FILM_ICON =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface TokenSpan {
  start: number;
  token: string;
  item: MentionItem;
}

/** 文本里真正能生效的记号（素材被删掉的 @图片9 不算，保持普通文字） */
function tokenSpans(text: string, items: MentionItem[]): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const pattern = new RegExp(TOKEN_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const token = match[0];
    const item = items.find((entry) => `@${entry.label}` === token);
    if (item) spans.push({ start: match.index, token, item });
  }
  return spans;
}

function chipHtml(item: MentionItem, token: string): string {
  const thumb = item.kind === "视频" && item.previewUrl
    ? `<video src="${escapeHtml(item.previewUrl)}#t=0.1" muted playsinline preload="metadata"></video>`
    : item.kind === "图片" && item.previewUrl
      ? `<img src="${escapeHtml(item.previewUrl)}" alt="">`
      : item.kind === "音频" ? AUDIO_ICON : FILM_ICON;
  return (
    `<span class="vstudio-chip is-${item.kind}" contenteditable="false" data-token="${escapeHtml(token)}"`
    + ` role="button" title="${item.kind} · 点击查看详情">`
    + `<span class="vstudio-chip-thumb">${thumb}</span>`
    + `<span class="vstudio-chip-text">${escapeHtml(token)}</span></span>`
  );
}

function htmlOf(text: string, items: MentionItem[]): string {
  const spans = tokenSpans(text, items);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += escapeHtml(text.slice(cursor, span.start));
    out += chipHtml(span.item, span.token);
    cursor = span.start + span.token.length;
  }
  return out + escapeHtml(text.slice(cursor));
}

/** 有序的叶子节点（文本、胶囊、换行），读文本和复位光标都用它 */
function leavesOf(root: HTMLElement): Node[] {
  const out: Node[] = [];
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) out.push(child);
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as HTMLElement;
        if (element.dataset.token || element.tagName === "BR") out.push(child);
        else walk(child);
      }
    });
  };
  walk(root);
  return out;
}

function lengthOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? "").length;
  const element = node as HTMLElement;
  if (element.dataset.token) return (element.dataset.token ?? "").length;
  return element.tagName === "BR" ? 1 : 0;
}

/** DOM → 提交用的纯文本。胶囊读 data-token，<br> 与块级边界都算换行 */
export function readPromptText(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) { out += child.nodeValue ?? ""; return; }
      if (child.nodeType !== Node.ELEMENT_NODE) return;
      const element = child as HTMLElement;
      if (element.dataset.token) { out += element.dataset.token; return; }
      if (element.tagName === "BR") { out += "\n"; return; }
      const block = element.tagName === "DIV" || element.tagName === "P";
      if (block && out && !out.endsWith("\n")) out += "\n";
      walk(element);
    });
  };
  walk(root);
  // 空编辑器里浏览器会留一个占位 <br>，别把它当成一个换行
  return out === "\n" ? "" : out;
}

/** 光标在纯文本里的字符偏移 */
function caretOffset(root: HTMLElement, node?: Node, offset?: number): number {
  const selection = window.getSelection();
  const range = document.createRange();
  const startNode = node ?? (selection && selection.rangeCount ? selection.getRangeAt(0).startContainer : null);
  const startOffset = offset ?? (node ? 0 : selection && selection.rangeCount ? selection.getRangeAt(0).startOffset : 0);
  if (!startNode || !root.contains(startNode)) return readPromptText(root).length;
  range.selectNodeContents(root);
  range.setEnd(startNode, startOffset);
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return readPromptText(holder).length;
}

/** 把光标放到纯文本的第 offset 个字符处（落在胶囊内部时贴到它后面） */
function placeCaret(root: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;
  for (const node of leavesOf(root)) {
    const length = lengthOf(node);
    if (node.nodeType === Node.TEXT_NODE) {
      if (remaining <= length) { range.setStart(node, remaining); placed = true; break; }
      remaining -= length;
      continue;
    }
    const parent = node.parentNode;
    if (!parent) continue;
    if ((node as HTMLElement).dataset.token) {
      if (remaining <= length) {
        range.setStart(parent, Array.prototype.indexOf.call(parent.childNodes, node) + 1);
        placed = true;
        break;
      }
      remaining -= length;
      continue;
    }
    // <br>：光标落在它后面（下一行行首）
    if (remaining < 1) { range.setStart(parent, Array.prototype.indexOf.call(parent.childNodes, node)); placed = true; break; }
    remaining -= 1;
  }
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/** 浏览器偶尔会自己塞块级元素（粘贴多行、某些输入法），统一拍平回「文本 + 换行」 */
function hasBlocks(root: HTMLElement): boolean {
  return Boolean(root.querySelector("div, p, li, ul, ol, table"));
}

function sameChips(desired: TokenSpan[], root: HTMLElement): boolean {
  const chips = Array.from(root.querySelectorAll<HTMLElement>(".vstudio-chip"));
  if (chips.length !== desired.length) return false;
  for (let index = 0; index < chips.length; index += 1) {
    const chip = chips[index]!;
    const span = desired[index]!;
    if ((chip.dataset.token ?? "") !== span.token) return false;
    // 胶囊前面那截文本的长度，必须正好等于记号在文本里的起点，否则说明文字被改过、要重排
    if (caretOffset(root, chip, 0) !== span.start) return false;
  }
  return true;
}

/** 在当前光标处插入纯文本（回车、粘贴都走这里，避免浏览器塞进一堆 div） */
function insertPlainText(text: string) {
  try {
    if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return true;
  } catch {
    /* 老浏览器没有 execCommand，走下面的 Range 兜底 */
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** 光标屏幕坐标：contenteditable 有原生 Range，不用再镜像测算 */
export function promptCaretRect(element: HTMLElement): PanelAnchorRect | null {
  try {
    const selection = window.getSelection();
    if (selection && selection.rangeCount) {
      const range = selection.getRangeAt(0).cloneRange();
      range.collapse(true);
      const box = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      // jsdom 的 Range 只有 getBoundingClientRect 或什么都没有，量不出来就回退
      const rects = typeof range.getClientRects === "function" ? range.getClientRects() : [];
      const rect = box && (box.height || box.width) ? box : rects.length ? rects[0]! : null;
      if (rect && (rect.height || rect.width)) {
        return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
      }
    }
  } catch {
    /* 量不出来就下面回退到整框 */
  }
  const box = element.getBoundingClientRect();
  return box.height ? { left: box.left, right: box.left, top: box.top, bottom: box.top + 24 } : null;
}

export function PromptEditor(props: PromptEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  const lastTextRef = useRef(props.value);
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;
  const changeRef = useRef(props.onChange);
  changeRef.current = props.onChange;

  const paint = useCallback((text: string, caret: number | null) => {
    const element = editorRef.current;
    if (!element) return;
    element.innerHTML = text ? htmlOf(text, itemsRef.current) : "";
    lastTextRef.current = text;
    if (caret != null) placeCaret(element, caret);
  }, []);

  // 外部改稿（切模式回填、复用参数、AI 润色）：DOM 文本和 value 不一致才重建
  useEffect(() => {
    const element = editorRef.current;
    if (!element) return;
    if (readPromptText(element) === props.value) return;
    paint(props.value, document.activeElement === element ? props.value.length : null);
  }, [props.value, paint]);

  // 素材变了（新增、删除）：胶囊的缩略图/有效性都要跟着刷新
  const itemsSignature = props.items.map((item) => `${item.label}:${item.previewUrl ?? ""}`).join("|");
  useEffect(() => {
    const element = editorRef.current;
    if (!element || !element.querySelector(".vstudio-chip")) return;
    const offset = document.activeElement === element ? caretOffset(element) : null;
    paint(readPromptText(element), offset);
  }, [itemsSignature, paint]);

  useImperativeHandle(props.ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertMention: (label: string) => {
      const element = editorRef.current;
      if (!element) return;
      // 先读选区再 focus：对 contenteditable 调 focus() 会把光标拨回开头
      const text = readPromptText(element);
      const selection = window.getSelection();
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      const inside = Boolean(range && element.contains(range!.startContainer));
      const start = inside ? caretOffset(element) : text.length;
      const end = inside && range ? caretOffset(element, range.endContainer, range.endOffset) : start;
      // 光标前正好是刚敲的 @：替换掉它，别出现「@@图片1」
      const from = text.slice(0, start).endsWith("@") ? start - 1 : start;
      const token = `@${label}`;
      const next = `${text.slice(0, from)}${token} ${text.slice(end)}`;
      element.focus();
      changeRef.current(next);
      paint(next, from + token.length + 1);
    },
  }), [paint]);

  /** 输入后统一收口：读文本、必要时重排胶囊、必要时弹 @ 面板 */
  function sync(options: { typed?: boolean } = {}) {
    const element = editorRef.current;
    if (!element) return;
    const previous = lastTextRef.current;
    const limit = props.maxLength ?? 20000;
    let text = readPromptText(element);
    let caret = caretOffset(element);
    if (text.length > limit) {
      text = text.slice(0, limit);
      caret = Math.min(caret, limit);
      paint(text, caret);
    } else if (!text && element.childNodes.length) {
      // 删空之后浏览器会留一个 <br>，清掉它，占位文字才出得来
      paint("", 0);
      caret = 0;
    } else if (!composingRef.current && hasBlocks(element)) {
      // 粘贴多行时浏览器会塞 <div>，拍平回「文本 + \n」，后面的排版和提交都只看文本
      paint(text, caret);
    } else if (!composingRef.current && !sameChips(tokenSpans(text, itemsRef.current), element)) {
      paint(text, caret);
    }
    lastTextRef.current = text;
    changeRef.current(text);
    if (composingRef.current) return;
    if (options.typed && text.length > previous.length && text.slice(0, caret).endsWith("@")) {
      props.onTypedAt(promptCaretRect(element));
    }
  }

  return (
    <div
      ref={editorRef}
      className="vstudio-input"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="提示词"
      data-placeholder={props.placeholder}
      spellCheck={false}
      onInput={() => sync({ typed: true })}
      onFocus={() => props.onFocusChange(true)}
      onBlur={() => props.onFocusChange(false)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; sync(); }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        // 组字时的回车是输入法在选词，不能拦
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        insertPlainText("\n");
        sync();
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text) insertPlainText(text);
        sync();
      }}
      onClick={(event) => {
        const chip = (event.target as HTMLElement).closest(".vstudio-chip") as HTMLElement | null;
        if (!chip) return;
        const item = itemsRef.current.find((entry) => `@${entry.label}` === chip.dataset.token);
        if (item) props.onOpenItem(item, chip.getBoundingClientRect());
      }}
      onMouseDown={(event) => {
        // 胶囊是原子：点它不要往里面塞光标（点开的是详情）
        if ((event.target as HTMLElement).closest(".vstudio-chip")) event.preventDefault();
      }}
    />
  );
}
