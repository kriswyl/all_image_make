import { useMemo, type Ref } from "react";
import { X } from "lucide-react";

const SECTION_LABELS = new Map([
  ["intro", "前奏"],
  ["verse", "主歌"],
  ["pre-chorus", "预副歌"],
  ["chorus", "副歌"],
  ["post-chorus", "后副歌"],
  ["hook", "记忆点"],
  ["refrain", "叠句"],
  ["bridge", "桥段"],
  ["interlude", "间奏"],
  ["instrumental", "器乐段"],
  ["breakdown", "过渡段"],
  ["solo", "独奏"],
  ["outro", "尾奏"],
]);
const LOCAL_SECTION_LABELS = new Set(SECTION_LABELS.values());

function sectionLabel(line: string) {
  const marker = /^\[([^\[\]]+)\]$/.exec(line.trim())?.[1];
  if (!marker) return;
  const [, name, number] = /^(.*?)(?:\s*(\d+))?$/.exec(marker.trim()) ?? [];
  const key = name?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key) return;
  const label = SECTION_LABELS.get(key) ?? (LOCAL_SECTION_LABELS.has(key) ? key : undefined);
  if (label) return number ? label + " " + number : label;
}

function splitLyrics(lyrics: string) {
  const sections: Array<{ label?: string; paragraphs: string[] }> = [];
  let section: (typeof sections)[number] = { paragraphs: [] };
  let lines: string[] = [];

  function finishParagraph() {
    if (lines.length) section.paragraphs.push(lines.join("\n"));
    lines = [];
  }

  for (const line of lyrics.split(/\r\n?|\n/)) {
    const label = sectionLabel(line);
    if (label) {
      finishParagraph();
      if (section.label || section.paragraphs.length) sections.push(section);
      section = { label, paragraphs: [] };
    } else if (line.trim()) {
      lines.push(line);
    } else {
      finishParagraph();
    }
  }
  finishParagraph();
  if (section.label || section.paragraphs.length) sections.push(section);
  return sections;
}

export function MusicLyrics({ lyrics }: { lyrics: string }) {
  const sections = useMemo(() => splitLyrics(lyrics), [lyrics]);
  return (
    <div className="music-lyrics-text" role="region" aria-label="歌词正文" tabIndex={0}>
      <div className="music-lyrics-sheet">
        {sections.map(({ label, paragraphs }, index) => (
          <div key={index} className="music-lyric-section">
            {label ? <p className="music-lyric-label">{label}</p> : null}
            {paragraphs.map((text, paragraph) => <p key={paragraph} className="music-lyric-lines">{text}</p>)}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MusicLyricsDialog({ dialogRef, title, label, lyrics }: {
  dialogRef: Ref<HTMLDialogElement>;
  title: string;
  label: string;
  lyrics: string;
}) {
  return (
    <dialog ref={dialogRef} className="music-lyrics-dialog" aria-label={label}>
      <header>
        <h3>{title}</h3>
        <form method="dialog">
          <button className="icon-button" aria-label="关闭歌词"><X size={18} /></button>
        </form>
      </header>
      <MusicLyrics lyrics={lyrics} />
    </dialog>
  );
}
