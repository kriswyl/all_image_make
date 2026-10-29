import { BOARD_LIMITS, directInputLinks, type BoardDoc, type BoardEdgeRole, type BoardVideoMode, type ConfigBoardNode, type ImageBoardNode } from "../shared/board.js";
import { supportedVideoModes, VIDEO_CAPABILITIES, videoModeLabel, type ConversationVideoMode, type VideoAdapter } from "../shared/video-capabilities.js";
import type { ConversationVideoRole } from "../shared/agent-types.js";

interface BoardVideoInput {
  node: ImageBoardNode;
  assetId: string;
  role: ConversationVideoRole;
}

interface BoardVideoSelection {
  mode: ConversationVideoMode;
  inputs: BoardVideoInput[];
}

type BoardEdgeVideoRole = ConversationVideoRole | "auto";

/** 没有 role 的连线是「自动」；显式选了参考图才按参考图算 */
function edgeVideoRole(role: BoardEdgeRole | undefined): BoardEdgeVideoRole {
  if (role === "first-frame") return "first_frame";
  if (role === "last-frame") return "last_frame";
  if (role === "reference") return "reference_image";
  return "auto";
}

/**
 * 把配置节点的上游连线解析成「哪种视频模式 + 每张图的角色」。
 *
 * 角色优先看连线（用户 / Agent 在检查器里设的 first-frame / last-frame），
 * 没有角色时才按模式与图片数量推断。任何模糊组合都直接报错，不悄悄丢图。
 */
export function resolveBoardVideoSelection(input: {
  doc: BoardDoc;
  config: Pick<ConfigBoardNode, "id" | "videoMode">;
  adapterType: string;
  model?: string;
  modeOverride?: BoardVideoMode;
}): { selection?: BoardVideoSelection; error?: string } {
  const links = directInputLinks(input.doc, input.config.id);
  const videoSources = links.filter((link) => link.node.type === "video");
  if (videoSources.length) {
    return { error: "无限画布视频生成暂时只接图片输入，不支持把视频节点当素材" };
  }
  const images = links.filter(
    (link): link is { edge: typeof link.edge; node: ImageBoardNode } =>
      link.node.type === "image" && Boolean(link.node.assetId),
  );
  const withRole = images.map((link) => ({
    node: link.node,
    assetId: link.node.assetId!,
    role: edgeVideoRole(link.edge.role),
  }));

  const adapter = input.adapterType as VideoAdapter;
  const capability = VIDEO_CAPABILITIES[adapter];
  if (!capability) return { error: "当前模型不是视频模型，请换一个视频渠道" };
  const supported = supportedVideoModes(input.adapterType, input.model);
  const cap = Math.min(BOARD_LIMITS.maxUpstreamImages, capability.maxReferenceImages);

  const firsts = withRole.filter((item) => item.role === "first_frame");
  const lasts = withRole.filter((item) => item.role === "last_frame");
  const explicitRefs = withRole.filter((item) => item.role === "reference_image");
  const autoRoles = withRole.filter((item) => item.role === "auto");
  const requested = input.modeOverride ?? input.config.videoMode;
  let mode: ConversationVideoMode | undefined = requested;

  if (!mode) {
    if (!withRole.length) {
      mode = "text-to-video";
    } else if (lasts.length && !firsts.length) {
      return { error: "有尾帧但没有首帧：把其中一张连线的角色改成首帧，或改用参考图模式" };
    } else if (firsts.length > 1 || lasts.length > 1) {
      return { error: "首帧和尾帧各只能有一张，请检查连线的角色" };
    } else if (firsts.length === 1 && lasts.length === 1) {
      if (withRole.length !== 2) return { error: "首尾帧模式正好需要两张图，其它连线请改成参考图或断开" };
      mode = "first-last-frame";
    } else if (firsts.length === 1) {
      if (withRole.length !== 1) return { error: "首帧模式只接受一张图；其它图片请断开，或把角色改成参考图并选择参考生视频" };
      mode = "first-frame";
    } else if (explicitRefs.length) {
      mode = "reference";
    } else if (autoRoles.length === 1) {
      // 单张图不指定方式时，按惯例当作首帧；多张交给参考生视频
      mode = "first-frame";
    } else {
      mode = "reference";
    }
  }

  if (!supported.includes(mode)) {
    return { error: `这个视频模型不支持${videoModeLabel(mode, input.adapterType)}。它支持：${supported.map((item) => videoModeLabel(item, input.adapterType)).join("、")}` };
  }

  if (mode === "text-to-video") {
    if (withRole.length) {
      return { error: "文生视频不会带图：请断开图片连线，或在检查器里换成首帧 / 首尾帧 / 参考图模式" };
    }
    return { selection: { mode, inputs: [] } };
  }
  if (mode === "first-frame") {
    if (withRole.length !== 1) return { error: `首帧生视频只接受 1 张图（现在连了 ${withRole.length} 张）` };
    return { selection: { mode, inputs: [{ ...withRole[0]!, role: "first_frame" }] } };
  }
  if (mode === "first-last-frame") {
    if (withRole.length !== 2) return { error: `首尾帧生视频必须正好 2 张图（现在连了 ${withRole.length} 张）` };
    const first = firsts[0] ?? withRole[0]!;
    const last = lasts[0] ?? withRole.find((item) => item.node.id !== first.node.id);
    if (!last || first.node.id === last.node.id) return { error: "首尾帧需要两张不同的图" };
    return {
      selection: {
        mode,
        inputs: [
          { ...first, role: "first_frame" },
          { ...last, role: "last_frame" },
        ],
      },
    };
  }

  if (!withRole.length) return { error: "参考生视频至少需要 1 张参考图" };
  if (withRole.length > cap) return { error: `这个视频模型最多用 ${cap} 张参考图（现在连了 ${withRole.length} 张）` };
  return {
    selection: {
      mode: "reference",
      inputs: withRole.map((item) => ({ ...item, role: "reference_image" })),
    },
  };
}
