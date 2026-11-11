import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, LoaderCircle, Maximize2, Minimize2, Paintbrush, X } from "lucide-react";
import { MAX_REFERENCE_IMAGES } from "../../shared/types";
import type { ReferenceController, ReferenceImageState } from "../app-shared";
import { useFileDrop } from "../useFileDrop";
import { PromptEditor, type PromptEditorHandle } from "../video/PromptEditor";
import { VideoMentionPanel, type MentionItem } from "../video/VideoMentionPanel";
import type { PanelAnchorRect } from "../video/useAnchoredPanel";

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
  value, onChange, references, disabled, midjourney, inpaint,
}: {
  value: string;
  onChange: (value: string) => void;
  references: ReferenceController;
  disabled: boolean;
  midjourney: boolean;
  inpaint?: { maskApplied: boolean; open: () => void; clear: () => void };
}) {
  const { images, reading } = references;
  const [referencesExpanded, setReferencesExpanded] = useState(false);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionRect, setMentionRect] = useState<PanelAnchorRect | null>(null);
  const [preview, setPreview] = useState<ReferenceImageState | null>(null);
  const editor = useRef<PromptEditorHandle>(null);
  const mentionButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAdd = !disabled && !reading && images.length < MAX_REFERENCE_IMAGES;
  const drop = useFileDrop(canAdd, references.dropFiles);
  const items: MentionItem[] = images.slice(0, midjourney ? 1 : undefined).map((image, index) => ({
    label: `图片${index + 1}`, kind: "图片", previewUrl: image.previewUrl,
  }));
  const folded = images.length > 0 && !referencesExpanded;
  const firstVisible = folded ? Math.max(0, images.length - 3) : 0;
  const previewInpaint = preview && images.length === 1 && images[0].previewUrl === preview.previewUrl ? inpaint : undefined;

  useEffect(() => {
    if (!preview) return;
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [preview]);

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
        <div
          className={`image-reference-strip${folded ? " is-folded" : ""}${images.length > 1 && folded ? " is-stacked" : ""}`}
          onMouseLeave={() => setReferencesExpanded(false)}
          onFocusCapture={() => setReferencesExpanded(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setReferencesExpanded(false);
          }}
          aria-label={`参考图 ${images.length}/${MAX_REFERENCE_IMAGES}`}
        >
          {!folded ? (
            <button type="button" className="image-reference-add" onClick={addImages} disabled={!canAdd}
              title="点击选择、拖入或 Ctrl+V 粘贴 · PNG / JPEG / WebP · 单张最大 20 MB">
              {reading ? <LoaderCircle size={17} className="spin" /> : <ImagePlus size={17} />}
              <span>{drop.active ? "松开添加" : "参考图"}</span>
            </button>
          ) : null}
          <div className="image-reference-tiles" onMouseEnter={() => setReferencesExpanded(true)}>
            {images.slice(firstVisible).map((image, index) => {
              const label = `图片${firstVisible + index + 1}`;
              return (
                <div className="image-reference-tile" key={image.previewUrl}>
                  <button type="button" className="image-reference-open" title={image.file.name}
                    aria-label={`查看${label}`} onClick={() => setPreview(image)}>
                    <img src={image.previewUrl} alt="" /><span>{label}</span>
                  </button>
                  {!folded ? (
                    <button type="button" className="image-reference-remove" aria-label={`移除${label}`}
                      disabled={disabled} onClick={() => references.remove(image.previewUrl)}><X size={12} /></button>
                  ) : null}
                </div>
              );
            })}
            {folded && images.length > 1 ? <span className="image-reference-count">{images.length}</span> : null}
          </div>
          {!folded && images.length > 1 ? (
            <button type="button" className="icon-button compact" aria-label="移除全部参考图"
              disabled={disabled} onClick={references.clear}><X size={15} /></button>
          ) : null}
        </div>
        {midjourney && images.length > 0 ? (
          <p className="image-reference-note" title="Midjourney 只使用第 1 张参考图">MJ 仅用第 1 张参考图</p>
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
        uploads={[{ kind: "图片", disabled: !canAdd, hint: images.length >= MAX_REFERENCE_IMAGES ? "参考图已达上限" : "PNG / JPEG / WebP" }]}
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
