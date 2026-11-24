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
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { ArrowUp, CornerDownLeft, FileText, Film, Music, Plus, Square, X } from "lucide-react";
import type { ClipboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { WorkspaceSkillInfo } from "../../shared/local-workspace";
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types";
import { MAX_SCRIPT_FILE_BYTES } from "../../shared/storyboard";
import { BINARY_DOCUMENT_ATTACHMENT, CHAT_DOCUMENT_ATTACHMENT, MAX_BINARY_DOCUMENT_BYTES } from "../../shared/document-formats";
import { CHAT_MEDIA_ACCEPT, chatMediaMime, MAX_CHAT_MEDIA_BYTES, MAX_CHAT_MEDIA_FILES, MAX_CHAT_MEDIA_MB } from "../../shared/chat-media";
import { useFileDrop } from "../useFileDrop";
import { useImagePaste } from "../useImagePaste";
import { CanvasTray, type CanvasTrayItem } from "./CanvasTray";
import type { ChatVideoFrames } from "../../shared/agent-types";
import { api } from "../api";
import { readChatReferences } from "./video-clipboard";

/**
 * 待发附件。只放**本地文件**：
 * - 图片 `file`：从资源管理器拖/选进来的本地图片，发送时才真的上传
 * - 文档和音视频 `file`：发送时上传
 *
 * 会话里已有的产物不进这里——拖进来会直接进画布，和画布缩略图只出现一次。
 */
type PendingAttachment = {
  url: string;
  name: string;
  file: File;
  kind: "image" | "document" | "audio" | "video";
};

/** 和输入框同宽的图片白名单，和服务端那道真正的把关（看字节头）不是一回事 */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)$/i;
const MAX_DOCUMENTS_PER_MESSAGE = 3;

export function isScriptDocument(file: File): boolean {
  return CHAT_DOCUMENT_ATTACHMENT.test(file.name);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.test(file.name);
}

export function Composer({
  conversationId,
  running,
  uploading,
  disabled,
  placeholder,
  leftSlot,
  workspaceSkills = [],
  rightSlot,
  statusSlot,
  onSend,
  onInterrupt,
  onAssetAttached,
  canvasItems = [],
  imageVisionWarning,
  plainAttachments = false,
  maxImageAttachments = MAX_REFERENCE_IMAGES,
  videoFrames,
  onClearVideoFrames,
  onPreviewCanvas,
  onRemoveCanvas,
  onSetCanvasFirst,
  onSetCanvasLast,
}: {
  conversationId: string;
  running: boolean;
  /** 图正在上传：按钮转圈，这期间不许再放进来 */
  uploading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 左下角：会话级设置（视频确认策略等） */
  leftSlot?: ReactNode;
  workspaceSkills?: WorkspaceSkillInfo[];
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
  /** 已有产物拖进输入框时，直接加入画布（同一份缩略图只出现一次） */
  onAssetAttached?: (assetId: string) => void;
  /** 这一轮画布里已经选好的图，直接排在附件区 */
  canvasItems?: CanvasTrayItem[];
  imageVisionWarning?: string;
  plainAttachments?: boolean;
  maxImageAttachments?: number;
  videoFrames?: Partial<ChatVideoFrames>;
  onClearVideoFrames?: () => void;
  onPreviewCanvas?: (assetId: string) => void;
  onRemoveCanvas?: (assetId: string) => void;
  onSetCanvasFirst?: (assetId: string) => void;
  onSetCanvasLast?: (assetId: string) => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [reject, setReject] = useState<string | null>(null);
  const [readingMedia, setReadingMedia] = useState(false);
  const mediaRequest = useRef<AbortController | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 一轮正在跑的时候不让传：画布会在中途被换掉，大脑看到的和用户以为的对不上
  const blocked = running || Boolean(disabled) || Boolean(uploading) || readingMedia;
  const hasMedia = pending.some(item => item.kind === "audio" || item.kind === "video");
  const selectedImageCount = canvasItems.filter(({ asset }) => asset.mimeType.startsWith("image/")).length;
  const selectedMediaCount = canvasItems.length - selectedImageCount;
  const [hideSkills, setHideSkills] = useState(false);
  const skillMention = /(?:^|\s)\$([a-z0-9-]*)$/i.exec(text);
  const matchingSkills = !hideSkills && !blocked && skillMention
    ? workspaceSkills.filter(({ name }) => name.startsWith(skillMention[1]!.toLowerCase())).slice(0, 8) : [];

  // 组件卸载时把没发出去的预览地址收掉，否则每挂一张图就漏一个 blob
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => { pendingRef.current.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); }); }, []);
  useEffect(() => {
    setReadingMedia(false);
    return () => {
      mediaRequest.current?.abort();
      mediaRequest.current = null;
    };
  }, [conversationId]);

  function addFiles(files: File[], assetIds: string[] = []) {
    const images = files.filter(isImageFile);
    const documents = files.filter(isScriptDocument);
    const media = files.flatMap(file => {
      if (isImageFile(file) || isScriptDocument(file)) return [];
      const mime = chatMediaMime(file);
      return mime ? [{ file, kind: mime.startsWith("audio/") ? "audio" as const : "video" as const }] : [];
    });
    // 页内拖过来的产物不用再过格式和大小那两关：它本来就已经在会话里了
    const attachedAssets = assetIds.filter((id) => !canvasItems.some((item) => item.asset.id === id));
    if (files.length !== images.length + documents.length + media.length) {
      setReject("支持图片、文档及 MP3、WAV、M4A、MP4、MOV、WebM 附件");
      return;
    }
    if (!files.length && !attachedAssets.length) return;
    const currentImages = pending.filter((item) => item.kind === "image").length;
    const currentDocuments = pending.filter((item) => item.kind === "document").length;
    if (currentImages + images.length + (plainAttachments ? selectedImageCount + attachedAssets.length : 0) > maxImageAttachments) {
      setReject(`一次最多 ${maxImageAttachments} 张图片`);
      return;
    }
    if (currentDocuments + documents.length > MAX_DOCUMENTS_PER_MESSAGE) {
      setReject(`一次最多 ${MAX_DOCUMENTS_PER_MESSAGE} 个文档`);
      return;
    }
    if (selectedMediaCount + pending.filter(item => item.kind === "audio" || item.kind === "video").length + media.length > MAX_CHAT_MEDIA_FILES) {
      setReject(`一次最多上传 ${MAX_CHAT_MEDIA_FILES} 个音视频文件`);
      return;
    }
    const oversizedMedia = media.find(({ file }) => file.size > MAX_CHAT_MEDIA_BYTES);
    if (oversizedMedia) { setReject(`${oversizedMedia.file.name} 超过 ${MAX_CHAT_MEDIA_MB} MB`); return; }
    const oversizedImage = images.find((file) => file.size > MAX_REFERENCE_IMAGE_BYTES);
    if (oversizedImage) { setReject(`${oversizedImage.name} 超过 20 MB`); return; }
    const oversizedDocument = documents.find((file) => file.size > (BINARY_DOCUMENT_ATTACHMENT.test(file.name) ? MAX_BINARY_DOCUMENT_BYTES : MAX_SCRIPT_FILE_BYTES));
    if (oversizedDocument) { setReject(`${oversizedDocument.name} 超过文件大小限制（文本 2 MB，Office、PDF 和 XMind 10 MB）`); return; }
    setReject(null);
    setPending((current) => [
      ...current,
      ...images.map((file) => ({ file, name: file.name, url: URL.createObjectURL(file), kind: "image" as const })),
      ...documents.map((file) => ({ file, name: file.name, url: "", kind: "document" as const })),
      ...media.map(({ file, kind }) => ({ file, name: file.name, url: "", kind })),
    ]);
    // 拖进来的既有产物直接进「这一轮要带的图」，不再额外挂一份附件
    for (const assetId of attachedAssets) onAssetAttached?.(assetId);
  }

  function removePending(item: PendingAttachment) {
    // 只有本地图片才有 blob 地址要回收；文档没有 blob
    if (item.url) URL.revokeObjectURL(item.url);
    setPending((current) => current.filter((entry) => entry !== item));
  }

  const { active, dropProps } = useFileDrop(!blocked, addFiles);
  // Ctrl+V 和拖拽/选文件走同一条路：先挂成待发附件，点发送才真的上传
  useImagePaste((files) => addFiles(files), !blocked);

  function insertPastedText(value: string) {
    if (!value) return;
    const area = areaRef.current;
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? start;
    setText((current) => {
      const from = Math.min(start, current.length);
      const to = Math.min(end, current.length);
      return `${current.slice(0, from)}${value}${current.slice(to)}`;
    });
  }

  /**
   * 粘贴一条被复制的消息。
   *
   * 复制时图片/视频/音频会写成 chatcanvas://asset/... 引用；这里把引用还原成原文件，
   * 图片直接进待发附件，正文插回输入框。没有引用的普通粘贴交给 useImagePaste / 浏览器。
   */
  async function pasteClipboard(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.getData("text/plain");
    const { media, documents, text: remainder } = readChatReferences(pasted);
    if (!media.length && !documents.length) return;
    event.preventDefault();
    if (blocked || mediaRequest.current) return;

    const controller = new AbortController();
    mediaRequest.current = controller;
    setReadingMedia(true);
    setReject(null);
    insertPastedText(remainder);
    try {
      const files: File[] = [];
      const failed: string[] = [];
      for (const reference of media) {
        try {
          const file = await api.assetAsFile(reference, controller.signal);
          if (controller.signal.aborted) return;
          if (!isImageFile(file) && !chatMediaMime(file)) throw new Error(`${reference.fileName} 不是可发送的图片或音视频`);
          files.push(file);
        } catch {
          if (controller.signal.aborted) return;
          failed.push(reference.fileName);
        }
      }
      for (const reference of documents) {
        try {
          const file = await api.conversationDocumentAsFile(reference.conversationId, reference.documentId, reference.fileName, controller.signal);
          if (controller.signal.aborted) return;
          if (!isScriptDocument(file)) throw new Error(`${reference.fileName} 不是可发送的文档`);
          files.push(file);
        } catch {
          if (controller.signal.aborted) return;
          failed.push(reference.fileName);
        }
      }
      if (files.length) addFiles(files);
      if (failed.length) {
        const warning = `以下附件未能恢复，请重新选择：${failed.join("、")}`;
        setReject((message) => message ? `${message}。${warning}` : warning);
      }
    } finally {
      if (mediaRequest.current === controller) {
        mediaRequest.current = null;
        setReadingMedia(false);
      }
    }
  }

  function useSkill(name: string) {
    setText((current) => current.replace(/\$[a-z0-9-]*$/i, () => `$${name} `));
    setHideSkills(true);
    areaRef.current?.focus();
  }

  function submit() {
    const value = text.trim();
    if ((!value && !hasMedia) || blocked) return;
    if (plainAttachments && selectedImageCount + pending.filter((item) => item.kind === "image").length > maxImageAttachments) {
      setReject(`一次最多 ${maxImageAttachments} 张图片`);
      return;
    }
    const files = pending.map((item) => item.file);
    setText("");
    setPending([]);
    setReject(null);
    // 交出去之后由 ChatView 负责上传 / 并入画布，blob 地址在这里就没用了
    pending.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); });
    onSend(value, files, []);
    // 高度被撑开过的话收回去，否则下一条消息的输入框还是大的
    if (areaRef.current) areaRef.current.style.height = "auto";
  }

  return (
    <div className={`composer ${active ? "is-drop" : ""}`} {...dropProps}>
      <div className="composer-box">
        {matchingSkills.length ? <div className="workspace-skill-suggestions" aria-label="工作区 Skills">
          {matchingSkills.map(({ name, description }) => <button key={name} type="button" onClick={() => useSkill(name)}>
            <strong>{`$${name}`}</strong><span>{description}</span>
          </button>)}
        </div> : null}
        {canvasItems.length || pending.length ? (
          <div className="composer-attachments">
            <CanvasTray
              items={canvasItems}
              plain={plainAttachments}
              videoFrames={videoFrames}
              onClearVideoFrames={onClearVideoFrames}
              onPreview={onPreviewCanvas ?? (() => undefined)}
              onRemove={onRemoveCanvas ?? (() => undefined)}
              onSetFirst={onSetCanvasFirst ?? (() => undefined)}
              onSetLast={onSetCanvasLast ?? (() => undefined)}
            />
            {pending.map((item, index) => (
              <div
                key={item.url || `${item.kind}:${item.name}:${index}`}
                className={`composer-attachment ${item.kind !== "image" ? "is-document" : ""}`}
                title={item.kind === "document"
                  ? `${item.name} · 发送时读取全文，只在当轮交给助手`
                  : item.name}
              >
                {item.kind !== "image" ? (
                  <span className="composer-attachment-file">
                    {item.kind === "audio" ? <Music size={16} /> : item.kind === "video" ? <Film size={16} /> : <FileText size={16} />}
                    <span>{item.name}</span>
                  </span>
                ) : <img src={item.url} alt={item.name} />}
                <button
                  type="button"
                  className="composer-attachment-remove"
                  title="移除附件"
                  aria-label={`移除 ${item.name}`}
                  onClick={() => removePending(item)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {imageVisionWarning && (selectedImageCount > 0 || pending.some(item => item.kind === "image")) ? (
              <p className="composer-image-warning" role="status">{imageVisionWarning}</p>
            ) : null}
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
          onPaste={(event) => void pasteClipboard(event)}
          onChange={(event) => {
            setHideSkills(false);
            setText(event.target.value);
            // 跟着内容长高，最多 40vh 后自己出滚动条
            const area = event.currentTarget;
            area.style.height = "auto";
            area.style.height = `${Math.min(area.scrollHeight, window.innerHeight * 0.4)}px`;
          }}
          onKeyDown={(event) => {
            if (matchingSkills.length && (event.key === "Escape" || event.key === "Tab")) {
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                useSkill(matchingSkills[0]!.name);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setHideSkills(true);
              }
              return;
            }
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
            title="上传图片、文档、音频或视频（可拖入）"
            disabled={blocked}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <LoadingIndicator variant="dots" size={24} /> : <Plus size={15} />}
          </button>
          {/* 系统文件对话框只能按 MIME 提示过滤，真正的把关在服务端（字节头要对得上） */}
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            accept={`image/png,image/jpeg,image/webp,.txt,.md,.markdown,.csv,.json,.xmind,.pptx,.docx,.xlsx,.pdf,text/plain,text/markdown,${CHAT_MEDIA_ACCEPT}`}
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
                disabled={(!text.trim() && !hasMedia) || blocked}
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
        {canvasItems.length ? (
          <span className="composer-hint-pending">
            {[selectedImageCount ? `${selectedImageCount} 张图片` : "", selectedMediaCount ? `${selectedMediaCount} 项音视频` : ""].filter(Boolean).join(" · ")} 随本轮消息发送
          </span>
        ) : null}
        <div className="composer-hint-right">
          {statusSlot}
          {uploading ? <span className="composer-hint-run">正在上传附件…</span>
            : running ? <span className="composer-hint-run">助手正在处理…</span>
              : readingMedia ? <span className="composer-hint-run" role="status">正在读取附件…</span> : null}
        </div>
      </div>
      {reject ? <div className="composer-reject" role="alert">{reject}</div> : null}
    </div>
  );
}
