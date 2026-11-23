import type { AppDatabase } from "./db.js";
import { removeStoredFiles } from "./routes/files.js";

export async function purgeConversationTrashItem(db: AppDatabase, id: string): Promise<boolean> {
  const removed = db.purgeTrashedConversation(id);
  if (!removed) return false;
  await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
  return true;
}

export async function purgeExpiredConversationTrash(db: AppDatabase) {
  for (const id of db.expiredConversationTrashIds()) {
    try { await purgeConversationTrashItem(db, id); }
    catch (error) { console.warn(`清理到期会话 ${id} 失败`, error); }
  }
}
