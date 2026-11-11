import type { DatabaseSync } from "node:sqlite";
import type { AdapterType, AuthType, ChannelInput } from "../shared/types.js";
import { now, parseJson, type DbRow } from "./db-row.js";

export interface DbChannel {
  id: string;
  name: string;
  baseUrl: string;
  adapterType: AdapterType;
  authType: AuthType;
  authHeaderName: string;
  secretEnv: string;
  endpoint: string;
  uploadEndpoint?: string;
  uploadHeaders?: Record<string, string>;
  models: string[];
  allowPrivateNetwork: boolean;
  /** 这个渠道新建的对话默认使用统一助手入口 */
  unifiedAgentDefault?: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export class ConfigurationRepository {
  constructor(private readonly db: DatabaseSync) {}

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  listChannels(): DbChannel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as DbRow[];
    return rows.map((row) => this.channelFromRow(row));
  }

  getChannel(id: string): DbChannel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.channelFromRow(row) : null;
  }

  saveChannel(input: ChannelInput, existingId?: string): DbChannel {
    const id = existingId ?? crypto.randomUUID();
    const createdAt = existingId ? this.getChannel(id)?.createdAt ?? now() : now();
    const updatedAt = now();
    const values = [
      id,
      input.name,
      input.baseUrl,
      input.adapterType,
      input.authType,
      input.authHeaderName ?? "",
      input.secretEnv ?? "",
      input.endpoint ?? "",
      input.uploadEndpoint ?? "",
      JSON.stringify(input.uploadHeaders ?? {}),
      "",
      JSON.stringify(input.models ?? []),
      input.allowPrivateNetwork ? 1 : 0,
      input.enabled === false ? 0 : 1,
      createdAt,
      updatedAt,
    ];
    this.db.prepare(`
      INSERT INTO channels
      (id, name, base_url, adapter_type, auth_type, auth_header_name, secret_env, endpoint, upload_endpoint, upload_headers_json, status_endpoint,
       models_json, allow_private_network, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, base_url=excluded.base_url, adapter_type=excluded.adapter_type,
        auth_type=excluded.auth_type, auth_header_name=excluded.auth_header_name, secret_env=excluded.secret_env,
        endpoint=excluded.endpoint, upload_endpoint=excluded.upload_endpoint, upload_headers_json=excluded.upload_headers_json, status_endpoint=excluded.status_endpoint, models_json=excluded.models_json,
        allow_private_network=excluded.allow_private_network, enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run(...values);
    return this.getChannel(id)!;
  }

  deleteChannel(id: string) {
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  /**
   * 只改「新对话默认统一入口」这一位，不动 updated_at。
   * 渠道指纹用它判断会话/断点是否仍匹配；一个 UI 偏好不该让所有进行中的任务失效。
   */
  setChannelUnifiedAgentDefault(id: string, enabled: boolean) {
    this.db.prepare("UPDATE channels SET unified_agent_default = ? WHERE id = ?").run(enabled ? 1 : 0, id);
    return this.getChannel(id);
  }

  private channelFromRow(row: DbRow): DbChannel {
    return {
      id: String(row.id), name: String(row.name), baseUrl: String(row.base_url), adapterType: String(row.adapter_type) as AdapterType,
      authType: String(row.auth_type) as AuthType, authHeaderName: String(row.auth_header_name ?? ""), secretEnv: String(row.secret_env ?? ""),
      endpoint: String(row.endpoint ?? ""), uploadEndpoint: String(row.upload_endpoint ?? ""), uploadHeaders: parseJson(row.upload_headers_json, {}), models: parseJson(row.models_json, []),
      allowPrivateNetwork: Boolean(row.allow_private_network), unifiedAgentDefault: Boolean(row.unified_agent_default),
      enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}
