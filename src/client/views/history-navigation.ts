import { useState } from "react";

export type HistoryMode = "assets" | "records";
export type HistoryKind = "all" | "image" | "video" | "audio";

export function useHistoryNavigation() {
  const [mode, setMode] = useState<HistoryMode>("records");
  const [kind, setKind] = useState<HistoryKind>("all");
  return { mode, kind, setMode, setKind };
}

export type HistoryNavigation = ReturnType<typeof useHistoryNavigation>;
