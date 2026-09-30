// 純函式：Pages（OAuth 換 code）與 GHA 腳本（refresh）共用，不依賴 KV
import { claimsOf } from "./jwt";
import { CLIENT_ID, REFRESH_SCOPE, TOKEN_URL, UPSTREAM_TIMEOUT_MS, UpstreamError, describeUpstreamFailure } from "./openai";
import type { Account, Tokens } from "./types";

/** 到期前 5 分鐘就先 refresh */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** refresh token 已無法使用的錯誤碼（CPA 特別處理 refresh_token_reused） */
const INVALID_GRANT_PATTERN = /refresh_token_reused|invalid_grant|refresh_token_expired|refresh_token_invalidated/i;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export function accessTokenExpiry(account: Pick<Account, "expired" | "tokens">): number | null {
  if (account.expired) {
    const t = Date.parse(account.expired);
    if (!Number.isNaN(t)) return t;
  }
  const exp = claimsOf(account.tokens.access_token).exp;
  return exp ? exp * 1000 : null;
}

export function needsRefresh(account: Pick<Account, "expired" | "tokens">, now = Date.now()): boolean {
  if (!account.tokens.access_token) return true;
  const expiry = accessTokenExpiry(account);
  return expiry === null || expiry - now < REFRESH_MARGIN_MS;
}

/** 以 form 編碼 POST 到 token endpoint（換 code 與 refresh 共用） */
export async function postTokenEndpoint(form: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}

export function parseTokenResponse(body: string, kind: "refresh_failed" | "oauth_failed"): TokenResponse {
  let data: TokenResponse;
  try {
    data = JSON.parse(body);
  } catch {
    throw new UpstreamError(kind, "token endpoint returned invalid JSON");
  }
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new UpstreamError(kind, "token response missing access_token");
  }
  return data;
}

export async function requestRefresh(refreshToken: string): Promise<TokenResponse> {
  let res: { status: number; body: string };
  try {
    res = await postTokenEndpoint({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: REFRESH_SCOPE,
    });
  } catch (err) {
    throw new UpstreamError("refresh_failed", `token refresh request failed: ${(err as Error).message}`);
  }
  if (res.status !== 200) {
    const kind = (res.status === 400 || res.status === 401) && INVALID_GRANT_PATTERN.test(res.body) ? "refresh_invalid" : "refresh_failed";
    throw new UpstreamError(kind, `token refresh failed: ${describeUpstreamFailure(res.status, res.body)}`, res.status);
  }
  return parseTokenResponse(res.body, "refresh_failed");
}

export interface RefreshedFields {
  tokens: Tokens;
  expired: string | null;
  lastRefresh: string;
  email: string | null;
  planType: string | null;
}

/** 把 token 回應合併到既有 token；回應沒帶新的 refresh/id token 就沿用舊的 */
export function applyTokenResponse(prev: Tokens, data: TokenResponse, now = Date.now()): RefreshedFields {
  const tokens: Tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || prev.refresh_token,
    id_token: data.id_token || prev.id_token,
  };
  const exp = data.expires_in ? now + data.expires_in * 1000 : (claimsOf(tokens.access_token).exp ?? 0) * 1000;
  const claims = claimsOf(tokens.id_token);
  return {
    tokens,
    expired: exp ? new Date(exp).toISOString() : null,
    lastRefresh: new Date(now).toISOString(),
    email: claims.email,
    planType: claims.planType,
  };
}
