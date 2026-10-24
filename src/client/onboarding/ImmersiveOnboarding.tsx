/**
 * 无印冷白 / 水墨新手引导。
 *
 * 结构比上一版更慢：欢迎 → 每个类型的「章节页」→ 该类型的「选模型页」→ 填 Key。
 * 章节页负责讲清楚这一章在选什么，选模型页只留气泡和一句提示——不再用小卡片
 * 浮在气泡上。视觉用纯白底、墨线、圆相、竖排诗句和炭灰印章，和工作台的白底对齐。
 *
 * 数据和保存没有另起一套：模型来自 `MODEL_GROUPS`，保存走 `api.saveChannel`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, ChevronRight, KeyRound, LoaderCircle, Sparkles,
} from "lucide-react";
import { api } from "../api";
import { openExternal } from "../external";
import { adapterLabels } from "../labels";
import { ModelLogo, type ModelKind } from "../chat/ModelLogo";
import type { Channel } from "../../shared/types";
import {
  MODEL_GROUPS, draftForGroup, duplicateFor, groupsForKind, recommendedModelFor,
  type ModelGroup, type ModelGroupKind,
} from "../../shared/model-catalog";

/** 和模型组的展示品类一一对应；音乐 / 语音虽然同属音频任务，引导里分两章讲 */
type ChapterKind = ModelGroupKind;
type Stage =
  | "welcome" | "needs"
  | "chat-intro" | "chat-select"
  | "image-intro" | "image-select"
  | "video-intro" | "video-select"
  | "music-intro" | "music-select"
  | "speech-intro" | "speech-select"
  | "config" | "finish";
type Transition = "forward" | "back" | null;

/** 章节顺序和「你需要？」里的选项顺序一致：先用的排前面，对话大脑放最后 */
const CHAPTER_ORDER: ChapterKind[] = ["image", "video", "music", "speech", "chat"];

const NEED_OPTIONS: Array<{ kind: ChapterKind; label: string; hint: string; char: string }> = [
  { kind: "image", label: "生图", hint: "画图、改图、图生图", char: "绘" },
  { kind: "video", label: "生视频", hint: "文生视频、首尾帧、参考图", char: "动" },
  { kind: "music", label: "生音乐", hint: "Suno 写歌、歌词、纯音乐", char: "乐" },
  { kind: "speech", label: "生语音", hint: "配音、旁白、双人对话", char: "声" },
  { kind: "chat", label: "对话创作", hint: "和 AI 一起规划与生成", char: "对" },
];

const TIANTOKEN_LOGIN_URL = "https://api.tiantoken.com/login";

interface KeyState { secretEnv: string; apiKey: string; }
interface RowResult { status: "saving" | "done" | "error" | "skipped"; message?: string; }

const CHAPTERS: Record<ChapterKind, {
  index: string;
  num: string;
  en: string;
  title: string;
  selectTitle: string;
  char: string;
  poem: string;
  lede: string;
  selectHint: string;
  note: string;
}> = {
  chat: {
    index: "第一章", num: "01", en: "CHAPTER 01",
    title: "选择对话模型",
    selectTitle: "点亮一颗作为你的对话大脑",
    char: "对",
    poem: "一念起 · 万物生",
    lede: "让一个大脑理解你的话，\n再决定画什么。",
    selectHint: "它负责理解你的话、决定下一步做什么。选一颗，之后也能换。",
    note: "之后也能随时更换",
  },
  image: {
    index: "第二章", num: "02", en: "CHAPTER 02",
    title: "选择生图模型",
    selectTitle: "选中你要用的生图模型",
    char: "绘",
    poem: "落笔成山 · 点墨成海",
    lede: "落笔成山，\n点墨成海。",
    selectHint: "可以多选；不同系列会各自生成一个渠道配置。",
    note: "可以多选，不同系列各自成组",
  },
  video: {
    index: "第三章", num: "03", en: "CHAPTER 03",
    title: "选择视频模型",
    selectTitle: "选中视频模型，或者先跳过",
    char: "动",
    poem: "风起于青萍之末",
    lede: "让画面有风，\n也有呼吸。",
    selectHint: "可以多选；万相、Seedance、可灵各自成组。",
    note: "可以多选，也可以先跳过",
  },
  music: {
    index: "第四章", num: "04", en: "CHAPTER 04",
    title: "选择音乐模型",
    selectTitle: "选一颗做歌的种子",
    char: "乐",
    poem: "丝竹入耳 · 心声成曲",
    lede: "让旋律落地，\n让歌词有声音。",
    selectHint: "Suno 负责写歌：灵感描述、自定义歌词、纯音乐；可以多选。",
    note: "写歌和配音不是同一组模型，下一章单独配",
  },
  speech: {
    index: "第五章", num: "05", en: "CHAPTER 05",
    title: "选择语音模型",
    selectTitle: "选一个适合的声音",
    char: "声",
    poem: "字落有声 · 声入人心",
    lede: "让文字开口，\n让旁白有温度。",
    selectHint: "Gemini TTS 负责配音 / 旁白，30 个预置音色；可以多选。",
    note: "之后也能随时更换音色",
  },
};

const MODES: Record<ChapterKind, string> = { image: "生图", video: "视频", music: "音乐", speech: "语音", chat: "对话" };
const KIND_MARKS: Record<ChapterKind, string> = { image: "绘", video: "动", music: "乐", speech: "声", chat: "对" };

/** 模型 logo 仍按渠道品类找品牌（Suno / Gemini 都在 audio 下） */
function logoKind(kind: ChapterKind): ModelKind {
  return kind === "music" || kind === "speech" ? "audio" : kind;
}

function kindOfStage(stage: Stage): ChapterKind | null {
  if (stage.startsWith("chat-")) return "chat";
  if (stage.startsWith("image-")) return "image";
  if (stage.startsWith("video-")) return "video";
  if (stage.startsWith("music-")) return "music";
  if (stage.startsWith("speech-")) return "speech";
  return null;
}

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function bubbleStyle(index: number, total: number, key: string, kind: ModelGroupKind) {
  const h = hash(key);
  const wide = total > 8;
  if (wide) {
    // 生图有 11 个模型，圆形排布会挤在一起；改成松散的 4 列网格 + 轻微错位
    const col = index % 4;
    const row = Math.floor(index / 4);
    return {
      left: `${16 + col * 21 + ((h % 7) - 3)}%`,
      top: `${33 + row * 20 + (((h >> 3) % 5) - 2)}%`,
      size: 88 + (h % 4) * 10,
      dx: `${((h >> 5) % 18) - 9}px`,
      dy: `${((h >> 9) % 16) - 8}px`,
      rot: `${(((h >> 13) % 5) - 2) * 0.7}deg`,
      dur: `${8 + (h % 5)}s`,
      delay: `-${h % 7}s`,
    };
  }
  const angle = (index / Math.max(1, total)) * Math.PI * 2 + (kind === "chat" ? 0.15 : kind === "image" ? 1.25 : 2.35);
  const radiusX = 30 + (h % 5);
  const radiusY = 26 + ((h >> 3) % 6);
  return {
    left: `${47 + Math.cos(angle) * radiusX}%`,
    top: `${50 + Math.sin(angle) * radiusY}%`,
    size: 102 + (h % 5) * 13,
    dx: `${((h >> 5) % 26) - 13}px`,
    dy: `${((h >> 9) % 22) - 11}px`,
    rot: `${(((h >> 13) % 7) - 3) * 0.8}deg`,
    dur: `${7 + (h % 6)}s`,
    delay: `-${h % 8}s`,
  };
}

export function ImmersiveOnboarding({
  channels,
  onSaved,
  onToast,
  onClose,
  onOpenTemplates,
  onOpenCustom,
}: {
  channels: Channel[];
  onSaved: (channel: Channel) => void;
  onToast: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onOpenTemplates?: () => void;
  onOpenCustom?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const completeTimer = useRef<number | undefined>(undefined);
  const savedRef = useRef<Channel[]>([]);

  const [stage, setStage] = useState<Stage>("welcome");
  const [transition, setTransition] = useState<Transition>(null);
  const [needs, setNeeds] = useState<ChapterKind[]>([]);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [keys, setKeys] = useState<Record<string, KeyState>>({});
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [saved, setSaved] = useState<Channel[]>([]);
  const [inkBurst, setInkBurst] = useState<Array<{ id: number; x: number; y: number; dx: number; dy: number }>>([]);

  savedRef.current = saved;
  const activeKinds = useMemo(
    () => CHAPTER_ORDER.filter((item) => needs.includes(item)),
    [needs],
  );
  const flowStages = useMemo<Stage[]>(() => [
    "welcome", "needs",
    ...activeKinds.flatMap((item) => [`${item}-intro`, `${item}-select`] as Stage[]),
    "config", "finish",
  ], [activeKinds]);
  const kind = kindOfStage(stage);
  const chapterIndex = kind ? activeKinds.indexOf(kind) : -1;
  const chapter = kind
    ? {
        ...CHAPTERS[kind],
        index: `第${["一", "二", "三", "四", "五"][chapterIndex] ?? chapterIndex + 1}章`,
        num: String(chapterIndex + 1).padStart(2, "0"),
        en: `CHAPTER ${String(chapterIndex + 1).padStart(2, "0")}`,
      }
    : null;
  const isIntro = stage.endsWith("-intro");
  const isSelect = stage.endsWith("-select");
  const stageGroups = kind ? groupsForKind(kind) : [];
  const stageModelCount = stageGroups.reduce((total, group) => total + (selected[group.key]?.length ?? 0), 0);
  const recommended = kind ? recommendedModelFor(kind) : undefined;
  const recommendedKey = recommended ? `${recommended.group.key}:${recommended.model}` : null;

  const bubbles = useMemo(() => {
    if (!kind) return [];
    const items = groupsForKind(kind).flatMap((group) =>
      group.unit.models.map((model) => ({ group, model })));
    return items.map((item, index) => {
      const key = `${item.group.key}:${item.model}`;
      const style = bubbleStyle(index, items.length, key, kind);
      return {
        ...item,
        key,
        recommended: key === recommendedKey,
        style: key === recommendedKey ? { ...style, size: style.size + 16 } : style,
      };
    });
  }, [kind, recommendedKey]);

  const selectedGroups = useMemo(
    () => MODEL_GROUPS.filter((group) =>
      needs.includes(group.kind) && (selected[group.key]?.length ?? 0) > 0),
    [selected, needs],
  );
  const knownChannels = useMemo(
    () => [...saved, ...channels.filter((channel) => !saved.some((item) => item.id === channel.id))],
    [saved, channels],
  );
  const rows = useMemo(() => selectedGroups.map((group) => {
    const state = keys[group.key] ?? { secretEnv: group.unit.secretEnv, apiKey: "" };
    const draft = draftForGroup(group, selected[group.key]!, state.secretEnv, state.apiKey);
    return { group, state, draft, duplicate: duplicateFor(draft, knownChannels) };
  }), [selectedGroups, selected, keys, knownChannels]);

  const keyReady = (row: (typeof rows)[number]) => Boolean(row.state.apiKey.trim())
    || knownChannels.some((channel) => channel.secretEnv === row.state.secretEnv && channel.hasKey);
  const missingKeyRows = rows.filter((row) => !keyReady(row));
  const highlightKey = missingKeyRows[0]?.group.key ?? null;

  function go(next: Stage, direction: "forward" | "back" = "forward") {
    if (transition) return;
    setTransition(direction);
    window.setTimeout(() => {
      setStage(next);
      setTransition(null);
    }, 380);
  }

  function nextChapter(current: ChapterKind): Stage {
    const index = activeKinds.indexOf(current);
    const next = activeKinds[index + 1];
    return next ? `${next}-intro` : "config";
  }

  function previousStage(current: Stage): Stage | null {
    if (current === "welcome") return null;
    if (current === "needs") return "welcome";
    const currentKind = kindOfStage(current);
    if (currentKind) {
      const index = activeKinds.indexOf(currentKind);
      if (current.endsWith("-select")) return `${currentKind}-intro`;
      if (index > 0) return `${activeKinds[index - 1]}-select`;
      return "needs";
    }
    if (current === "config") {
      const last = activeKinds[activeKinds.length - 1];
      return last ? `${last}-select` : "needs";
    }
    return null;
  }

  function toggleNeed(target: ChapterKind) {
    const removing = needs.includes(target);
    setNeeds((current) => removing
      ? current.filter((item) => item !== target)
      : [...current, target]);
    if (!removing) return;
    // 取消某一类时顺手清掉它已选的模型，避免配置页出现「没勾的类别」
    setSelected((models) => {
      const next = { ...models };
      for (const group of groupsForKind(target)) delete next[group.key];
      return next;
    });
  }

  function toggleModel(group: ModelGroup, model: string) {
    setSelected((current) => {
      const models = current[group.key] ?? [];
      if (group.kind === "chat") {
        // 对话大脑只留一颗；再点一次就是取消
        return models.includes(model)
          ? (() => { const next = { ...current }; delete next[group.key]; return next; })()
          : { ...current, [group.key]: [model] };
      }
      const next = models.includes(model)
        ? models.filter((item) => item !== model)
        : [...models, model];
      if (!next.length) {
        const copy = { ...current };
        delete copy[group.key];
        return copy;
      }
      return { ...current, [group.key]: next };
    });
  }

  function updateKey(groupKey: string, patch: Partial<KeyState>) {
    setKeys((current) => ({
      ...current,
      [groupKey]: { ...(current[groupKey] ?? { secretEnv: "", apiKey: "" }), ...patch },
    }));
  }

  function copyPreviousKey(index: number) {
    const previous = rows[index - 1];
    if (!previous) return;
    updateKey(rows[index]!.group.key, { apiKey: previous.state.apiKey });
  }

  function burstInk(event: React.MouseEvent<HTMLButtonElement>) {
    const root = rootRef.current?.getBoundingClientRect();
    if (!root) return;
    const x = event.clientX - root.left;
    const y = event.clientY - root.top;
    const drops = Array.from({ length: 9 }, (_, index) => ({
      id: Date.now() + index,
      x, y,
      dx: (Math.random() - 0.5) * 90,
      dy: (Math.random() - 0.5) * 70,
    }));
    setInkBurst((current) => [...current, ...drops]);
    window.setTimeout(() => {
      setInkBurst((current) => current.filter((drop) => !drops.some((item) => item.id === drop.id)));
    }, 700);
  }

  function skip() {
    for (const channel of savedRef.current) onSaved(channel);
    onClose();
  }

  function complete() {
    window.clearTimeout(completeTimer.current);
    for (const channel of savedRef.current) onSaved(channel);
    onClose();
  }

  function leaveTo(action?: () => void) {
    for (const channel of savedRef.current) onSaved(channel);
    action?.();
  }

  async function save() {
    if (!rows.length) {
      onToast("error", "还没有选择模型，先回去选一颗");
      go(previousStage("config") ?? "needs", "back");
      return;
    }
    const readyRows = rows.filter(keyReady);
    const skippedRows = rows.filter((row) => !keyReady(row));
    if (!readyRows.length) {
      onToast("error", "还没有填任何 API Key，至少填一组再开始配置");
      return;
    }
    if (skippedRows.length) {
      const confirmed = window.confirm(
        `还有 ${skippedRows.length} 个模型没填 API Key，将只保存已填好的 ${readyRows.length} 个。`
        + "之后可以在「模型设置」里继续补。现在开始配置吗？",
      );
      if (!confirmed) return;
    }

    setSaving(true);
    setResults(Object.fromEntries([
      ...readyRows.map((row) => [row.group.key, { status: "saving" as const }]),
      ...skippedRows.map((row) => [row.group.key, { status: "skipped" as const, message: "缺 Key，已跳过" }]),
    ]));
    const savedNow: Channel[] = [];
    try {
      for (const row of readyRows) {
        if (!row.draft) continue;
        try {
          const channel = row.duplicate
            ? await api.saveChannel(row.draft.input, row.duplicate.id)
            : await api.saveChannel(row.draft.input);
          savedNow.push(channel);
          setResults((current) => ({
            ...current,
            [row.group.key]: { status: "done", message: row.duplicate ? "已更新" : "已创建" },
          }));
        } catch (error) {
          setResults((current) => ({
            ...current,
            [row.group.key]: { status: "error", message: error instanceof Error ? error.message : "保存失败" },
          }));
        }
      }
      setSaved((current) => [
        ...savedNow,
        ...current.filter((channel) => !savedNow.some((item) => item.id === channel.id)),
      ]);
      if (savedNow.length === readyRows.length) {
        onToast("success", skippedRows.length
          ? `已配置 ${savedNow.length} 个渠道，${skippedRows.length} 个缺 Key 已跳过`
          : `已配置 ${savedNow.length} 个渠道`);
        go("finish", "forward");
      } else {
        onToast("error", `${readyRows.length - savedNow.length} 个配置保存失败，可以直接重试`);
      }
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (stage !== "finish") return;
    completeTimer.current = window.setTimeout(complete, 2600);
    return () => window.clearTimeout(completeTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const step = Math.max(1, flowStages.indexOf(stage));
  const stepTotal = Math.max(1, flowStages.length - 1);
  const progressChapter = kind
    ? activeKinds.indexOf(kind) + 1
    : stage === "config" ? activeKinds.length + 1 : 0;
  const progressTotal = activeKinds.length + 1;

  return (
    <div
      ref={rootRef}
      className={`ink-onboarding stage-${stage} ${transition ? `is-exiting is-${transition}` : ""}`}
    >
      <div className="ink-background" aria-hidden="true">
        <svg className="ink-mountains" viewBox="0 0 1440 500" preserveAspectRatio="none">
          <path d="M0,420 C180,300 300,360 430,300 C600,220 700,330 860,280 C1040,220 1160,330 1440,250 L1440,500 L0,500 Z" fill="#697570" opacity=".055" />
          <path d="M0,470 C220,380 360,430 560,360 C760,290 920,400 1120,340 C1260,300 1360,340 1440,320 L1440,500 L0,500 Z" fill="#4f5b56" opacity=".04" />
        </svg>
        <svg className="ink-stroke one" viewBox="0 0 300 20">
          <path d="M4 12 C60 3 120 18 170 8 C215 0 260 14 296 9" fill="none" stroke="#242724" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        <svg className="ink-stroke two" viewBox="0 0 260 18">
          <path d="M3 10 C50 2 100 16 150 8 C195 1 230 12 257 7" fill="none" stroke="#242724" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>

      {inkBurst.map((drop) => (
        <span
          key={drop.id}
          className="ink-burst-drop"
          style={{ left: drop.x, top: drop.y, "--dx": `${drop.dx}px`, "--dy": `${drop.dy}px` } as React.CSSProperties}
        />
      ))}

      {stage !== "welcome" && stage !== "needs" && stage !== "finish" ? (
        <header className="ink-chrome">
          <div className="ink-brand">
            <span className="ink-mark">C</span>
            <span>ChatCanvas</span>
            <em>初次探索</em>
          </div>
          <div className="ink-progress" aria-label="引导进度">
            {Array.from({ length: progressTotal }, (_, index) => index + 1).map((index) => (
              <i key={index} className={progressChapter >= index ? "is-on" : ""} />
            ))}
          </div>
        </header>
      ) : null}

      <div className="ink-stage" key={stage}>
        {stage === "welcome" ? (
          <section className="ink-welcome">
            <svg className="ink-welcome-enso" viewBox="0 0 520 520" aria-hidden="true">
              <path className="ink-draw" d="M 262 54 C 376 40 466 132 456 250 C 447 360 344 452 226 440 C 118 429 52 338 74 230 C 93 136 178 58 284 68" fill="none" stroke="#242724" strokeWidth="1.5" strokeLinecap="round" opacity=".18" />
            </svg>
            <span className="ink-kicker">CHAT CANVAS</span>
            <h1>欢迎使用 ChatCanvas</h1>
            <p className="ink-slogan">马中赤兔，创中语布</p>
            <p className="ink-lede">先选几颗你喜欢的模型，剩下的交给纸与墨。</p>
            <button
              type="button"
              className="ink-primary ink-welcome-cta"
              onClick={(event) => { burstInk(event); go("needs"); }}
            >
              开启探索 <ArrowRight size={15} />
            </button>
            <div className="ink-vertical">一念起 · 万物生</div>
            <span className="ink-seal ink-welcome-seal">始</span>
            <div className="ink-welcome-advanced">
              {onOpenTemplates ? <button type="button" className="ink-link" onClick={() => leaveTo(onOpenTemplates)}>按站点模板配置</button> : null}
              {onOpenCustom ? <button type="button" className="ink-link" onClick={() => leaveTo(onOpenCustom)}>自定义站点</button> : null}
            </div>
            <button type="button" className="ink-skip is-plain" onClick={skip}>跳过引导 →</button>
          </section>
        ) : null}

        {stage === "needs" ? (
          <section className="ink-needs">
            <span className="ink-kicker">FIRST STEP</span>
            <h1>你需要？</h1>
            <p className="ink-needs-lede">可多选，只配置你真正会用的模型。</p>
            <div className="ink-needs-grid" role="group" aria-label="选择需要的功能">
              {NEED_OPTIONS.map((option) => {
                const on = needs.includes(option.kind);
                return (
                  <button
                    key={option.kind}
                    type="button"
                    className={`ink-need ${on ? "is-on" : ""}`}
                    aria-pressed={on}
                    onClick={() => toggleNeed(option.kind)}
                  >
                    <span className="ink-need-char">{option.char}</span>
                    <strong>{option.label}</strong>
                    <small>{option.hint}</small>
                    {on ? <span className="ink-need-check"><Check size={12} /></span> : null}
                  </button>
                );
              })}
            </div>
            <div className="ink-needs-actions">
              <button type="button" className="ink-ghost" onClick={() => go("welcome", "back")}>
                <ArrowLeft size={13} />上一步
              </button>
              <div>
                <button type="button" className="ink-link" onClick={() => setNeeds([...CHAPTER_ORDER])}>全都要</button>
                <button
                  type="button"
                  className="ink-primary"
                  disabled={!needs.length}
                  onClick={() => go(activeKinds[0] ? `${activeKinds[0]}-intro` : "config")}
                >
                  继续 <ArrowRight size={14} />
                </button>
              </div>
            </div>
            <div className="ink-vertical">先问所需 · 再配其器</div>
            <span className="ink-seal ink-needs-seal">需</span>
            <button type="button" className="ink-skip is-plain" onClick={skip}>跳过引导 →</button>
          </section>
        ) : null}

        {kind && chapter && isIntro ? (
          <section className="ink-intro">
            <div className="ink-intro-art">
              <div className="ink-enso-wrap">
                <svg viewBox="0 0 520 520">
                  <path className="ink-draw" d="M 268 62 C 382 48 470 142 456 256 C 443 366 340 458 224 442 C 114 427 54 332 80 222 C 104 122 196 54 310 76" fill="none" stroke="#242724" strokeWidth="1.7" strokeLinecap="round" opacity=".38" />
                  <path className="ink-draw-tail" d="M 310 76 C 330 80 348 88 364 98" fill="none" stroke="#242724" strokeWidth="4.5" strokeLinecap="round" opacity=".22" />
                </svg>
                <span className="ink-enso-char">{chapter.char}</span>
                <span className="ink-splash s1" /><span className="ink-splash s2" /><span className="ink-splash s3" />
              </div>
              <div className="ink-art-caption">{MODES[kind]} · {chapter.index}</div>
            </div>

            <div className="ink-intro-copy">
              <div className="ink-chapter">
                <span>{chapter.index}</span><i /><em>{chapter.en}</em>
              </div>
              <h1>{chapter.title}</h1>
              <p className="ink-intro-lede">
                {chapter.lede.split("\n").map((line, index) => (
                  <span key={line}>{index ? <br /> : null}{line}</span>
                ))}
              </p>
              {recommended ? (
                <div className="ink-meta">
                  推荐 <b>{recommended.model}</b><br />{chapter.note}
                </div>
              ) : null}
              <div className="ink-actions">
                <button
                  type="button"
                  className="ink-primary"
                  onClick={(event) => { burstInk(event); go(`${kind}-select`); }}
                >
                  开始选择 <ArrowRight size={15} />
                </button>
                <button type="button" className="ink-link" onClick={() => go(nextChapter(kind))}>跳过这一步</button>
              </div>
              <button type="button" className="ink-back" onClick={() => { const previous = previousStage(stage); if (previous) go(previous, "back"); }}>
                <ArrowLeft size={13} />上一步
              </button>
            </div>

            <div className="ink-vertical ink-intro-poem">
              {chapter.poem}
              <span className="ink-seal">{chapter.char}</span>
            </div>
            <div className="ink-step-nav"><span>{String(step).padStart(2, "0")}</span><i /><em>{String(stepTotal).padStart(2, "0")}</em></div>
            <button type="button" className="ink-skip" onClick={skip}>跳过引导 →</button>
          </section>
        ) : null}

        {kind && chapter && isSelect ? (
          <section className="ink-select">
            <div className="ink-select-head">
              <span className="ink-kicker">{chapter.index} · {chapter.title}</span>
              <h1>{chapter.selectTitle}</h1>
              <p>{chapter.selectHint}</p>
            </div>
            <div className="ink-vertical-label">{MODES[kind]}</div>

            <div className="ink-bubble-field">
              {bubbles.map((bubble) => {
                const on = (selected[bubble.group.key] ?? []).includes(bubble.model);
                return (
                  <button
                    key={bubble.key}
                    type="button"
                    className={`ink-bubble ${on ? "is-selected" : ""} ${bubble.recommended ? "is-recommended" : ""}`}
                    style={{
                      left: bubble.style.left,
                      top: bubble.style.top,
                      width: bubble.style.size,
                      height: bubble.style.size,
                      "--dx": bubble.style.dx,
                      "--dy": bubble.style.dy,
                      "--rot": bubble.style.rot,
                      "--dur": bubble.style.dur,
                      "--delay": bubble.style.delay,
                    } as React.CSSProperties}
                    aria-pressed={on}
                    title={`${bubble.model} · ${bubble.group.unit.label}`}
                    onClick={() => toggleModel(bubble.group, bubble.model)}
                  >
                    {bubble.recommended ? <span className="ink-bubble-rec">推荐</span> : null}
                    <span className="ink-bubble-logo">
                      <ModelLogo model={bubble.model} kind={logoKind(bubble.group.kind)} size={bubble.style.size >= 130 ? 22 : 19} />
                    </span>
                    <span className="ink-bubble-name">{bubble.model}</span>
                    <span className="ink-bubble-sub">{bubble.group.unit.label}</span>
                    {on ? <span className="ink-bubble-seal">选</span> : null}
                  </button>
                );
              })}
            </div>

            <footer className="ink-select-foot">
              <button type="button" className="ink-ghost" onClick={() => { const previous = previousStage(stage); if (previous) go(previous, "back"); }}>
                <ArrowLeft size={13} />上一步
              </button>
              <div className="ink-select-right">
                <span className="ink-count">已选 {stageModelCount} 颗</span>
                <button type="button" className="ink-link" onClick={() => go(nextChapter(kind))}>跳过这一类</button>
                <button
                  type="button"
                  className="ink-primary"
                  disabled={!stageModelCount}
                  onClick={() => go(nextChapter(kind))}
                >
                  下一步 <ArrowRight size={14} />
                </button>
              </div>
            </footer>
            <button type="button" className="ink-skip is-raised" onClick={skip}>跳过引导 →</button>
          </section>
        ) : null}

        {stage === "config" ? (
          <section className="ink-config-scene">
            <div className="ink-config-card">
              <header className="ink-config-head">
                <div>
                  <span className="ink-kicker">LAST CHAPTER · CONFIGURE</span>
                  <h1>把钥匙交给语布</h1>
                  <p>
                    {rows.length
                      ? missingKeyRows.length
                        ? `还有 ${missingKeyRows.length} 组没填 Key。可以直接开始配置，只保存已填好的；缺的之后在「模型设置」里补。`
                        : "全部就绪。点「开始配置」就能进入工作台。"
                      : "还没有选择任何模型。可以先回去选一颗，或者跳过引导去渠道页手动配置。"}
                  </p>
                  <p className="ink-provider-link">
                    <button type="button" className="ink-key-link" onClick={() => void openExternal(TIANTOKEN_LOGIN_URL)}>
                      <KeyRound size={15} />
                      <span>还没有 Key？</span>
                      <strong>去词元流墟登录获取</strong>
                      <ArrowRight size={14} />
                    </button>
                  </p>
                </div>
                <span className="ink-seal">钥</span>
              </header>

              {rows.length ? (
                <div className="ink-config-rows">
                  {rows.map((row, index) => {
                    const configured = knownChannels.some((channel) =>
                      channel.secretEnv === row.state.secretEnv && channel.hasKey);
                    const ready = keyReady(row);
                    const result = results[row.group.key];
                    const highlighted = row.group.key === highlightKey;
                    const count = selected[row.group.key]?.length ?? 0;
                    return (
                      <article
                        key={row.group.key}
                        className={`ink-config-row ${highlighted ? "is-highlight" : ""} ${ready ? "" : "is-missing"}`}
                      >
                        <div className="ink-config-title">
                          <span className="ink-config-mark">{KIND_MARKS[row.group.kind]}</span>
                          <div>
                            <strong>{row.draft?.name ?? row.group.unit.label}</strong>
                            <small>{adapterLabels[row.group.unit.adapterType]} · {count} 个模型</small>
                          </div>
                        </div>
                        <div className="ink-config-models">
                          {(selected[row.group.key] ?? []).map((model) => (
                            <span key={model}><ModelLogo model={model} kind={logoKind(row.group.kind)} size={11} />{model}</span>
                          ))}
                        </div>
                        <span className="ink-config-badge">{row.duplicate ? "更新已有" : "新建"}</span>
                        <div className="ink-config-fields">
                          <span className="ink-config-env" title={row.state.secretEnv}>{row.state.secretEnv}</span>
                          <label className={ready ? "" : "is-missing"}>
                            <span>
                              API Key
                              {configured ? <em>环境变量已配置</em> : <em className="is-required">必填</em>}
                            </span>
                            <input
                              type="password"
                              value={row.state.apiKey}
                              onChange={(event) => updateKey(row.group.key, { apiKey: event.target.value })}
                              placeholder={configured ? "已配置，可留空" : row.group.preset.keyHint ?? "在此填入密钥"}
                              autoComplete="off"
                            />
                          </label>
                        </div>
                        <div className="ink-config-row-foot">
                          {index > 0 ? (
                            <button type="button" className="ink-link" onClick={() => copyPreviousKey(index)}>使用上一组的 Key</button>
                          ) : <span />}
                          <span className={`ink-config-state ${result?.status ?? ""}`}>
                            {result?.status === "saving" ? <><LoaderCircle size={12} className="spin" />保存中</>
                              : result?.status === "done" ? <><Check size={12} />{result.message}</>
                              : result?.status === "skipped" ? <>{result.message}</>
                              : result?.status === "error" ? <>{result.message}</>
                              : ready ? "就绪" : "缺 Key"}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="ink-config-empty">
                  <Sparkles size={24} />
                  <h3>还没有点亮任何模型</h3>
                  <p>先回去选一颗，或者跳过引导去渠道页手动配置。</p>
                  <button type="button" className="ink-primary" onClick={() => go(previousStage("config") ?? "needs", "back")}>回到选模型</button>
                </div>
              )}

              <footer className="ink-config-foot">
                <button type="button" className="ink-ghost" onClick={() => go(previousStage("config") ?? "needs", "back")} disabled={saving}>
                  <ArrowLeft size={13} />上一步
                </button>
                <div>
                  {onOpenTemplates ? <button type="button" className="ink-link" onClick={() => leaveTo(onOpenTemplates)}>按站点模板配置</button> : null}
                  {onOpenCustom ? <button type="button" className="ink-link" onClick={() => leaveTo(onOpenCustom)}>自定义站点</button> : null}
                  <button type="button" className="ink-link" onClick={skip} disabled={saving}>跳过引导</button>
                  <button
                    type="button"
                    className="ink-primary"
                    disabled={saving || !rows.length}
                    onClick={() => void save()}
                  >
                    {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
                    开始配置
                  </button>
                </div>
              </footer>
            </div>
          </section>
        ) : null}

        {stage === "finish" ? (
          <section className="ink-finish">
            <svg className="ink-finish-enso" viewBox="0 0 520 520" aria-hidden="true">
              <path className="ink-draw" d="M 268 62 C 382 48 470 142 456 256 C 443 366 340 458 224 442 C 114 427 54 332 80 222 C 104 122 196 54 310 76" fill="none" stroke="#242724" strokeWidth="1.4" strokeLinecap="round" opacity=".18" />
            </svg>
            <span className="ink-kicker">READY</span>
            <h1>墨已备好。</h1>
            <p>{saved.length ? `${saved.length} 个渠道已就绪，正在进入工作台…` : "正在进入工作台…"}</p>
            <button type="button" className="ink-primary" onClick={complete}>进入主界面 <ArrowRight size={15} /></button>
            <span className="ink-seal ink-finish-seal">始</span>
          </section>
        ) : null}
      </div>
    </div>
  );
}
