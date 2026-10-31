/**
 * 导出剪映草稿（6.x）。
 *
 * 只负责「镜头序列 → draft_content.json / draft_meta_info.json」这一层：
 * 素材文件由调用方复制进草稿目录，这里只写绝对路径。
 *
 * 剪映的草稿格式没有公开文档，下面的结构参照社区通行写法（pyJianYingDraft 一类工具）：
 * materials 里每种素材都要有对应条目，segment 通过 extra_material_refs 引用
 * speed / canvas / sound_channel_mapping，缺一条剪映就会判定草稿损坏。
 * 不同小版本之间仍可能有字段差异，出问题先看 draft_content.json 里缺了哪类 material。
 */
import crypto from "node:crypto";

const US = 1_000_000;

function uid() {
  return crypto.randomUUID().toUpperCase();
}

export interface DraftClip {
  /** 落在草稿目录里的绝对路径 */
  path: string;
  /** 素材名，剪映里显示的就是它 */
  name: string;
  /** 素材本身的时长（微秒）。图片没有时长，传 0，由这里补一个足够长的值 */
  durationUs: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export interface DraftShot {
  /** 画面：视频或图片。没有画面的镜头会被跳过 */
  clip?: DraftClip;
  clipKind?: "video" | "photo";
  /** 配音 / 音效，可选 */
  audio?: DraftClip;
  /** 这一镜在时间线上占多长（微秒） */
  durationUs: number;
}

export interface DraftInput {
  name: string;
  width: number;
  height: number;
  fps?: number;
  shots: DraftShot[];
}

function speedMaterial() {
  return {
    id: uid(), type: "speed", mode: 0, speed: 1.0, curve_speed: null,
  };
}

function canvasMaterial(width: number, height: number) {
  return {
    id: uid(), type: "canvas_color", color: "", album_image: "", blur: 0.0, image: "",
    image_id: "", image_name: "", source_platform: 0, team_id: "",
  };
}

function soundMapping() {
  return { id: uid(), type: "sound_channel_mapping", audio_channel_mapping: 0, is_config_open: false };
}

function videoMaterial(clip: DraftClip, kind: "video" | "photo") {
  return {
    id: uid(),
    type: kind === "photo" ? "photo" : "video",
    path: clip.path,
    material_name: clip.name,
    duration: kind === "photo" ? 10_800_000_000 : Math.max(clip.durationUs, 1),
    width: clip.width ?? 1920,
    height: clip.height ?? 1080,
    crop_scale: 1.0,
    crop_position_x: 0.0,
    crop_position_y: 0.0,
    crop_rotation: 0.0,
    crop_flip: { horizontal: false, vertical: false },
    has_audio: kind === "video" ? clip.hasAudio ?? true : false,
    has_sound_separated: false,
    is_ai_generate_content: false,
    is_unified_beauty_mode: false,
    category_id: "",
    category_name: "local",
    check_flag: 63487,
    local_id: "",
    local_material_id: "",
    material_id: "",
    media_path: "",
    object_locked: null,
    origin_material_id: "",
    picture_from: "none",
    picture_set_category_id: "",
    picture_set_category_name: "",
    request_id: "",
    reverse_intensify_path: "",
    smart_motion: null,
    source: 0,
    source_platform: 0,
    stable: { matrix_path: "", stable_level: 0, time_range: { duration: 0, start: 0 } },
    team_id: "",
    video_algorithm: {
      algorithms: [], complement_frame_config: null, deflicker: null, gameplay_configs: [],
      motion_blur_config: null, noise_reduction: null, path: "", quality_enhance: null,
      smart_composition: null, super_resolution: null, time_range: null,
    },
    matting: {
      flag: 0, has_use_quick_brush: false, has_use_quick_eraser: false,
      interactiveTime: [], path: "", strokes: [],
    },
    beauty_body_auto_presets: [], beauty_face_auto_presets: [], beauty_face_auto_presets_v2: [],
    beauty_face_presets: [], beauty_face_presets_v2: [], beauty_face_recommend: null,
  };
}

function audioMaterial(clip: DraftClip) {
  return {
    id: uid(), type: "extract_music", path: clip.path, name: clip.name,
    duration: Math.max(clip.durationUs, 1), source_platform: 0, team_id: "",
    music_id: "", tropical_dream_effects: false, app_id: 0,
    category_id: "", category_name: "local", check_flag: 1, effect_id: "",
    formula_id: "", intensifies_path: "", is_ai_clone_tone: false, is_ugc: false,
    local_material_id: "", material_id: "", media_path: "", origin_material_id: "",
    request_id: "", resource_id: "", reverse_path: "", source: 0,
    wave_points: [], video_path: "",
  };
}

function segment(
  materialId: string,
  start: number,
  duration: number,
  refs: string[],
  renderIndex: number,
  opts: { speedId: string; canvasId: string; mappingId: string },
) {
  return {
    id: uid(),
    material_id: materialId,
    target_timerange: { start, duration },
    source_timerange: { start: 0, duration },
    speed: 1.0,
    volume: 1.0,
    extra_material_refs: [opts.speedId, opts.canvasId, opts.mappingId, ...refs],
    is_placeholder: false,
    render_index: renderIndex,
    track_render_index: 0,
    visible: true,
    clip: {
      alpha: 1.0,
      flip: { horizontal: false, vertical: false },
      rotation: 0.0,
      scale: { x: 1.0, y: 1.0 },
      transform: { x: 0.0, y: 0.0 },
    },
    hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
    responsive_layout: {
      enable: false, horizontal_pos_layout: 0, size_layout: 0,
      target_follow: "", vertical_pos_layout: 0,
    },
    uniform_scale: { on: true, value: 1.0 },
    reverse: false,
    intensifies_audio: false,
    cartoon: false,
    caption_info: null,
    combined_ids: [],
    template_id: "",
    template_scene: "default",
    color_correct_alg_result: "",
    enable_color_correct_adjust: false,
    enable_color_match_adjust: false,
    enable_color_wheels: false,
    enable_lut: false,
    enable_smart_color_adjust: false,
    group_id: "",
    last_nonzero_volume: 1.0,
    lyrics_caption_info: null,
    raw_segment_id: "",
    source: "segmentsource_upload",
    track_attribute: 0,
  };
}

function platformInfo() {
  return {
    app_id: 3704, app_source: "lv", app_version: "6.0.0", device_id: "",
    hard_disk_id: "", mac_address: "", os: "windows", os_version: "10.0",
  };
}

export function buildDraftContent(input: DraftInput): { content: Record<string, unknown>; durationUs: number } {
  const videos: ReturnType<typeof videoMaterial>[] = [];
  const audios: ReturnType<typeof audioMaterial>[] = [];
  const speeds: ReturnType<typeof speedMaterial>[] = [];
  const canvases: ReturnType<typeof canvasMaterial>[] = [];
  const mappings: ReturnType<typeof soundMapping>[] = [];

  const videoSegments: Array<Record<string, unknown>> = [];
  const audioSegments: Array<Record<string, unknown>> = [];

  let cursor = 0;
  let renderIndex = 0;
  for (const shot of input.shots) {
    const duration = Math.max(1, Math.round(shot.durationUs));
    if (shot.clip) {
      const kind = shot.clipKind ?? "video";
      const material = videoMaterial(shot.clip, kind);
      const speed = speedMaterial();
      const canvas = canvasMaterial(input.width, input.height);
      const mapping = soundMapping();
      videos.push(material);
      speeds.push(speed);
      canvases.push(canvas);
      mappings.push(mapping);
      videoSegments.push(segment(material.id, cursor, duration, [], renderIndex, {
        speedId: speed.id, canvasId: canvas.id, mappingId: mapping.id,
      }));
      renderIndex += 1;
    }
    if (shot.audio) {
      const material = audioMaterial(shot.audio);
      const speed = speedMaterial();
      const canvas = canvasMaterial(input.width, input.height);
      const mapping = soundMapping();
      audios.push(material);
      speeds.push(speed);
      canvases.push(canvas);
      mappings.push(mapping);
      audioSegments.push(segment(material.id, cursor, Math.min(duration, Math.max(1, shot.audio.durationUs)), [], 0, {
        speedId: speed.id, canvasId: canvas.id, mappingId: mapping.id,
      }));
    }
    cursor += duration;
  }

  const tracks: Array<Record<string, unknown>> = [];
  if (videoSegments.length) tracks.push({ id: uid(), type: "video", attribute: 0, flag: 0, is_default_name: true, name: "", segments: videoSegments });
  if (audioSegments.length) tracks.push({ id: uid(), type: "audio", attribute: 0, flag: 0, is_default_name: true, name: "", segments: audioSegments });

  const content = {
    canvas_config: { height: input.height, ratio: "original", width: input.width },
    color_space: 0,
    config: {
      adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null,
      extract_audio_last_index: 1, lyrics_recognition_id: "", lyrics_sync: true, lyrics_taskinfo: [],
      maintrack_adsorb: true, material_save_mode: 0, multi_language_current: "none",
      multi_language_list: [], multi_language_main: "none", multi_language_mode: "none",
      multiple_sounds: false, original_sound_last_index: 1, record_audio_last_index: 1,
      sticker_max_index: 1, subtitle_keywords_config: null, subtitle_recognition_id: "",
      subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [],
      video_mute: false, zoom_info_params: null,
    },
    duration: cursor,
    extra_info: null,
    fps: input.fps ?? 30.0,
    free_render_index_mode_on: false,
    group_container: null,
    id: uid(),
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: platformInfo(),
    lyrics_effects: [],
    materials: {
      audio_effects: [], audio_fades: [], audio_track_indexes: [], audios,
      beats: [], canvases, common_mask: [], drafts: [], effects: [], flowers: [], folders: [],
      green_screens: [], handwrites: [], images: [], log_color_wheels: [], loudnesses: [],
      manual_deformations: [], masks: [], material_animations: [], material_colors: [],
      multi_language_refs: [], placeholders: [], plugin_effects: [], primary_color_wheels: [],
      realtime_denoises: [], shapes: [], smart_crops: [], smart_relights: [],
      sound_channel_mappings: mappings, speeds, stickers: [], tail_leaders: [],
      text_templates: [], texts: [], time_marks: [], transitions: [],
      video_effects: [], video_trackings: [], videos, vocal_beautifys: [], vocal_separations: [],
    },
    mutable_config: null,
    name: input.name,
    new_version: "110.0.0",
    platform: platformInfo(),
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: "default",
    static_cover_image_path: "",
    time_marks: null,
    tracks,
    update_time: Math.round(Date.now() / 1000),
    version: 360000,
  };

  return { content, durationUs: cursor };
}

export function buildDraftMeta(input: {
  draftId: string;
  name: string;
  draftDir: string;
  rootDir: string;
  durationUs: number;
  materialBytes: number;
}): Record<string, unknown> {
  const now = Date.now() * 1000;
  return {
    cloud_package_completed_time: "",
    draft_cloud_capcut_purchase_info: "",
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: "",
    draft_cloud_template_id: "",
    draft_cloud_tutorial_info: "",
    draft_cloud_videocut_purchase_info: "",
    draft_cover: "draft_cover.jpg",
    draft_deeplink_url: "",
    draft_enterprise_info: { draft_enterprise_extra: "", draft_enterprise_id: "", draft_enterprise_name: "", enterprise_material: [] },
    draft_fold_path: input.draftDir,
    draft_id: input.draftId,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: "false",
    draft_is_invisible: false,
    draft_materials_copied_info: [],
    draft_name: input.name,
    draft_need_rename_folder: false,
    draft_new_version: "",
    draft_removable_storage_device: "",
    draft_root_path: input.rootDir,
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: input.materialBytes,
    draft_type: "",
    tm_draft_create: now,
    tm_draft_modified: now,
    tm_draft_removed: 0,
    tm_duration: input.durationUs,
  };
}
