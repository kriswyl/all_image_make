import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ImagePlus, Maximize2, Minimize2, Paintbrush, X } from "lucide-react";
import type { ReferenceController, ReferenceImageState } from "../app-shared";
import { useFileDrop } from "../useFileDrop";
import { PromptEditor, type PromptEditorHandle } from "../video/PromptEditor";
import { VideoMentionPanel, type MentionItem } from "../video/VideoMentionPanel";
import type { PanelAnchorRect } from "../video/useAnchoredPanel";
import { ASSET_ARROW_WIDTH, ASSET_TILE_GAP, assetPageCapacity, assetPageCount } from "../video/asset-paging";

export function remapImageMentions(prompt: string, previous: ReferenceImageState[], images: ReferenceImageState[]): string {
  return prompt.replace(/@图片(\d+)/g, (token, digits: string) => {
    const original = previous[Number(digits) - 1];
    const index = original ? images.findIndex(image => image.previewUrl === original.previewUrl) : -1;
    return index < 0 ? `@缺失图片${digits}` : index + 1 === Number(digits) ? token : `@图片${index + 1}`;
  });
}

export function invalidImageMention(prompt: string, imageCount: number): string | undefined {
  return [...prompt.matchAll(/@(图片|缺失图片)(\d+)/g)]
    .find(([, kind, index]) => kind === "缺失图片" || Number(index) < 1 || Number(index) > imageCount)?.[0];
}

export function ImagePromptComposer({
  value, onChange, references, disabled, maxReferences, referenceError, defaultLimit, inpaint,
}: {
  value: string;
  onChange: (value: string) => void;
  references: ReferenceController;
  disabled: boolean;
  maxReferences: number;
  referenceError?: string;
  defaultLimit?: boolean;
  inpaint?: { maskApplied: boolean; open: () => void; clear: () => void };
}) {
  const { images, reading } = references;
  const [referencesExpanded, setReferencesExpanded] = useState(false);
  const [referencePage, setReferencePage] = useState(0);
  const [referenceWidth, setReferenceWidth] = useState(0);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionRect, setMentionRect] = useState<PanelAnchorRect | null>(null);
  const [preview, setPreview] = useState<ReferenceImageState | null>(null);
  const editor = useRef<PromptEditorHandle>(null);
  const mentionButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const referenceViewport = useRef<HTMLDivElement>(null);
  const canAdd = !disabled && !reading && images.length < maxReferences;
  const drop = useFileDrop(canAdd, references.dropFiles);
  const items: MentionItem[] = images.map((image, index) => ({
    label: `图片${index + 1}`, kind: "图片", previewUrl: image.previewUrl,
  }));
  const folded = images.length > 0 && !referencesExpanded;
  const showReferenceArrows = !folded && images.length > 0;
  const stacked = folded && images.length > 1;
  const clearSpace = images.length > 1 ? ASSET_ARROW_WIDTH + ASSET_TILE_GAP : 0;
  const availableWidth = referenceWidth > 0 ? Math.max(1, referenceWidth - clearSpace) : 0;
  const capacity = assetPageCapacity(availableWidth, true);
  const perPage = Number.isFinite(capacity) ? capacity : Math.max(1, images.length);
  const pages = assetPageCount(images.length, perPage);
  const page = Math.min(referencePage, pages - 1);
  const firstVisible = folded ? Math.max(0, images.length - 3) : page * perPage;
  const visibleImages = images.slice(firstVisible, folded ? undefined : firstVisible + perPage);
  const previewInpaint = preview && images.length === 1 && images[0].previewUrl === preview.previewUrl ? inpaint : undefined;

  useEffect(() => {
    if (!preview) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [preview]);

  useEffect(() => {
    const viewport = referenceViewport.current;
    if (!viewport) return;
    const measure = () => setReferenceWidth(viewport.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const previousImageCount = useRef(images.length);
  useEffect(() => {
    if (referencesExpanded && images.length > previousImageCount.current) setReferencePage(pages - 1);
    previousImageCount.current = images.length;
  }, [images.length, pages, referencesExpanded]);

  function addImages() {
    if (!canAdd) return;
    setMentionOpen(false);
    fileInput.current?.click();
  }

  return (
    <>
      <input ref={fileInput} className="vstudio-file-input" aria-label="添加参考图" type="file"
        accept="image/png,image/jpeg,image/webp" multiple disabled={!canAdd} onChange={references.select} />
      <div className={`image-composer-entry${drop.active ? " is-drop-target" : ""}`} {...drop.dropProps}>
        <div className="image-reference-viewport" ref={referenceViewport}>
          <div
            className={`image-reference-strip vstudio-assets${folded ? " is-folded" : ""}${pages > 1 ? " has-pages" : ""}`}
            onMouseLeave={() => setReferencesExpanded(false)}
            onFocusCapture={(event) => {
              const index = event.target.closest<HTMLElement>("[data-reference-index]")?.dataset.referenceIndex;
              if (folded && index !== undefined) setReferencePage(Math.floor(Number(index) / perPage));
              setReferencesExpanded(true);
            }}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setReferencesExpanded(false);
            }}
            aria-label={`参考图 ${images.length}/${maxReferences}`}
          >
            {!folded ? (
              <button type="button" className="vstudio-slot image-reference-add" onClick={addImages} disabled={!canAdd}
                title="点击选择、拖入或 Ctrl+V 粘贴 · PNG / JPEG / WebP · 单张最大 20 MB">
                {reading ? <LoadingIndicator variant="dots" size={24} /> : <ImagePlus size={17} />}
                <span>{drop.active ? "松开添加" : "参考图"}</span>
                <span>{images.length}/{maxReferences}</span>
              </button>
            ) : null}
            {showReferenceArrows ? (
              <button type="button" className="vstudio-asset-more" aria-label="上一页参考图"
                aria-disabled={page === 0} onClick={() => setReferencePage(Math.max(0, page - 1))}>
                <ChevronLeft size={14} />
              </button>
            ) : null}
            <div className="vstudio-asset-strip">
              <div className={`image-reference-tiles vstudio-asset-stack${folded ? " is-collapsed" : ""}`}
                data-count={folded ? `${images.length}/${maxReferences}` : undefined}
                onMouseEnter={() => setReferencesExpanded(true)}>
                {visibleImages.map((image, index) => {
                  const label = `图片${firstVisible + index + 1}`;
                  return (
                    <div className="vstudio-media-tile" key={image.previewUrl} data-reference-index={firstVisible + index}
                      style={stacked ? { "--tile-i": index } as CSSProperties : undefined}>
                      <button type="button" className="vstudio-media-open" title={image.file.name}
                        aria-label={`查看${label}`} onClick={() => setPreview(image)}>
                        <img src={image.previewUrl} alt="" /><span className="vstudio-media-tag">{label}</span>
                      </button>
                      {!folded ? (
                        <button type="button" className="vstudio-media-remove" aria-label={`移除${label}`}
                          disabled={disabled} onClick={() => references.remove(image.previewUrl)}><X size={12} /></button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            {showReferenceArrows ? (
              <button type="button" className="vstudio-asset-more" aria-label="下一页参考图"
                aria-disabled={page === pages - 1} onClick={() => setReferencePage(Math.min(pages - 1, page + 1))}>
                <ChevronRight size={14} />
              </button>
            ) : null}
            {!folded && images.length > 1 ? (
              <button type="button" className="icon-button compact" aria-label="移除全部参考图"
                disabled={disabled} onClick={references.clear}><X size={15} /></button>
            ) : null}
          </div>
        </div>
        {referenceError || defaultLimit ? (
          <p className="image-reference-note" role={referenceError ? "status" : undefined}>
            {referenceError ?? `应用默认最多 ${maxReferences} 张参考图`}
          </p>
        ) : null}

        <div className={`image-prompt-block${editorExpanded ? " is-expanded" : ""}`}>
          <PromptEditor
            ref={editor}
            value={value}
            items={items}
            maxLength={20000}
            placeholder="描述画面内容，输入 @ 引用参考图……"
            onChange={onChange}
            onTypedAt={(rect) => { setMentionRect(rect); setMentionOpen(true); }}
            onOpenItem={(item) => {
              const image = images.find(candidate => candidate.previewUrl === item.previewUrl);
              if (image) setPreview(image);
            }}
          />
          <div className="vstudio-composer-tools">
            <button type="button" ref={mentionButton} className="vstudio-tool" aria-label="引用素材"
              aria-haspopup="dialog" aria-expanded={mentionOpen}
              onClick={() => { setMentionRect(null); setMentionOpen(open => !open); }}>@</button>
            <button type="button" className="vstudio-tool" aria-label={editorExpanded ? "收起输入框" : "展开输入框"}
              aria-expanded={editorExpanded} onClick={() => setEditorExpanded(expanded => !expanded)}>
              {editorExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
      </div>
      <VideoMentionPanel
        open={mentionOpen}
        anchor={mentionRect ?? mentionButton.current}
        imagesOnly
        items={items}
        uploads={[{ kind: "图片", disabled: !canAdd, hint: images.length >= maxReferences ? "参考图已达上限" : "PNG / JPEG / WebP" }]}
        onUpload={addImages}
        onClose={() => setMentionOpen(false)}
        onSelect={(label) => { editor.current?.insertMention(label); setMentionOpen(false); }}
      />
      {preview ? createPortal(
        <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="参考图预览"
          onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null); }}>
          <div className={`image-preview${previewInpaint ? " has-inpaint-tools" : ""}`}>
            <img src={preview.previewUrl} alt={preview.file.name} />
            {previewInpaint ? (
              <div className="image-preview-tools">
                <button type="button" className="secondary-button" disabled={disabled || reading} onClick={() => {
                  setPreview(null);
                  previewInpaint.open();
                }}><Paintbrush size={16} />{previewInpaint.maskApplied ? "编辑蒙版" : "局部重绘"}</button>
                {previewInpaint.maskApplied ? (
                  <button type="button" className="secondary-button" disabled={disabled || reading} onClick={previewInpaint.clear}>移除蒙版</button>
                ) : null}
              </div>
            ) : null}
            <button type="button" className="image-preview-close" aria-label="关闭参考图预览" onClick={() => setPreview(null)}><X size={20} /></button>
          </div>
        </div>, document.body,
      ) : null}
    </>
  );
}
