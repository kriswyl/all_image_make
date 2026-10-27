/**
 * 会话内分镜表（脚本 → 镜头）。
 *
 * 这一份是服务端落库、前端渲染、大脑回放共用的形状。分镜**不是**生成任务：
 * 一个镜头只有在用户点「生成」之后才有 `taskId`，此前都只是计划。
 * 状态因此是「计划」加上任务本身的终态/中间态，不另造一套状态机。
 */
import type { Asset, TaskStatus } from "./types.js";

export const STORYBOARD_SHOT_KINDS = ["image", "video"] as const;
export type StoryboardShotKind = (typeof STORYBOARD_SHOT_KINDS)[number];

/** 一个会话最多拆多少镜。再多就不像「一篇脚本」，更像误把整本小说传进来了 */
export const MAX_STORYBOARD_SHOTS = 60;
/** 一次「生成选中」最多提交几个。和对话批量生图的上限保持一致，别让中转站当攻击 */
export const MAX_STORYBOARD_BATCH = 8;
/** 单个脚本文档最多收多少字。超过就明确拒绝，而不是悄悄截断后拆出一份缺头少尾的分镜 */
export const MAX_SCRIPT_CHARS = 60_000;
/** 一次上传的脚本文档总字数上限（通常只有一篇，留点余量给「正文 + 设定」两份） */
export const MAX_SCRIPT_TOTAL_CHARS = 90_000;
/** 本地文件大小上限，先挡住明显不是文本的东西 */
export const MAX_SCRIPT_FILE_BYTES = 2 * 1024 * 1024;

/** 分镜里允许的画幅。空串 = 不指定，交给渠道/模型默认 */
export const STORYBOARD_ASPECT_RATIOS = ["", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

/** 景别和运镜是视频提示词的骨架；留空表示没指定，由提示词自由描述 */
export const STORYBOARD_SHOT_SIZES = ["", "大远景", "远景", "全景", "中景", "近景", "特写", "大特写"] as const;
export const STORYBOARD_CAMERA_MOVES = ["", "固定机位", "推镜", "拉镜", "摇镜", "移镜", "跟拍", "升降", "手持", "环绕"] as const;
/** 分镜视频的默认时长；具体范围仍按视频渠道能力收窄 */
export const STORYBOARD_DEFAULT_DURATION = 5;

/** 分镜视频的输入方式；首帧默认用本镜已生成的分镜图 */
export const STORYBOARD_VIDEO_MODES = ["first-frame", "first-last-frame", "reference"] as const;
export type StoryboardVideoMode = (typeof STORYBOARD_VIDEO_MODES)[number];

export type StoryboardShotStatus = "planned" | TaskStatus;

export interface StoryboardShot {
  id: string;
  conversationId: string;
  /** 镜号，从 1 开始。用户在对话里说「第 7 镜」指的就是它 */
  index: number;
  /** 剧本里的原文（模型拆镜时保留，用来核对有没有漏段） */
  sourceText: string;
  /** 真正发给渠道的画面描述 */
  prompt: string;
  /** 这一镜的出场角色名（用于显示的原始串）；空串 = 空镜 / 道具 / 字幕 */
  character: string;
  /** 拆开后的角色名；多人物镜头会有多个 */
  characters: string[];
  /** 这一镜发生在哪个场景；空串 = 没有场景设定 */
  scene: string;
  kind: StoryboardShotKind;
  aspectRatio: string;

  /** 台词 / 旁白。可以写多行，建议「角色：台词」；视频本身不一定出声，配音是单独一步 */
  dialogue: string;
  /** 主说话人；空串 = 旁白或不需要指定音色 */
  speaker: string;
  /** 景别、运镜、音效是给视频提示词的骨架 */
  shotSize: string;
  cameraMove: string;
  soundEffect: string;
  /** 这一镜视频的时长（秒）；生成时按渠道能力再收窄 */
  durationSeconds: number;
  /** 视频专用提示词；空串 = 用画面描述 + 景别/运镜自动拼 */
  videoPrompt: string;
  /** 配音音色；生成配音时使用 */
  voice: string;

  /** 视频输入方式；默认首帧。实际可用模式仍按当前视频模型收窄 */
  videoMode: StoryboardVideoMode;
  /** 视频首帧覆盖；null = 使用本镜已生成的分镜图 */
  firstFrameAssetId: string | null;
  firstFrameAsset: Asset | null;
  /** 首尾帧模式的尾帧 */
  lastFrameAssetId: string | null;
  lastFrameAsset: Asset | null;
  /** 参考生视频的参考图（最多按渠道上限） */
  referenceAssetIds: string[];
  referenceAssets: Asset[];
  /** 尾帧续写出来的镜头指向来源镜头；普通镜头为 null */
  parentShotId: string | null;

  taskId: string | null;
  status: StoryboardShotStatus;
  assetId: string | null;
  /** 分镜图结果；失败或还没生成时为 null */
  asset: Asset | null;
  errorMessage: string | null;

  /** 视频是独立于分镜图的第二步，所以另挂一个任务指针 */
  videoTaskId: string | null;
  videoStatus: StoryboardShotStatus;
  videoAssetId: string | null;
  videoAsset: Asset | null;
  videoErrorMessage: string | null;

  /** 可选配音：台词转成音频资产，和视频分开保存 */
  voiceTaskId: string | null;
  voiceStatus: StoryboardShotStatus;
  voiceAssetId: string | null;
  voiceAsset: Asset | null;
  voiceErrorMessage: string | null;

  createdAt: string;
  updatedAt: string;
}

export type StoryboardReferenceMode = "auto" | "manual" | "off";

/** 角色参考的三种来源；auto 指「第一个已完成的图片镜头」 */
export interface StoryboardReference {
  mode: StoryboardReferenceMode;
  asset: Asset | null;
  /** 这个参考来自第几镜；手动指定或未设置时为 null */
  shotIndex: number | null;
}

/** 设定图（角色 / 场景）的生成状态 */
export type StoryboardSettingStatus = "none" | TaskStatus;

/** 一个角色在分镜里的出场统计和设定图 */
export interface StoryboardCharacter {
  id: string;
  name: string;
  /** 设定图提示词；生成设定图时用 */
  prompt: string;
  /** 角色固定配音音色；空串 = 用镜头 / 默认音色 */
  voice: string;
  /** 用户手动选的图；null = 没手动选 */
  assetId: string | null;
  /** 当前可用的设定图（手动选的，或最近一次生成的结果） */
  asset: Asset | null;
  source: "manual" | "generated" | "none";
  taskId: string | null;
  status: StoryboardSettingStatus;
  /** 用户确认这张设定图可以作为参考 */
  confirmed: boolean;
  shotCount: number;
}

export interface StoryboardScene {
  id: string;
  name: string;
  prompt: string;
  assetId: string | null;
  asset: Asset | null;
  source: "manual" | "generated" | "none";
  taskId: string | null;
  status: StoryboardSettingStatus;
  confirmed: boolean;
  shotCount: number;
}

export interface StoryboardView {
  shots: StoryboardShot[];
  /** 当前渠道里有没有可用的生图 / 生视频模型，前端据此禁用按钮 */
  canGenerateImage: boolean;
  canGenerateVideo: boolean;
  maxBatch: number;
  /** 老分镜（没有角色/场景标签）才用的全局参考 */
  reference: StoryboardReference;
  /** 按角色拆分的设定图；有角色标签时生成逻辑优先用这一份 */
  characters: StoryboardCharacter[];
  /** 场景设定图；有场景标签时按场景带参考 */
  scenes: StoryboardScene[];
  /** 镜头图：由同一份分镜投影出来，画布直接渲染它 */
  graph: StoryboardGraph;
}

/**
 * 镜头图（P2）。
 *
 * 这里**不是**第二份分镜数据：节点和连线每次都从 shots / characters / scenes
 * 现算，镜头改了，图跟着变，不会出现「表里改了、图上还是旧的」。
 * 节点覆盖脚本、角色、场景、镜头和图片 / 视频 / 配音产物；产物节点的坐标可以
 * 单独保存，但节点本身和连线仍由分镜推导出来。
 */
export type StoryboardGraphNodeKind = "script" | "character" | "scene" | "shot" | "image" | "video" | "voice";
export type StoryboardGraphEdgeKind =
  | "script" | "sequence" | "character-reference" | "scene-reference"
  | "render-image" | "render-video" | "render-voice"
  | "first-frame" | "last-frame" | "reference" | "continuation";

export interface StoryboardGraphNode {
  id: string;
  kind: StoryboardGraphNodeKind;
  /** 对应 conversation / character / scene / shot / asset 的 id */
  refId: string;
  /** 镜头节点的镜号；其他节点为 null */
  shotIndex: number | null;
  /** 产物节点属于哪一镜；设定 / 脚本 / 镜头节点为 null */
  sourceShotId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  subtitle: string;
  /** 节点当前展示的主产物；没有生成结果时为 null */
  assetId: string | null;
  /** 图片 / 视频 / 配音节点的产物；画布直接渲染它，不用再反查 */
  asset: Asset | null;
  status: string;
}

export interface StoryboardGraphEdge {
  id: string;
  kind: StoryboardGraphEdgeKind;
  source: string;
  target: string;
}

export interface StoryboardGraph {
  version: 1;
  nodes: StoryboardGraphNode[];
  edges: StoryboardGraphEdge[];
  width: number;
  height: number;
}

/** 画布布局的固定尺寸；服务端和测试共用，避免两边各写一套坐标 */
export const STORYBOARD_GRAPH_LAYOUT = {
  settingWidth: 248,
  settingHeight: 96,
  settingGap: 116,
  settingsTop: 148,
  scriptWidth: 248,
  scriptHeight: 112,
  shotWidth: 284,
  shotHeight: 326,
  shotGap: 36,
} as const;

const GRAPH_LEFT = 0;
const GRAPH_SHOT_LEFT = 340;
const GRAPH_PADDING = 40;

/** 产物节点在镜头下方的固定偏移；画布按这组常量判断「节点跟着哪一镜走」 */
export const STORYBOARD_ARTIFACT_LAYOUT = {
  left: 20,
  imageY: 360,
  imageWidth: 244,
  imageHeight: 150,
  videoY: 540,
  videoWidth: 244,
  videoHeight: 150,
  voiceY: 720,
  voiceWidth: 244,
  voiceHeight: 96,
  externalGap: 132,
} as const;

/**
 * 把分镜投影成镜头图。
 *
 * 横向是叙事顺序：脚本 → 第 1 镜 → 第 2 镜 …；左侧是角色 / 场景设定卡；
 * 每镜下方按需生成图片 / 视频 / 配音产物节点。所有节点和连线都从分镜现算，
 * 画布只保存用户拖动后的坐标，不维护第二份分镜数据。
 */
export function buildStoryboardGraph(input: {
  conversationId: string;
  shots: StoryboardShot[];
  characters: StoryboardCharacter[];
  scenes: StoryboardScene[];
  /** 用户拖动后保存的位置；没有记录的节点继续用自动布局 */
  positions?: Record<string, { x: number; y: number }>;
}): StoryboardGraph {
  const { conversationId, shots, characters, scenes, positions } = input;
  const layout = STORYBOARD_GRAPH_LAYOUT;
  const artifact = STORYBOARD_ARTIFACT_LAYOUT;
  const nodes: StoryboardGraphNode[] = [];
  const edges: StoryboardGraphEdge[] = [];

  const scriptId = `script:${conversationId}`;
  nodes.push({
    id: scriptId,
    kind: "script",
    refId: conversationId,
    shotIndex: null,
    sourceShotId: null,
    x: GRAPH_LEFT,
    y: 0,
    width: layout.scriptWidth,
    height: layout.scriptHeight,
    title: "分镜脚本",
    subtitle: `${shots.length} 镜 · ${characters.length} 角色 · ${scenes.length} 场景`,
    assetId: null,
    asset: null,
    status: shots.length ? "ready" : "empty",
  });

  let settingY = layout.settingsTop;
  const characterNodeIds = new Map<string, string>();
  for (const character of characters) {
    const id = `character:${character.id}`;
    characterNodeIds.set(character.name, id);
    nodes.push({
      id,
      kind: "character",
      refId: character.id,
      shotIndex: null,
      sourceShotId: null,
      x: GRAPH_LEFT,
      y: settingY,
      width: layout.settingWidth,
      height: layout.settingHeight,
      title: character.name,
      subtitle: `${character.shotCount} 镜${character.voice ? ` · ${character.voice}` : ""}`,
      assetId: character.assetId,
      asset: character.asset,
      status: character.status,
    });
    settingY += layout.settingGap;
  }

  // 角色和场景之间留一段空白，让两类设定在画布上分得开
  if (characters.length && scenes.length) settingY += 28;
  const sceneNodeIds = new Map<string, string>();
  for (const scene of scenes) {
    const id = `scene:${scene.id}`;
    sceneNodeIds.set(scene.name, id);
    nodes.push({
      id,
      kind: "scene",
      refId: scene.id,
      shotIndex: null,
      sourceShotId: null,
      x: GRAPH_LEFT,
      y: settingY,
      width: layout.settingWidth,
      height: layout.settingHeight,
      title: scene.name,
      subtitle: `${scene.shotCount} 镜`,
      assetId: scene.assetId,
      asset: scene.asset,
      status: scene.status,
    });
    settingY += layout.settingGap;
  }

  const shotNodeIds = new Map<string, string>();
  const shotNodeById = new Map<string, StoryboardGraphNode>();
  shots.forEach((shot, position) => {
    const id = `shot:${shot.id}`;
    shotNodeIds.set(shot.id, id);
    const context = [shot.character, shot.scene].filter(Boolean).join(" · ");
    const node: StoryboardGraphNode = {
      id,
      kind: "shot",
      refId: shot.id,
      shotIndex: shot.index,
      sourceShotId: null,
      x: GRAPH_SHOT_LEFT + position * (layout.shotWidth + layout.shotGap),
      y: 0,
      width: layout.shotWidth,
      height: layout.shotHeight,
      title: `第 ${shot.index} 镜`,
      subtitle: shot.parentShotId ? `续写 · ${context || "空镜"}` : context || "空镜",
      assetId: shot.assetId,
      asset: shot.asset,
      status: shot.status,
    };
    nodes.push(node);
    shotNodeById.set(shot.id, node);
  });

  // ── 产物节点 ───────────────────────────────────────────────────────────
  // 同一张图可能同时是 A 镜的分镜图和 B 镜的参考图，按 asset id 只建一个节点。
  const imageNodeIds = new Map<string, string>();
  const videoNodeIds = new Map<string, string>();
  const voiceNodeIds = new Map<string, string>();
  let externalY = settingY + 24;
  let externalIndex = 0;

  const ensureImageNode = (
    assetValue: Asset | null,
    sourceShot: StoryboardShot | null,
    title: string,
    subtitle: string,
    placed?: { x: number; y: number },
  ): string | null => {
    if (!assetValue) return null;
    const existing = imageNodeIds.get(assetValue.id);
    if (existing) return existing;
    const id = `image:${assetValue.id}`;
    imageNodeIds.set(assetValue.id, id);
    const external = !placed;
    const x = placed?.x ?? GRAPH_LEFT;
    const y = placed?.y ?? externalY;
    nodes.push({
      id,
      kind: "image",
      refId: assetValue.id,
      shotIndex: sourceShot?.index ?? null,
      sourceShotId: sourceShot?.id ?? null,
      x,
      y,
      width: external ? layout.settingWidth : artifact.imageWidth,
      height: external ? 120 : artifact.imageHeight,
      title,
      subtitle,
      assetId: assetValue.id,
      asset: assetValue,
      status: "succeeded",
    });
    if (external) {
      externalY += artifact.externalGap;
      externalIndex += 1;
    }
    return id;
  };

  for (const shot of shots) {
    const shotNode = shotNodeById.get(shot.id);
    if (!shotNode) continue;
    const shotImageNode = ensureImageNode(
      shot.asset,
      shot,
      `分镜图 · 第 ${shot.index} 镜`,
      `${shot.prompt.replace(/\s+/g, " ").slice(0, 26) || "图片"}`,
      { x: shotNode.x + artifact.left, y: artifact.imageY },
    );
    if (shotImageNode) {
      edges.push({ id: `edge:render-image:${shot.id}`, kind: "render-image", source: shotNode.id, target: shotImageNode });
    }

    if (shot.videoAsset) {
      const videoId = `video:${shot.id}`;
      videoNodeIds.set(shot.id, videoId);
      nodes.push({
        id: videoId,
        kind: "video",
        refId: shot.videoAsset.id,
        shotIndex: shot.index,
        sourceShotId: shot.id,
        x: shotNode.x + artifact.left,
        y: artifact.videoY,
        width: artifact.videoWidth,
        height: artifact.videoHeight,
        title: `视频 · 第 ${shot.index} 镜`,
        subtitle: shot.videoAsset.duration ? `${shot.videoAsset.duration.toFixed(1)} 秒` : shot.videoAsset.fileName,
        assetId: shot.videoAsset.id,
        asset: shot.videoAsset,
        status: "succeeded",
      });
      edges.push({ id: `edge:render-video:${shot.id}`, kind: "render-video", source: shotNode.id, target: videoId });
    }

    if (shot.voiceAsset) {
      const voiceId = `voice:${shot.id}`;
      voiceNodeIds.set(shot.id, voiceId);
      nodes.push({
        id: voiceId,
        kind: "voice",
        refId: shot.voiceAsset.id,
        shotIndex: shot.index,
        sourceShotId: shot.id,
        x: shotNode.x + artifact.left,
        y: artifact.voiceY,
        width: artifact.voiceWidth,
        height: artifact.voiceHeight,
        title: `配音 · 第 ${shot.index} 镜`,
        subtitle: shot.voiceAsset.duration ? `${shot.voiceAsset.duration.toFixed(1)} 秒` : shot.voiceAsset.fileName,
        assetId: shot.voiceAsset.id,
        asset: shot.voiceAsset,
        status: "succeeded",
      });
      edges.push({ id: `edge:render-voice:${shot.id}`, kind: "render-voice", source: shotNode.id, target: voiceId });
    }

    // 首帧 / 尾帧 / 参考图如果不是这一镜的分镜图，会在左侧素材列补一个节点
    ensureImageNode(shot.firstFrameAsset, null, `首帧图 · 第 ${shot.index} 镜`, "视频输入");
    ensureImageNode(shot.lastFrameAsset, null, `尾帧图 · 第 ${shot.index} 镜`, "视频输入");
    shot.referenceAssets.forEach((assetValue, index) => {
      ensureImageNode(assetValue, null, `参考图 ${index + 1} · 第 ${shot.index} 镜`, "视频输入");
    });
  }

  // ── 连线 ───────────────────────────────────────────────────────────────
  if (shots.length) {
    const firstShot = shotNodeIds.get(shots[0]!.id);
    if (firstShot) edges.push({ id: `edge:script:${shots[0]!.id}`, kind: "script", source: scriptId, target: firstShot });
    for (let index = 1; index < shots.length; index += 1) {
      const source = shotNodeIds.get(shots[index - 1]!.id);
      const target = shotNodeIds.get(shots[index]!.id);
      if (source && target) {
        edges.push({ id: `edge:sequence:${shots[index - 1]!.id}:${shots[index]!.id}`, kind: "sequence", source, target });
      }
    }
  }

  const inputEdgeIds = new Set<string>();
  const addInputEdge = (
    kind: "first-frame" | "last-frame" | "reference",
    assetValue: Asset | null,
    shotId: string,
  ) => {
    if (!assetValue) return;
    const source = imageNodeIds.get(assetValue.id);
    const target = videoNodeIds.get(shotId) ?? shotNodeIds.get(shotId);
    if (!source || !target) return;
    const id = `edge:${kind}:${assetValue.id}:${shotId}`;
    if (inputEdgeIds.has(id)) return;
    inputEdgeIds.add(id);
    edges.push({ id, kind, source, target });
  };

  for (const shot of shots) {
    const target = shotNodeIds.get(shot.id);
    if (!target) continue;
    const first = shot.firstFrameAsset ?? shot.asset;
    if (shot.videoMode === "first-last-frame") {
      addInputEdge("first-frame", first, shot.id);
      addInputEdge("last-frame", shot.lastFrameAsset, shot.id);
    } else if (shot.videoMode === "reference") {
      const references = shot.referenceAssets.length ? shot.referenceAssets : [first];
      for (const assetValue of references) addInputEdge("reference", assetValue, shot.id);
    } else {
      addInputEdge("first-frame", first, shot.id);
    }

    for (const name of shot.characters) {
      const source = characterNodeIds.get(name);
      if (source) {
        edges.push({ id: `edge:character:${source}:${target}`, kind: "character-reference", source, target });
      }
    }
    const sceneSource = sceneNodeIds.get(shot.scene);
    if (sceneSource) {
      edges.push({ id: `edge:scene:${sceneSource}:${target}`, kind: "scene-reference", source: sceneSource, target });
    }

    // 续写镜头从父镜头的视频节点（没有视频时退回父镜头节点）接过来
    if (shot.parentShotId) {
      const parentSource = videoNodeIds.get(shot.parentShotId) ?? shotNodeIds.get(shot.parentShotId);
      if (parentSource) {
        edges.push({
          id: `edge:continuation:${shot.parentShotId}:${shot.id}`,
          kind: "continuation",
          source: parentSource,
          target,
        });
      }
    }
  }

  if (positions) {
    for (const node of nodes) {
      const saved = positions[node.id];
      if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) continue;
      node.x = saved.x;
      node.y = saved.y;
    }
  }

  // 拖动后节点可能超出自动布局的范围，画布世界层跟着节点最大值扩，避免被裁掉
  const right = nodes.reduce<number>((max, node) => Math.max(max, node.x + node.width), layout.settingWidth);
  const bottom = nodes.reduce<number>((max, node) => Math.max(max, node.y + node.height), layout.shotHeight);
  return {
    version: 1,
    nodes,
    edges,
    width: Math.max(right, GRAPH_SHOT_LEFT + layout.shotWidth) + GRAPH_PADDING * 2,
    height: Math.max(bottom, settingY + externalIndex * artifact.externalGap) + GRAPH_PADDING * 2,
  };
}

/**
 * 带参考图时加在画面描述前面的约束。
 *
 * 参考图本身只能告诉模型「长什么样」，不会告诉它「哪些地方必须保持不变」——
 * 不写这句，模型经常只借一点配色，脸和服装还是各画各的。
 */
export const STORYBOARD_CHARACTER_PREFIX =
  "以参考图中的同一位人物为准，严格保持脸型、五官、发型、肤色、体型、服装和整体画风完全一致，只改变场景、姿态与构图：\n";

/**
 * 这一镜大概会出现人物吗？
 *
 * 角色参考只该用在有人物的镜头上：把一张人脸塞进「空无一人的走廊」或
 * 「片尾黑底字幕」，模型会硬生生多画一个人出来。关键词只是粗筛——
 * 它决定「要不要带参考图」，不决定用户能不能手动指定。
 */
export const STORYBOARD_PERSON_HINT =
  /人物|男人|女人|男孩|女孩|少年|少女|男子|女子|男性|女性|老人|孩子|主角|角色|助手|(?<!其)他|她|脸|面部|五官|近景|特写|半身|全身|肖像|背影|侧影|剪影/;

export function shotNeedsCharacterReference(shot: Pick<StoryboardShot, "prompt" | "sourceText">): boolean {
  return STORYBOARD_PERSON_HINT.test(`${shot.prompt}\n${shot.sourceText}`);
}

/**
 * 「林小满、老陈」这类多人物标签拆成独立角色。
 *
 * 只按明确的分隔符拆，不猜名字：模型经常把一镜里的两个人写在一起，
 * 不拆开的话每个组合都会变成一个新「角色」，谁都没有参考图。
 */
export function parseCharacterNames(value: string): string[] {
  return [...new Set(
    value.split(/[、,，/／+&]/).map((name) => name.trim()).filter(Boolean),
  )];
}

/** 把独立角色名合成展示串，顺序不变 */
export function joinCharacterNames(names: string[]): string {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].join("、");
}

export function storyboardKindLabel(kind: StoryboardShotKind): string {
  return kind === "video" ? "视频" : "图片";
}

export interface StoryboardDialogueLine {
  /** 说话人；空串 = 旁白 / 未标注 */
  speaker: string;
  text: string;
}

/**
 * 一镜的台词可以有多个人。
 *
 * 约定每行一句，写成「角色：台词」；没写角色名的行用 `fallbackSpeaker`，
 * 仍为空就按旁白处理。配音时最多取两个说话人（Gemini TTS 的双人上限），
 * 更多人的一镜需要拆镜或分多条音轨。
 */
export function parseStoryboardDialogue(dialogue: string, fallbackSpeaker = ""): StoryboardDialogueLine[] {
  return dialogue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
      if (match) return { speaker: match[1]!.trim(), text: match[2]!.trim() };
      return { speaker: fallbackSpeaker.trim(), text: line };
    });
}

/** 缺什么就不能生成；返回 null 表示这一镜可以提交 */
export function storyboardShotMissing(shot: Pick<StoryboardShot, "prompt">): string | null {
  const prompt = shot.prompt.trim();
  if (!prompt) return "缺首帧画面";
  if (prompt.length < 6) return "首帧画面描述太短";
  return null;
}

/**
 * 当前视频模型实际能执行的输入方式。
 *
 * 存储里保留用户选的首尾帧 / 参考图；换成一个不支持该模式的模型时，
 * 不偷偷改数据库，只在提交时回落到模型能跑的模式，并把缺的图说清楚。
 */
export function resolveStoryboardVideoMode(
  shot: Pick<StoryboardShot,
    "videoMode" | "asset" | "firstFrameAsset" | "lastFrameAsset" | "referenceAssets">,
  supportedModes: readonly string[],
): StoryboardVideoMode {
  const first = shot.firstFrameAsset ?? shot.asset;
  const wanted = shot.videoMode;
  if (wanted === "first-last-frame" && supportedModes.includes(wanted) && first && shot.lastFrameAsset) {
    return "first-last-frame";
  }
  if (wanted === "reference" && supportedModes.includes(wanted) && (shot.referenceAssets.length > 0 || first)) {
    return "reference";
  }
  if (supportedModes.includes("first-frame") && first) return "first-frame";
  if (supportedModes.includes("reference") && (shot.referenceAssets.length > 0 || first)) return "reference";
  if (supportedModes.includes("first-last-frame") && first && shot.lastFrameAsset) return "first-last-frame";
  // 只剩参考模式（例如 Grok）：即使还没有图，也按参考模式报缺图，别来回落到不支持的首帧
  if (supportedModes.includes("reference") && !supportedModes.includes("first-frame")) return "reference";
  return "first-frame";
}

/** 提交前缺什么；null 表示这一镜的视频输入够用 */
export function storyboardVideoInputMissing(
  shot: Pick<StoryboardShot,
    "videoMode" | "asset" | "firstFrameAsset" | "lastFrameAsset" | "referenceAssets">,
  supportedModes: readonly string[],
): string | null {
  const first = shot.firstFrameAsset ?? shot.asset;
  // 用户明确选了某个模式、当前模型也支持时，缺图就是缺图，不悄悄退回另一个模式
  if (shot.videoMode === "first-frame" && supportedModes.includes("first-frame") && !first) {
    return "首帧模式缺首帧图";
  }
  if (shot.videoMode === "first-last-frame" && supportedModes.includes("first-last-frame")
    && (!first || !shot.lastFrameAsset)) {
    return "首尾帧模式缺首帧或尾帧图";
  }
  if (shot.videoMode === "reference" && supportedModes.includes("reference")
    && !first && !shot.referenceAssets.length) {
    return "参考生视频至少需要一张参考图";
  }
  const mode = resolveStoryboardVideoMode(shot, supportedModes);
  if (mode === "first-frame" && !first) return "首帧模式缺首帧图";
  if (mode === "first-last-frame" && (!first || !shot.lastFrameAsset)) return "首尾帧模式缺首帧或尾帧图";
  if (mode === "reference" && !first && !shot.referenceAssets.length) return "参考生视频至少需要一张参考图";
  return null;
}

export function normalizeStoryboardAspect(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return (STORYBOARD_ASPECT_RATIOS as readonly string[]).includes(trimmed) ? trimmed : "";
}

export function isStoryboardShotKind(value: unknown): value is StoryboardShotKind {
  return value === "image" || value === "video";
}

/** 任务还没结束：前端据此决定要不要继续轮询 */
export function isStoryboardShotActive(status: StoryboardShotStatus): boolean {
  return status === "queued" || status === "validating" || status === "submitting" || status === "running";
}
