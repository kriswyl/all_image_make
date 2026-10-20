/**
 * 工具调用卡片（AGENT_PLAN.md §14 的 `plan` / `progress` / `message` 三个事件都落在这张卡上）。
 *
 * 一次工具调用在库里是**两行**：assistant 那行存大脑的计划和 `say`，
 * tool 那行存结果。渲染时把后面那行折进前面的卡片里，
 * 用户看到的就是「他说要做什么 → 做成了什么」一件事，而不是两条消息。
 */
import { AlertCircle, CheckCircle2, ChevronDown, Eye, Film, Image as ImageIcon, Layers, LoaderCircle, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { ASSET_DRAG_TYPE } from "../useFileDrop";
import { LazyVideoThumb } from "../LazyVideoThumb";
import { ParamChips } from "../ParamChips";
import {
  agentToolLabels, assetRef, readCanvasAssetIds, readParamNotes,
  type AgentToolName, type CanvasAsset, type ChatMessage, type ToolResult,
} from "../../shared/agent-types";
import type { Asset } from "../../shared/types";

const TOOL_ICONS: Record<AgentToolName, typeof ImageIcon> = {
  generate_image: ImageIcon,
  edit_image: Sparkles,
  view_images: Eye,
  set_canvas: Layers,
  optimize_prompt: Wand2,
  generate_video: Film,
  ask: Sparkles,
  reply: Sparkles,
};

export interface TaskProgress {
  status: string;
  progress: number | null;
}

/** 工具结果里给用户看的那几个字段，各工具不一样 */
function resultDetail(tool: AgentToolName, result: ToolResult | null) {
  const data = result?.data;
  if (!data) return [];
  const rows: Array<[string, string]> = [];
  if (typeof data.model === "string") rows.push(["模型", data.model]);
  if (tool === "optimize_prompt" && typeof data.prompt === "string") rows.push(["优化后", data.prompt]);
  if (tool === "generate_image" || tool === "edit_image") {
    if (typeof data.count === "number" && data.count > 1) rows.push(["张数", String(data.count)]);
  }
  if (typeof data.round === "number") rows.push(["轮次", `第 ${data.round} 轮`]);
  // set_canvas 一次设了多张时把整组列出来：ToolResult.assetId 只装得下主图，
  // 卡片上不写，用户就只能看见「切到 #a3f1」，看不到另外两张也被设进去了
  const canvasIds = readCanvasAssetIds(data);
  if (canvasIds.length > 1) rows.push(["画布", canvasIds.map((id) => assetRef(id)).join("、")]);
  // 模型是怎么选中的：优先用工具给的原话（可能是「按你设的默认模型用了 X」，
  // 也可能是「你设的默认模型 Y 已经不可用了」），老记录没有这句话时才退回原来的笼统说法
  if (typeof data.aliasNote === "string") rows.push(["模型来源", data.aliasNote]);
  else if (data.usedFallback === true) rows.push(["提示", "没认出模型名，用了默认渠道"]);
  return rows;
}

export function ToolCard({
  message,
  result,
  progress,
  stale = false,
  assets = [],
  onPreview,
  onDiagnostics,
}: {
  message: ChatMessage;
  result: ChatMessage | null;
  progress?: TaskProgress;
  /** 会话已经不在跑了、这一行又没等到结果——那就是这一轮被中断了（进度条也不该再转） */
  stale?: boolean;
  /** 本会话的全部素材（图 + 视频），用来把 assetId 还原成 mimeType 和缩略图 */
  assets?: CanvasAsset[];
  onPreview?: (assetId: string) => void;
  /** 打开应用内诊断弹窗；Tauri webview 会拦掉 window.open，所以不能再走新窗口 */
  onDiagnostics?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tool = message.toolName ?? "reply";
  const Icon = TOOL_ICONS[tool] ?? Sparkles;
  const payload = result?.toolResult ?? null;
  /*
   * 「等结果」和「等一个永远不会来的结果」是两件事。
   *
   * 进程重启会把正在跑的那一轮带走，库里只剩一条没有结果的计划行——继续转圈
   * 会让用户一直等一件不会发生的事（实际反馈就是「任务失败了还在转圈」）。
   * 会话已经不在跑、结果又缺，就按「没跑完」如实显示。
   */
  const orphaned = !result && stale;
  const isPending = !orphaned && (!result || result.status === "pending");
  const failed = (result && result.status === "error") || payload?.ok === false;
  const detail = resultDetail(tool, payload);
  const paramNotes = readParamNotes(payload?.data);
  const args = message.toolArgs ?? {};
  const prompt = typeof args.prompt === "string" ? args.prompt : null;
  // set_canvas 的 assetId 是「切到哪张」，一样值得点开看一眼
  const assetId = result?.assetId ?? null;
  /**
   * 素材表里的 mimeType 才是权威：它是**现在**从库里算出来的，
   * 所以这条改动之前落库的老记录也照样判得对（`toolResult.mimeType` 只写在
   * 之后落库的消息上，光靠它的话，用户截图里那条视频记录还是会被当图片渲染）。
   */
  const produced = assetId ? assets.find((item) => item.asset.id === assetId)?.asset ?? null : null;
  const isVideoResult = produced
    ? produced.mimeType.startsWith("video/")
    // 这一轮刚落的库、还没走过那次全量刷新：退回 ToolResult 里带的那份
    : payload?.mimeType?.startsWith("video/") ?? false;

  /**
   * 胶囊上那一小串参数：优先写提示词，没有提示词就写这次动了哪张画布。
   * 压成单行——胶囊是一行高的东西，多行会把「他说了什么」挤没。
   */
  const pillArg = (prompt
    ?? (typeof args.assetId === "string" ? assetRef(args.assetId) : null)
    ?? result?.content
    ?? "").replace(/\s+/g, " ").trim();

  return (
    <div className="chat-row chat-row-assistant">
      {/* 助手说的那句话单独成一段正文，不再塞进卡片里——Codex 里正文和工具调用是两件事 */}
      {message.content ? <div className="tool-card-say">{message.content}</div> : null}

      <div className={`tool-card ${failed ? "is-error" : ""} ${isPending ? "is-pending" : ""}`}>
        {/*
          一行胶囊：图标 + 工具名 + 参数摘要 + 状态，点一下才展开细节。
          原来那张卡片一上来就把提示词、参数、诊断链接全摊开，一条消息占掉半个屏。
        */}
        <button type="button" className="tool-pill" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="tool-pill-icon"><Icon size={13} /></span>
          <span className="tool-pill-name">{agentToolLabels[tool]}</span>
          {pillArg ? <span className="tool-pill-arg">{pillArg}</span> : null}
          <span className="tool-pill-status">
            {isPending ? (progress ? <ProgressLabel progress={progress} /> : <LoaderCircle size={13} className="spin" />)
              : orphaned ? <AlertCircle size={13} /> : failed ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
          </span>
          <ChevronDown size={13} className={`tool-pill-chevron ${open ? "flip" : ""}`} />
        </button>

        {isPending && progress?.progress != null ? (
          <div className="tool-card-bar"><span style={{ width: `${Math.max(2, Math.min(100, progress.progress))}%` }} /></div>
        ) : null}

        {orphaned ? <div className="tool-card-result">这一轮被中断了，没有拿到结果（你可以直接再说一次）。</div> : null}
        {result?.content && result !== message ? <div className="tool-card-result">{result.content}</div> : null}

        {/* 请求参数核对留在正面（问题 1）：它本来就是「发出去没有」这件事的证据，不该藏进折叠里 */}
        {paramNotes.length ? <ParamChips notes={paramNotes} /> : null}

        {open ? (
          <div className="tool-card-body">
            {prompt ? <div className="tool-card-prompt">{prompt}</div> : null}
            {detail.length ? (
              <dl className="tool-card-detail">
                {detail.map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
                ))}
              </dl>
            ) : null}
            <div className="tool-card-foot">
              {assetId && onPreview ? (
                <button type="button" className="link-btn" onClick={() => onPreview(assetId)}>
                  <ImageIcon size={12} />查看结果
                </button>
              ) : null}
              {result?.taskId ? (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    if (onDiagnostics) onDiagnostics(result.taskId!);
                    else window.open(api.assetUrl(`/api/generations/${result.taskId}/diagnostics`), "_blank");
                  }}
                >
                  诊断
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/*
          结果图放在卡片最底部：先读完「做了什么、参数是什么」，最后才看图。
          缩略图仍然属于这张卡片，所以拖进输入框当参考图的行为不变。
        */}
        {assetId && onPreview ? (
          <button
            type="button"
            className="tool-card-thumb"
            onClick={() => onPreview(assetId)}
            title={isVideoResult ? "点开看" : "点开看（也可以直接拖到下面的输入框）"}
            // 图片能拖进输入框当参考，视频不行——画布只收图片
            {...(isVideoResult ? {} : {
              draggable: true,
              onDragStart: (event: React.DragEvent) => event.dataTransfer.setData(ASSET_DRAG_TYPE, assetId),
            })}
          >
            <ResultThumb assetId={assetId} asset={produced} isVideo={isVideoResult} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 结果缩略图（需求.md 问题 3）。
 *
 * 视频也必须能看：服务端做不出视频缩略图（缩略图走 jimp，对视频直接 404
 * `ASSET_NOT_IMAGE`），所以视频这一支交给客户端的 `<video preload="metadata">` 解码，
 * 而且**绝不能**去请求 `/thumb`——那会拿到一个 404，回退到原图后 `<img>` 也还是裂的。
 */
function ResultThumb({ assetId, asset, isVideo }: { assetId: string; asset: Asset | null; isVideo: boolean }) {
  if (isVideo) {
    const src = asset?.url ?? `/api/assets/${assetId}/file`;
    return <LazyVideoThumb src={api.assetUrl(src)} />;
  }
  return (
    <img
      src={api.assetUrl(asset?.thumbUrl ?? asset?.url ?? `/api/assets/${assetId}/thumb`)}
      alt=""
      loading="lazy"
      onError={(event) => {
        // 缩略图只是省流量，不该成为图裂的原因（和 AssetStrip 一样的回退）
        const image = event.currentTarget;
        if (image.dataset.fallback === "1") return;
        image.dataset.fallback = "1";
        image.src = api.assetUrl(asset?.url ?? `/api/assets/${assetId}/file`);
      }}
    />
  );
}

function ProgressLabel({ progress }: { progress: TaskProgress }) {
  const label = progress.progress == null ? "生成中" : `生成中 ${progress.progress}%`;
  return <span className="tool-card-progress-label"><LoaderCircle size={12} className="spin" />{label}</span>;
}
