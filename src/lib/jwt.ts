import { b64urlDecodeText } from "./crypto";
import { isObj, obj, str } from "./json";

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

/** 只解碼、不驗簽（token 來源是 OpenAI 或使用者本人，只用來取 metadata） */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload: unknown = JSON.parse(b64urlDecodeText(parts[1]));
    return isObj(payload) ? payload : null;
  } catch {
    return null;
  }
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
