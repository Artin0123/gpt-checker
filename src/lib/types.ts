export interface Tokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface UsageWindow {
  /** 來源欄位，例如 `primary`、`secondary`、`<limit_name>.primary` */
  name: string;
  usedPercent: number;
  windowSeconds: number | null;
  /** unix 秒 */
  resetAt: number | null;
  resetAfterSeconds: number | null;
}

export interface UsageSnapshot {
  /** unix 秒 */
  fetchedAt: number;
  planType: string | null;
  windows: UsageWindow[];
}

export type RunMode = "hi" | "usage";
export type RunStatus = "sent" | "skipped" | "failed" | "refreshed";

/** GHA 最近一次送 hi 流程的結果 */
export interface RunRecord {
  at: string;
  mode: RunMode;
  status: RunStatus;
  reason: string | null;
  /** 送 hi 時對方回報的錯誤（仍算已送出）；舊資料沒有這個欄位 */
  upstreamError?: string | null;
}

/**
 * KV `account:<id>`：身分與 token，只在匯入 / 登入 / refresh / 失效時寫入。
 * 額度、勾選這類常變動的資料不放這裡，避免每個帳號各寫一次（KV 免費方案每天只能寫 1,000 次）。
 */
export interface StoredAccount {
  id: string;
  email: string | null;
  accountId: string;
  planType: string | null;
  tokens: Tokens;
  /** access token 到期時間（ISO） */
  expired: string | null;
  lastRefresh: string | null;
  /** refresh token 已失效，需要重新登入 */
  invalid: boolean;
  invalidReason: string | null;
  addedAt: string;
  updatedAt: string;
}

/** KV `status` 裡每個帳號的額度結果：GHA 每次執行只整批寫一次 */
export interface AccountStatus {
  usage: UsageSnapshot | null;
  usageError: string | null;
  /** 最近一次送 hi 流程的結果（只查額度不會更新） */
  lastRun: RunRecord | null;
}

/** 合併 account + status + enabled 後的完整檢視 */
export interface Account extends StoredAccount, AccountStatus {
  /** 是否交給 GHA 處理（存在 KV `enabled`，面板上方「啟用 / 停用」按鈕整批設定） */
  enabled: boolean;
}

export type AccountSummary = Omit<Account, "tokens">;

/** 匯入 / OAuth 產生的標準化憑證 */
export interface Credential {
  tokens: Tokens;
  accountId: string;
  email: string | null;
  planType: string | null;
  expired: string | null;
  lastRefresh: string | null;
}
