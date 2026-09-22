import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "channel-keys.json";

/**
 * 渠道 API Key 的持久化存储。
 *
 * 密钥以明文 JSON 保存在数据目录中，重启服务后自动载入，用户不需要二次配置。
 * 文件权限设为 0600（仅当前用户可读写），并且数据目录不在 Git 仓库内。
 * 明文存储意味着任何能读取该文件的程序都能取得密钥。
 */
export class KeyStore {
  private readonly filePath: string | null;
  private readonly keys = new Map<string, string>();

  constructor(dataDir?: string) {
    this.filePath = dataDir ? path.join(dataDir, FILE_NAME) : null;
    this.load();
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [channelId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value) this.keys.set(channelId, value);
      }
    } catch {
      // 文件损坏时保持空存储，用户可以重新填写密钥
    }
  }

  private persist() {
    if (!this.filePath) return;
    const payload = JSON.stringify(Object.fromEntries(this.keys), null, 2);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, payload, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // 写入失败时密钥仍在内存中可用，不影响本次会话
    }
  }

  get(channelId: string): string | undefined {
    return this.keys.get(channelId);
  }

  set(channelId: string, key: string) {
    if (!key) return;
    this.keys.set(channelId, key);
    this.persist();
  }

  delete(channelId: string) {
    if (!this.keys.delete(channelId)) return;
    this.persist();
  }

  /** 清理已删除渠道遗留的密钥 */
  retainOnly(channelIds: Iterable<string>) {
    const keep = new Set(channelIds);
    let changed = false;
    for (const channelId of [...this.keys.keys()]) {
      if (!keep.has(channelId)) {
        this.keys.delete(channelId);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
