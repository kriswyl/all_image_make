/**
 * 输入框。
 *
 * 回车发送、Shift+回车换行——对话式界面里最省的交互，用户不用挪手去点按钮。
 * 正在跑的时候按钮变成「停止」：一堂生图要几十秒，没有中断入口用户只能干等。
 *
 * 图片是**先待在框里、发送时才上传**的（对齐 Codex）：+ 或拖拽进来只是挂成待发附件，
 * 在输入框上方以缩略图排开，可以逐张删掉；点发送才真的传上去、才进画布。
 * 以前是拖进来就立刻上传，用户还没想好要不要用它，画布就已经被换掉了。
 *
 * 结构对齐 Codex：整块是一个圆角输入容器，上面写字、下面一行放控件——
 * 左边是附件和会话级设置（`leftSlot`），右边是模型选择和发送（`rightSlot`）。
 * 槽位由 ChatView 传进来：会话的大脑模型、视频确认策略这些开关属于会话，
 * 摆在这一行才符合「输入框下面挂着的都是我这次要用的设定」这个直觉。
 */
import { ArrowUp, CornerDownLeft, FileText, LoaderCircle, Plus, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types";
import { MAX_SCRIPT_FILE_BYTES } from "../../shared/storyboard";
import { api } from "../api";
import { useFileDrop } from "../useFileDrop";
import { useImagePaste } from "../useImagePaste";

/**
 * 待发附件。三种来源：
 * - 图片 `file`：从资源管理器拖/选进来的本地图片，发送时才真的上传
 * - 文档 `file`：`.txt` / `.md` 剧本，发送时读成文本再上传
 * - `assetId`：会话里**已经生成**的图，被拖进来当参考——不用上传，发送时并进画布
 */
type PendingAttachment = {
  url: string;
  name: string;
  file?: File;
  assetId?: string;
  kind: "image" | "document";
};

/** 和输入框同宽的图片白名单，和服务端那道真正的把关（看字节头）不是一回事 */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
/** 剧本只收纯文本格式：docx/pdf 的解析质量不稳定，首版不做 */
const DOCUMENT_EXTENSIONS = /\.(txt|md|markdown)$/i;
const MAX_DOCUMENTS_PER_MESSAGE = 3;

export function isScriptDocument(file: File): boolean {
  return DOCUMENT_EXTENSIONS.test(file.name);
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}

export function Composer({
  running,
  uploading,
  disabled,
  placeholder,
  leftSlot,
  rightSlot,
  statusSlot,
  onSend,
  onInterrupt,
  onAssetAttached,
  onAssetDetached,
}: {
  running: boolean;
  /** 图正在上传：按钮转圈，这期间不许再放进来 */
  uploading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 左下角：会话级设置（视频确认策略等） */
  leftSlot?: ReactNode;
  /** 右下角：模型选择，排在发送键左边 */
  rightSlot?: ReactNode;
  /** 底部状态行的右侧：token 用量 / 上下文大小，和「正在处理」并排 */
  statusSlot?: ReactNode;
  /**
   * 回车或点发送：把文字和**这一刻**挂着的图一起交出去。
   * `files` 是本地文件（这时才上传），`assetIds` 是拖进来的已有产物（不用上传，并进画布）。
   */
  onSend: (text: string, files: File[], assetIds: string[]) => void;
  onInterrupt: () => void;
  /** 把已有产物拖进输入框时，立刻同步到画布；移除附件时再移出 */
  onAssetAttached?: (assetId: string) => void;
  onAssetDetached?: (assetId: string) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [reject, setReject] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 一轮正在跑的时候不让传：画布会在中途被换掉，大脑看到的和用户以为的对不上
  const blocked = running || Boolean(disabled) || Boolean(uploading);

  // 组件卸载时把没发出去的预览地址收掉，否则每挂一张图就漏一个 blob
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => { pendingRef.current.forEach((item) => URL.revokeObjectURL(item.url)); }, []);

  function addFiles(files: File[], assetIds: string[] = []) {
    const images = files.filter(isImageFile);
    const documents = files.filter(isScriptDocument);
    // 页内拖过来的产物不用再过格式和大小那两关：它本来就已经在会话里了
    const fromCanvas = assetIds.filter((id) => !pending.some((item) => item.assetId === id));
    if (!images.length && !documents.length && !fromCanvas.length) {
      // 拖了文件但没一张能收，才提示；拖的是别的东西就当没发生
      if (files.length) setReject("只支持 PNG、JPEG、WebP 图片，或 .txt / .md 脚本文档");
      return;
    }
    const currentImages = pending.filter((item) => item.kind === "image").length;
    const currentDocuments = pending.filter((item) => item.kind === "document").length;
    if (currentImages + images.length + fromCanvas.length > MAX_REFERENCE_IMAGES) {
      setReject(`一次最多 ${MAX_REFERENCE_IMAGES} 张图片`);
      return;
    }
    if (currentDocuments + documents.length > MAX_DOCUMENTS_PER_MESSAGE) {
      setReject(`一次最多 ${MAX_DOCUMENTS_PER_MESSAGE} 个脚本文档`);
      return;
    }
    const oversizedImage = images.find((file) => file.size > MAX_REFERENCE_IMAGE_BYTES);
    if (oversizedImage) { setReject(`${oversizedImage.name} 超过 10 MB`); return; }
    const oversizedDocument = documents.find((file) => file.size > MAX_SCRIPT_FILE_BYTES);
    if (oversizedDocument) { setReject(`${oversizedDocument.name} 超过 2 MB，请先拆分`); return; }
    setReject(null);
    setPending((current) => [
      ...current,
      ...images.map((file) => ({ file, name: file.name, url: URL.createObjectURL(file), kind: "image" as const })),
      ...documents.map((file) => ({ file, name: file.name, url: "", kind: "document" as const })),
      ...fromCanvas.map((assetId) => ({ assetId, name: assetId, url: api.assetUrl(`/api/assets/${assetId}/thumb`), kind: "image" as const })),
    ]);
    // 拖进来的既有产物立刻进画布：用户看到的就是「这一轮要带的图」
    for (const assetId of fromCanvas) onAssetAttached?.(assetId);
  }

  function removePending(item: PendingAttachment) {
    // 只有本地图片才有 blob 地址要回收；文档和产物都没有 blob
    if (item.file && item.url) URL.revokeObjectURL(item.url);
    if (item.assetId) onAssetDetached?.(item.assetId);
    setPending((current) => current.filter((entry) => entry !== item));
  }

  const { active, dropProps } = useFileDrop(!blocked, addFiles);
  // Ctrl+V 和拖拽/选文件走同一条路：先挂成待发附件，点发送才真的上传
  useImagePaste((files) => addFiles(files), !blocked);

  function submit() {
    const value = text.trim();
    // 图必须跟着一句话走：助手拿到一张没有说明的图，只能瞎猜要拿它做什么
    if (!value || running || disabled || uploading) return;
    const files = pending.filter((item) => item.file).map((item) => item.file!);
    const assetIds = pending.filter((item) => item.assetId).map((item) => item.assetId!);
    setText("");
    setPending([]);
    setReject(null);
    // 交出去之后由 ChatView 负责上传/并入画布，blob 地址在这里就没用了
    pending.forEach((item) => { if (item.file && item.url) URL.revokeObjectURL(item.url); });
    onSend(value, files, assetIds);
    // 高度被撑开过的话收回去，否则下一条消息的输入框还是大的
    if (areaRef.current) areaRef.current.style.height = "auto";
  }

  return (
    <div className={`composer ${active ? "is-drop" : ""}`} {...dropProps}>
      <div className="composer-box">
        {pending.length ? (
          <div className="composer-attachments">
            {pending.map((item) => (
              <div
                key={item.kind === "document" ? `doc:${item.name}:${item.file?.size}` : item.url || item.name}
                className={`composer-attachment ${item.kind === "document" ? "is-document" : ""}`}
                title={item.kind === "document"
                  ? `${item.name} · 发送时读取全文，只在当轮交给助手`
                  : item.file ? item.name : `${item.name} · 已在会话里`}
              >
                {item.kind === "document" ? (
                  <span className="composer-attachment-file">
                    <FileText size={16} />
                    <span>{item.name}</span>
                  </span>
                ) : <img src={item.url} alt={item.name} />}
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title={item.kind === "document" ? "移除这个文档" : "移除这张"}
                  aria-label={`移除 ${item.name}`}
                  onClick={() => removePending(item)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          value={text}
          maxLength={20000}
          disabled={disabled}
          placeholder={placeholder ?? "与助手协作：说你想画什么，或者要改哪张图…"}
          onChange={(event) => {
            setText(event.target.value);
            // 跟着内容长高，最多 40vh 后自己出滚动条
            const area = event.currentTarget;
            area.style.height = "auto";
            area.style.height = `${Math.min(area.scrollHeight, window.innerHeight * 0.4)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            // 中文输入法选词的回车不能当成发送
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />

        <div className="composer-bar">
          <button
            type="button"
            className={`composer-attach ${pending.length ? "is-on" : ""}`}
            title="传图片或脚本文档（.txt / .md；也可以直接拖进来）"
            disabled={blocked}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <LoaderCircle size={14} className="spin" /> : <Plus size={15} />}
          </button>
          {/* 系统文件对话框只能按 MIME 提示过滤，真正的把关在服务端（字节头要对得上） */}
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,.txt,.md,.markdown,text/plain,text/markdown"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              // 清掉 value：同一个文件连选两次也要能触发第二次 change
              event.target.value = "";
              if (files.length) addFiles(files);
            }}
          />

          {leftSlot}

          <div className="composer-bar-right">
            {rightSlot}
            {running ? (
              <button type="button" className="secondary-button composer-stop" onClick={onInterrupt} title="停下当前这一轮">
                <Square size={13} />停止
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                onClick={submit}
                disabled={!text.trim() || disabled}
                title="发送（回车）"
                aria-label="发送"
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-hint">
        <CornerDownLeft size={11} />
        <span>回车发送 · Shift + 回车换行</span>
        {/* 三种来源要说清各自会发生什么：本地图/文档是「发送时上传」，拖进来的产物是「引用它」 */}
        {pending.some((item) => item.file && item.kind === "image") ? (
          <span className="composer-hint-pending">{pending.filter((item) => item.file && item.kind === "image").length} 张本地图将在发送时上传</span>
        ) : null}
        {pending.some((item) => item.kind === "document") ? (
          <span className="composer-hint-pending">{pending.filter((item) => item.kind === "document").length} 个脚本文档将在发送时读取</span>
        ) : null}
        {pending.some((item) => item.assetId) ? (
          <span className="composer-hint-pending">{pending.filter((item) => item.assetId).length} 张引用自本会话，会一起进画布</span>
        ) : null}
        <div className="composer-hint-right">
          {statusSlot}
          {uploading ? <span className="composer-hint-run">正在上传图片…</span>
            : running ? <span className="composer-hint-run">助手正在处理…</span> : null}
        </div>
      </div>
      {reject ? <div className="composer-reject" role="alert">{reject}</div> : null}
    </div>
  );
}
