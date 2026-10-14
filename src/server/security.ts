import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

export function loadEnvFiles() {
  const files = [path.resolve(".env"), path.resolve("..", ".env")];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      const value = match[2].replace(/^['"]|['"]$/g, "");
      process.env[match[1]] = value;
    }
  }
}

export function assertEndpoint(endpoint: string) {
  if (!endpoint) return;
  if (!endpoint.startsWith("/") || endpoint.includes("\\") || endpoint.includes("..")) {
    throw new Error("接口路径必须是以 / 开头的相对路径");
  }
}

function isPrivateIp(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export async function assertSafeUrl(input: string, allowPrivateNetwork = false) {
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("只允许 HTTP 或 HTTPS 地址");
  if (allowPrivateNetwork) return parsed;
  if (parsed.hostname === "localhost" || net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) {
    throw new Error("默认禁止访问本地或内网地址，请显式开启本地网络");
  }
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (records.some((record) => isPrivateIp(record.address))) throw new Error("目标地址解析到了本地或内网地址");
  return parsed;
}

export function joinEndpoint(baseUrl: string, endpoint: string) {
  const base = baseUrl.replace(/\/+$/, "");
  const pathPart = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${base}${pathPart}`;
}

export async function safeFetch(input: string, init: RequestInit, options: { allowPrivateNetwork?: boolean; maxRedirects?: number } = {}) {
  let current = input;
  for (let attempt = 0; attempt <= (options.maxRedirects ?? 3); attempt += 1) {
    await assertSafeUrl(current, options.allowPrivateNetwork);
    const response = await fetch(current, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(180000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current).toString();
  }
  throw new Error("重定向次数超过限制");
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/authorization|api[-_]?key|token|secret|cookie|password/i.test(key)) output[key] = "[REDACTED]";
    else output[key] = redact(item);
  }
  return output;
}

export function redactHeaders(headers: Record<string, string>) {
  return redact(headers) as Record<string, string>;
}

export function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "image";
}

/**
 * 把用户给的文件名洗成一个**能安全显示给人和大脑**的短名字。
 *
 * 和 `safeFileName` 是两件事，别合并：那个管磁盘上的名字，只留 ASCII 是为了
 * 文件系统友好；这个管用户看到的那句话——这个 app 的用户十个里有九个文件名是中文，
 * 用 `safeFileName` 洗一遍会把「验证用图.png」变成「____________.png」，
 * 等于对用户说了句废话。所以这里**留着 Unicode**，只洗掉真正危险的那几样：
 * 路径分隔符（客户端可能把整条路径塞在 filename 里）、控制字符、开头的点、超长。
 *
 * 顺带修一个 busboy 的老毛病：浏览器在 multipart 头里按 UTF-8 写文件名，
 * 而 busboy 默认按 latin1 解，于是到了这里「猫」已经变成「ç«」了。
 * 所以读之前先把 latin1 的字符串**当字节收回来重解一次**——不然上面那句
 * 「留着 Unicode」根本没机会被执行，用户看到的是更花的乱码。
 */
export function displayFileName(name: string) {
  const base = decodeUploadName(name).split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.slice(0, 120) || "图片";
}

/**
 * 把 busboy 按 latin1 解出来的文件名还原成 UTF-8。
 *
 * 只在**整串都落在 latin1 范围里**时才尝试：真的中文（每个字都 ≥ U+0100）说明
 * 上游已经解对了，再按 latin1 收字节只会把它弄坏。收回来解不干净的
 * （解出了 U+FFFD）也说明原本就是 latin1 文本，退回原样。
 */
function decodeUploadName(name: string) {
  if ([...name].some((char) => char.charCodeAt(0) >= 0x100)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}
