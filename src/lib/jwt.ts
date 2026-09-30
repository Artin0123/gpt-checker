import { b64urlDecodeText } from "./crypto";

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

/** 只解碼、不驗簽（token 來源是 OpenAI 或使用者本人，只用來取 metadata） */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(b64urlDecodeText(parts[1]));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface TokenClaims {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  /** unix 秒 */
  exp: number | null;
}

export function claimsOf(token: string | null | undefined): TokenClaims {
  const p = decodeJwtPayload(token);
  if (!p) return { accountId: null, email: null, planType: null, exp: null };
  const auth = obj(p[AUTH_CLAIM]);
  return {
    accountId: str(auth.chatgpt_account_id),
    email: str(p.email) ?? str(obj(p[PROFILE_CLAIM]).email),
    planType: str(auth.chatgpt_plan_type),
    exp: typeof p.exp === "number" ? p.exp : null,
  };
}
