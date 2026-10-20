import { useEffect, useRef, useState } from "react";
import { AlertCircle, Eraser, LoaderCircle, Paintbrush, RotateCcw, X } from "lucide-react";
import { MAX_MASK_IMAGE_BYTES } from "../shared/types";

/** 涂抹层的显示色：只影响界面，导出的蒙版只看 alpha */
const MASK_COLOR = "#d92d20";

export interface MaskEditorResult {
  file: File;
  /** 「原图 + 红色涂抹」的小缩略图，由调用方负责 revoke */
  previewUrl: string;
}

/**
 * 局部重绘蒙版编辑器。
 *
 * 两层同尺寸 canvas：底层画参考图，上层画涂抹。上层用半透明红色显示，
 * 导出时把上层当遮罩挖掉一层白色——于是「涂过的地方」在 PNG 里是透明的，
 * 正好对上 OpenAI Images 的约定（透明 = 重新生成）。
 */
export function MaskEditorDialog(props: {
  sourceUrl: string;
  sourceName: string;
  initialMask?: File | null;
  onClose: () => void;
  onApply: (result: MaskEditorResult) => void;
}) {
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushPercent, setBrushPercent] = useState(3);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSize(null);
    drawingRef.current = false;
    lastPointRef.current = null;

    const image = new Image();
    image.onload = async () => {
      if (cancelled) return;
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      const source = sourceCanvasRef.current;
      const paint = paintCanvasRef.current;
      const sourceCtx = source?.getContext("2d");
      // 蒙版层会被反复读回（还原旧蒙版、判断有没有涂过、导出），提前声明省掉读回警告
      const paintCtx = paint?.getContext("2d", { willReadFrequently: true });
      if (!source || !paint || !sourceCtx || !paintCtx || !width || !height) {
        setError("无法读取参考图尺寸");
        setLoading(false);
        return;
      }
      source.width = width;
      source.height = height;
      paint.width = width;
      paint.height = height;
      sourceCtx.drawImage(image, 0, 0, width, height);
      paintCtx.clearRect(0, 0, width, height);

      if (props.initialMask) {
        try {
          const maskUrl = URL.createObjectURL(props.initialMask);
          const maskImage = await loadImage(maskUrl);
          URL.revokeObjectURL(maskUrl);
          if (cancelled) return;
          // 蒙版的透明区域 = 要重绘的区域，把它还原成红色涂抹层
          const scratch = document.createElement("canvas");
          scratch.width = width;
          scratch.height = height;
          const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
          if (scratchCtx) {
            scratchCtx.drawImage(maskImage, 0, 0, width, height);
            const maskData = scratchCtx.getImageData(0, 0, width, height).data;
            const overlay = paintCtx.createImageData(width, height);
            for (let index = 0; index < maskData.length; index += 4) {
              if (maskData[index + 3] >= 128) continue;
              overlay.data[index] = 217;
              overlay.data[index + 1] = 45;
              overlay.data[index + 2] = 32;
              overlay.data[index + 3] = 255;
            }
            paintCtx.putImageData(overlay, 0, 0);
          }
        } catch {
          // 旧蒙版读不出来时就让用户重新涂，不要把整个编辑器卡死
        }
      }

      if (cancelled) return;
      setSize({ width, height });
      setLoading(false);
    };
    image.onerror = () => {
      if (cancelled) return;
      setError("无法读取参考图，请重新选择图片");
      setLoading(false);
    };
    image.src = props.sourceUrl;
    return () => { cancelled = true; };
  }, [props.sourceUrl, props.initialMask]);

  /** 屏幕坐标 → 原始像素坐标；CSS 缩放、窗口大小都靠实时 rect 换算 */
  function pointFromEvent(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = paintCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
    };
  }

  function brushWidth() {
    if (!size) return 24;
    return Math.max(4, Math.round(Math.min(size.width, size.height) * brushPercent / 100));
  }

  function configure(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brushWidth();
    ctx.strokeStyle = MASK_COLOR;
    ctx.fillStyle = MASK_COLOR;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const canvas = paintCanvasRef.current;
    const point = pointFromEvent(event);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !point || !ctx) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    lastPointRef.current = point;
    configure(ctx);
    ctx.beginPath();
    ctx.arc(point.x, point.y, brushWidth() / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = paintCanvasRef.current;
    const point = pointFromEvent(event);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !point || !ctx) return;
    event.preventDefault();
    const from = lastPointRef.current ?? point;
    configure(ctx);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
  }

  function finishStroke(event: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function clearPaint() {
    const canvas = paintCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setError("");
  }

  async function apply() {
    const paint = paintCanvasRef.current;
    const source = sourceCanvasRef.current;
    const paintCtx = paint?.getContext("2d");
    if (!paint || !source || !paintCtx) return;
    if (!hasPaintedPixels(paint, paintCtx)) {
      setError("请先涂抹要重新生成的区域");
      return;
    }
    setError("");
    setExporting(true);
    try {
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = paint.width;
      maskCanvas.height = paint.height;
      const maskCtx = maskCanvas.getContext("2d");
      if (!maskCtx) throw new Error("无法创建蒙版画布");
      // 先铺满不透明白色，再把涂抹层挖成透明——透明处就是上游要重绘的地方
      maskCtx.fillStyle = "#ffffff";
      maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      maskCtx.globalCompositeOperation = "destination-out";
      maskCtx.drawImage(paint, 0, 0);
      maskCtx.globalCompositeOperation = "source-over";

      const blob = await canvasToBlob(maskCanvas);
      if (!blob || !blob.size) throw new Error("导出蒙版失败");
      if (blob.size > MAX_MASK_IMAGE_BYTES) throw new Error("蒙版超过 4 MB，请缩小涂抹范围后重试");
      const stem = props.sourceName.replace(/\.[^.]+$/, "").slice(0, 80) || "image";
      const file = new File([blob], `${stem}-mask.png`, { type: "image/png" });
      const previewUrl = await buildPreview(source, paint);
      props.onApply({ file, previewUrl });
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "导出蒙版失败");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !exporting) props.onClose(); }}
    >
      <div className="modal mask-editor-modal" role="dialog" aria-modal="true" aria-label="局部重绘蒙版">
        <div className="modal-header">
          <div><Paintbrush size={18} /><h2>局部重绘</h2></div>
          <button type="button" className="icon-button" title="关闭" onClick={props.onClose}><X size={18} /></button>
        </div>
        <div className="modal-body mask-editor-body">
          <div className="mask-toolbar">
            <div className="mask-tool-group" role="group" aria-label="绘制工具">
              <button
                type="button"
                className={`icon-button ${tool === "brush" ? "is-on" : ""}`}
                title="画笔：涂抹要重新生成的区域"
                aria-pressed={tool === "brush"}
                onClick={() => setTool("brush")}
              ><Paintbrush size={16} /></button>
              <button
                type="button"
                className={`icon-button ${tool === "eraser" ? "is-on" : ""}`}
                title="橡皮擦：取消涂抹"
                aria-pressed={tool === "eraser"}
                onClick={() => setTool("eraser")}
              ><Eraser size={16} /></button>
            </div>
            <label className="mask-size">
              <span>笔刷</span>
              <input
                type="range"
                min={1}
                max={25}
                step={1}
                value={brushPercent}
                onChange={(event) => setBrushPercent(Number(event.target.value))}
                aria-label="笔刷大小"
              />
              <small>{brushPercent}%</small>
            </label>
            <button type="button" className="secondary-button" onClick={clearPaint}>
              <RotateCcw size={15} />清空
            </button>
          </div>
          <p className="mask-hint">涂抹红色区域 = 重新生成；未涂抹区域尽量保持不变。注意：这是引导式编辑，不是 DALL·E 2 级别的像素级硬约束，模型仍可能改动蒙版外内容。提示词建议写明主体和位置（例如「白色兔子头上的蝴蝶结」）。</p>
          <div className="mask-canvas-stage">
            <canvas ref={sourceCanvasRef} aria-hidden="true" className={loading ? "is-loading" : ""} />
            <canvas
              ref={paintCanvasRef}
              className={`mask-paint ${loading ? "is-loading" : ""}`}
              aria-label="重绘蒙版画布"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishStroke}
              onPointerCancel={finishStroke}
            />
            {loading ? <span className="mask-stage-status"><LoaderCircle className="spin" size={18} />读取图片…</span> : null}
          </div>
          {error ? <div className="form-error"><AlertCircle size={15} />{error}</div> : null}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={props.onClose}>取消</button>
          <button type="button" className="primary-button" onClick={() => void apply()} disabled={loading || exporting}>
            {exporting ? <LoaderCircle className="spin" size={16} /> : <Paintbrush size={16} />}应用蒙版
          </button>
        </div>
      </div>
    </div>
  );
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取蒙版"));
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** 有没有涂过任何一笔；擦到全空也返回 false，所以不能只靠 pointerdown 记状态 */
function hasPaintedPixels(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) return true;
  }
  return false;
}

/** 160px 缩略图：原图上叠红色涂抹，避免「白底蒙版看起来是空白」 */
async function buildPreview(source: HTMLCanvasElement, paint: HTMLCanvasElement) {
  const longest = Math.max(source.width, source.height) || 1;
  const scale = Math.min(1, 160 / longest);
  const preview = document.createElement("canvas");
  preview.width = Math.max(1, Math.round(source.width * scale));
  preview.height = Math.max(1, Math.round(source.height * scale));
  const ctx = preview.getContext("2d");
  if (!ctx) throw new Error("生成蒙版预览失败");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, preview.width, preview.height);
  ctx.drawImage(source, 0, 0, preview.width, preview.height);
  ctx.globalAlpha = 0.42;
  ctx.drawImage(paint, 0, 0, preview.width, preview.height);
  ctx.globalAlpha = 1;
  const blob = await canvasToBlob(preview);
  if (!blob) throw new Error("生成蒙版预览失败");
  return URL.createObjectURL(blob);
}
