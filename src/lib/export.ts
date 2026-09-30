import type { StoredAccount } from "./types";

/** CLIProxyAPI 憑證檔（internal/auth/codex/token.go） */
export function toCpa(a: StoredAccount) {
  return {
    id_token: a.tokens.id_token,
    access_token: a.tokens.access_token,
    refresh_token: a.tokens.refresh_token,
    account_id: a.accountId,
    last_refresh: a.lastRefresh ?? "",
    email: a.email ?? "",
    type: "codex",
    expired: a.expired ?? "",
    ...(a.planType ? { plan_type: a.planType } : {}),
  };
}

/** 檔名只留安全字元 */
export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 100) || "account";
}
