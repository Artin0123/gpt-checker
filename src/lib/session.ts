// 登入 session 存在 KV（`session:<sha256(token)>`，TTL 7 天）：
// 登入寫 1 次、登出刪 1 次、每個已登入的請求讀 1 次。cookie 只放隨機 token，KV 只存雜湊，
// 看得到 KV 內容也拿不到可用的 cookie。登出會真的讓 session 失效（其他地區最多約 60 秒生效）。
import type { Env } from "../env";
import { b64urlEncode, randomToken, sha256 } from "./crypto";

export const SESSION_COOKIE = "gc_session";
export const SESSION_TTL_SECONDS = 7 * 86400;
const SESSION_PREFIX = "session:";
/** randomToken(32) 的格式；不符合就不查 KV */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function sessionKey(token: string): Promise<string> {
  return SESSION_PREFIX + b64urlEncode(await sha256(token));
}

export async function createSession(env: Env, now = Date.now()): Promise<string> {
  const token = randomToken(32);
  await env.ACCOUNTS.put(await sessionKey(token), JSON.stringify({ createdAt: now }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function verifySession(env: Env, token: string): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;
  return (await env.ACCOUNTS.get(await sessionKey(token))) !== null;
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  if (TOKEN_PATTERN.test(token)) await env.ACCOUNTS.delete(await sessionKey(token));
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}
