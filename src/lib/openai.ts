// OpenAI / Codex 常數
// OAuth：出自 CLIProxyAPI internal/auth/codex/openai_auth.go
// usage / responses：出自 codex-tools src-tauri/src/usage.rs、proxy_service/warmup.rs

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OAUTH_SCOPE = "openid email profile offline_access";
export const REFRESH_SCOPE = "openid profile email";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export const CODEX_VERSION = "0.155.1";
export const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_VERSION}`;
export const CODEX_ORIGINATOR = "codex_cli_rs";

/** codex-tools DEFAULT_API_PROXY_MODEL */
export const DEFAULT_HI_MODEL = "gpt-6-luna";

export const UPSTREAM_TIMEOUT_MS = 25_000;

export type UpstreamErrorKind = "refresh_invalid" | "refresh_failed" | "usage_failed" | "hi_failed" | "oauth_failed";

export class UpstreamError extends Error {
  constructor(
    public kind: UpstreamErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** 被 Cloudflare 擋下的頁面：請求沒有進到 OpenAI，是執行環境（IP）的問題 */
export function isCloudflareBlock(body: string): boolean {
  // 實測：Cloudflare Workers（本機 workerd 與 edge）打 chatgpt.com 會拿到 403「Unable to load site」
  return /cf-chl|challenge-platform|Just a moment|cf_clearance|Unable to load site/i.test(body);
}

/** 將上游錯誤回應整理成短訊息；偵測 Cloudflare 擋下的頁面 */
export function describeUpstreamFailure(status: number, body: string): string {
  if (isCloudflareBlock(body)) {
    return `blocked by Cloudflare (HTTP ${status})`;
  }
  const compact = body.replace(/\s+/g, " ").trim().slice(0, 240);
  return `HTTP ${status}${compact ? `: ${compact}` : ""}`;
}
