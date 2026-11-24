import type { ReactNode } from "react";

export type NavigationGlyphId = "chat" | "board" | "create" | "history";

const glyphs = {
  chat: <>
    <path d="M8 4h8a5 5 0 0 1 5 5v3.5a5 5 0 0 1-5 5h-4.7L7 20.3v-2.9a5 5 0 0 1-4-4.9V9a5 5 0 0 1 5-5Z" />
    <circle cx="9" cy="10.7" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10.7" r="1.15" fill="currentColor" stroke="none" />
  </>,
  board: <>
    <path d="M9.1 8V6.5A2.5 2.5 0 0 1 11.6 4h6.9A2.5 2.5 0 0 1 21 6.5v6.9a2.5 2.5 0 0 1-2.5 2.5h-2" />
    <rect x="3" y="8" width="13.5" height="12" rx="2.6" />
  </>,
  create: <>
    <path d="M10.4 5.4c1.28 4.04 2.68 5.44 6.72 6.72-4.04 1.28-5.44 2.68-6.72 6.72-1.28-4.04-2.68-5.44-6.72-6.72 4.04-1.28 5.44-2.68 6.72-6.72Z" />
    <path d="M18.7 3.1c.52 1.7 1.28 2.46 2.98 2.98-1.7.52-2.46 1.28-2.98 2.98-.52-1.7-1.28-2.46-2.98-2.98 1.7-.52 2.46-1.28 2.98-2.98Z" />
  </>,
  history: <>
    <rect x="3.1" y="4.2" width="14.3" height="14.1" rx="2.7" />
    <path d="M17.4 7.3h.9a2.6 2.6 0 0 1 2.6 2.6v7.9a2.6 2.6 0 0 1-2.6 2.6h-8a2.6 2.6 0 0 1-2.53-2.1" />
    <path d="m3.4 15.7 3.25-3.16a1.1 1.1 0 0 1 1.55 0l2.05 2 2.68-2.62a1.1 1.1 0 0 1 1.55 0l2.92 2.84" />
    <circle cx="12.8" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
  </>,
} satisfies Record<NavigationGlyphId, ReactNode>;

export function NavigationGlyph({ name, size = 22 }: { name: NavigationGlyphId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {glyphs[name]}
    </svg>
  );
}
