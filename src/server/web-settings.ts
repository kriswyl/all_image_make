import { z } from "zod";
import { CHAT_WEB_PROVIDERS, type ChatWebSettings } from "../shared/chat-web.js";
import type { AppDatabase } from "./db.js";
import type { KeyStore } from "./key-store.js";

export const TAVILY_KEY_ID = "chat-web:tavily";
const settingKey = "chatWebProviders";
const preferencesSchema = z.object({ preferred: z.enum(CHAT_WEB_PROVIDERS), fallback: z.boolean() });
export const chatWebSettingsPatchSchema = preferencesSchema.extend({
  tavilyKey: z.string().trim().max(512).regex(/^[\x21-\x7e]*$/).optional(),
}).strict();
const defaults = { preferred: "firecrawl", fallback: false } as const;

export function readChatWebSettings(db: AppDatabase, keys: KeyStore): ChatWebSettings {
  const hasTavilyKey = Boolean(keys.get(TAVILY_KEY_ID));
  let preferences: z.infer<typeof preferencesSchema> = defaults;
  try {
    const stored = preferencesSchema.safeParse(JSON.parse(db.getSetting(settingKey) ?? "null"));
    if (stored.success) preferences = stored.data;
  } catch { /* An unreadable preference uses the keyless defaults. */ }
  return hasTavilyKey ? { ...preferences, hasTavilyKey } : { ...defaults, hasTavilyKey };
}

export function updateChatWebSettings(db: AppDatabase, keys: KeyStore, input: z.infer<typeof chatWebSettingsPatchSchema>): ChatWebSettings {
  if (input.tavilyKey) keys.set(TAVILY_KEY_ID, input.tavilyKey);
  else if (input.tavilyKey === "") keys.delete(TAVILY_KEY_ID);
  const preferences = keys.get(TAVILY_KEY_ID) ? { preferred: input.preferred, fallback: input.fallback } : defaults;
  db.setSetting(settingKey, JSON.stringify(preferences));
  return readChatWebSettings(db, keys);
}
