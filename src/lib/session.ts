import { b64urlDecode, b64urlEncode, hmacSha256, timingSafeEqual } from "./crypto";

export const SESSION_COOKIE = "gc_session";
export const SESSION_TTL_SECONDS = 7 * 86400;

// token 格式：v1.<exp 秒>.<HMAC-SHA256(secret, "v1.<exp>")>
export async function createSessionToken(secret: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${exp}`;
  return `${payload}.${b64urlEncode(await hmacSha256(secret, payload))}`;
}

export async function verifySessionToken(token: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d+$/.test(parts[1])) return false;
  let given: Uint8Array;
  try {
    given = b64urlDecode(parts[2]);
  } catch {
    return false;
  }
  const expected = await hmacSha256(secret, `v1.${parts[1]}`);
  if (!timingSafeEqual(given, expected)) return false;
  return Number(parts[1]) > Math.floor(now / 1000);
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
