import type { MentionUpload } from "./VideoMentionPanel";

/**
 * 「参考内容」能加什么。
 *
 * 视频和音频的上限不是一个口径：Seedance 2.0 能放 3 段视频 + 3 段音频，2.5 放到
 * 10 + 10；万相、可灵的参考视频接口只收一段。以前按「各 1 段」写死，传过一次入口
 * 就消失，用户只能看到「只能上传一次」。
 *
 * - 只有一个额度时，再选就是**替换**（不用先删旧的）；
 * - 多段额度加满了，入口写明已满、要求先移除一段，而不是静默消失。
 */
export interface AssetOption extends MentionUpload {
  /** 再选一次会替换已有的那一段（只有单额度渠道才成立） */
  replace: boolean;
}

export interface AssetOptionInput {
  /** 当前模式参考图上限，0 表示不收图 */
  maxImages: number;
  /** 已经放了几张图 */
  filled: number;
  /** 参考视频 / 音频上限（按渠道 + 模型算），0 表示不收 */
  maxVideos: number;
  maxAudios: number;
  /** 已经放了几段 */
  videoCount: number;
  audioCount: number;
  /** 渠道配了上传服务，视频才传得上去 */
  canUploadVideo: boolean;
  /** 提交中 / 读取中 / 没选渠道：整排入口都不该可点 */
  disabled: boolean;
}

export function assetOptions(input: AssetOptionInput): AssetOption[] {
  const options: AssetOption[] = [];

  if (input.maxImages > 0 && input.filled < input.maxImages) {
    options.push({
      kind: "图片",
      disabled: input.disabled,
      hint: `支持 PNG / JPEG / WebP，还能加 ${input.maxImages - input.filled} 张`,
      replace: false,
    });
  }

  if (input.maxVideos > 0) {
    const single = input.maxVideos === 1;
    const full = input.videoCount >= input.maxVideos;
    options.push({
      kind: "视频",
      disabled: input.disabled || !input.canUploadVideo || (full && !single),
      hint: !input.canUploadVideo
        ? "该渠道未配置上传服务，暂时无法上传参考视频"
        : single
          ? full ? "只有 1 段额度，再选会替换" : "MP4 / MOV，≤100 MB"
          : full
            ? `已放满 ${input.maxVideos} 段，先移除一段再换`
            : `MP4 / MOV，≤100 MB；还能加 ${input.maxVideos - input.videoCount} 段`,
      replace: full && single,
    });
  }

  if (input.maxAudios > 0) {
    const single = input.maxAudios === 1;
    const full = input.audioCount >= input.maxAudios;
    options.push({
      kind: "音频",
      disabled: input.disabled || (full && !single),
      hint: single
        ? full ? "只有 1 段额度，再选会替换" : "MP3 / M4A / AAC / WAV，≤15 MB"
        : full
          ? `已放满 ${input.maxAudios} 段，先移除一段再换`
          : `MP3 / M4A / AAC / WAV；还能加 ${input.maxAudios - input.audioCount} 段`,
      replace: full && single,
    });
  }

  return options;
}

/**
 * 「参考内容」那一格能加什么。
 *
 * 首尾帧有自己的两个槽位，再摆一个「参考内容」就是两套入口，所以图片只在可追加
 * 的模式（参考图）里出现；必需参考视频的模式（视频编辑 / 延长）自带视频槽位，
 * 这里也不重复列视频。
 */
export function addableOptions(options: AssetOption[], config: { repeatableImages: boolean; videoSlotRequired: boolean }): AssetOption[] {
  return options.filter((item) => {
    if (item.kind === "图片" && !config.repeatableImages) return false;
    if (item.kind === "视频" && config.videoSlotRequired) return false;
    return true;
  });
}
