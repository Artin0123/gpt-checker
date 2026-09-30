// OAuth（照 CLIProxyAPI RequestCodexToken + oauth_callback.go）：
// PKCE 授權網址 → 使用者貼回 localhost callback 網址 → 換 token
// 在 Pages 端完成：auth.openai.com 從 Cloudflare edge 實測可連（被擋的只有 chatgpt.com）
// 註：裝置碼登入（deviceauth）帳號預設沒開，需使用者到 ChatGPT 安全性設定啟用，所以不採用，見 docs/plan.md
import type { Env } from "../env";
import { b64urlEncode, randomToken } from "./crypto";
import { claimsOf } from "./jwt";
import { AUTH_URL, CLIENT_ID, OAUTH_SCOPE, REDIRECT_URI, UpstreamError, describeUpstreamFailure } from "./openai";
import { applyTokenResponse, parseTokenResponse, postTokenEndpoint } from "./tokens";
import type { Credential } from "./types";

const SESSION_PREFIX = "oauth:";
export const OAUTH_TTL_SECONDS = 900;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface OAuthSession {
  codeVerifier: string;
  createdAt: number;
}

export class OAuthCallbackError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

export function buildAuthUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function startOAuth(env: Env, now = Date.now()): Promise<{ url: string; state: string }> {
  const state = randomToken(24);
  const codeVerifier = randomToken(64);
  const session: OAuthSession = { codeVerifier, createdAt: now };
  await env.ACCOUNTS.put(SESSION_PREFIX + state, JSON.stringify(session), { expirationTtl: OAUTH_TTL_SECONDS });
  return { url: buildAuthUrl(state, await pkceChallenge(codeVerifier)), state };
}

export interface CallbackInput {
  redirect_url?: unknown;
  code?: unknown;
  state?: unknown;
  error?: unknown;
}

/** 同 CPA handleOAuthCallback：先取欄位，再從 redirect_url 補缺的 */
export function parseCallback(input: CallbackInput): { state: string; code: string; error: string } {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  let state = s(input.state);
  let code = s(input.code);
  let error = s(input.error);
  const raw = s(input.redirect_url);
  if (raw) {
    let u: URL;
    try {
      // 容許只貼 path（/auth/callback?code=...）
      u = new URL(raw, "http://localhost");
    } catch {
      throw new OAuthCallbackError(400, "invalid redirect_url");
    }
    const q = u.searchParams;
    state ||= s(q.get("state"));
    code ||= s(q.get("code"));
    error ||= s(q.get("error")) || s(q.get("error_description"));
  }
  if (!state) throw new OAuthCallbackError(400, "state is required");
  if (!STATE_PATTERN.test(state)) throw new OAuthCallbackError(400, "invalid state");
  if (!code && !error) throw new OAuthCallbackError(400, "code or error is required");
  return { state, code, error };
}

async function exchangeCode(code: string, codeVerifier: string, now: number): Promise<Credential> {
  let res: { status: number; body: string };
  try {
    res = await postTokenEndpoint({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });
  } catch (err) {
    throw new UpstreamError("oauth_failed", `token exchange request failed: ${(err as Error).message}`);
  }
  if (res.status !== 200) throw new UpstreamError("oauth_failed", `token exchange failed: ${describeUpstreamFailure(res.status, res.body)}`);
  const data = parseTokenResponse(res.body, "oauth_failed");
  if (!data.refresh_token) throw new UpstreamError("oauth_failed", "token response missing refresh_token");
  const fields = applyTokenResponse({ access_token: "", refresh_token: "", id_token: "" }, data, now);
  const accountId = claimsOf(fields.tokens.id_token).accountId ?? claimsOf(fields.tokens.access_token).accountId;
  if (!accountId) throw new UpstreamError("oauth_failed", "id_token has no chatgpt_account_id");
  return { tokens: fields.tokens, accountId, email: fields.email, planType: fields.planType, expired: fields.expired, lastRefresh: fields.lastRefresh };
}

/**
 * 驗證 session 後換 token，回傳可寫入帳號的 Credential。
 * KV 用量：開始時寫 1 次；成功後刪除 session（重送會回 404）；失敗不寫，session 靠 TTL 過期。
 * 不另外記錄「交換中 / 失敗」狀態：authorization code 只能用一次，重送同一個 code 會被 OpenAI 拒絕。
 */
export async function completeOAuth(env: Env, input: CallbackInput, now = Date.now()): Promise<Credential> {
  const { state, code, error } = parseCallback(input);
  const key = SESSION_PREFIX + state;
  const session = await env.ACCOUNTS.get<OAuthSession>(key, "json");
  if (!session) throw new OAuthCallbackError(404, "unknown, expired or already used state");
  if (error) throw new OAuthCallbackError(502, `authorization failed: ${error}`);

  let cred: Credential;
  try {
    cred = await exchangeCode(code, session.codeVerifier, now);
  } catch (err) {
    throw new OAuthCallbackError(502, (err as Error).message);
  }
  await env.ACCOUNTS.delete(key);
  return cred;
}
