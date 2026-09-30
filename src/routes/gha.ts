// 給 GHA 腳本用的端點：只接受 Bearer（不接受瀏覽器 cookie），會回傳 token
// KV 寫入：token 只在 refresh / 失效時逐帳號寫（必須立刻保存）；額度結果整批寫一次（見 lib/kv.ts）
import { HttpError, json, readJson } from "../http";
import { isObj } from "../lib/json";
import { getConfig, listAccounts, mergeStatus, updateStored } from "../lib/kv";
import type { AccountStatus, RunRecord, Tokens, UsageSnapshot } from "../lib/types";
import type { Handler } from "../router";

function requireBearer(request: Request) {
  // 路由層已驗證密碼；這裡再確認是 Bearer，避免瀏覽器 session 拿到 token
  if (!/^Bearer\s+/i.test(request.headers.get("Authorization") ?? "")) {
    throw new HttpError(403, "this endpoint requires Bearer auth");
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/**
 * 啟用的帳號（含 token）、手動執行模式、Discord webhook。
 * 已失效的帳號也回傳，讓腳本列入結果。
 */
export const ghaListRoute: Handler = async ({ request, env }) => {
  requireBearer(request);
  const [accounts, config] = await Promise.all([listAccounts(env), getConfig(env)]);
  return json({ accounts: accounts.filter((a) => a.enabled), manualMode: config.manualMode, discordWebhook: config.discordWebhook });
};

export interface TokenPatch {
  /** 腳本讀取時的 refresh_token；與 KV 不同代表期間被重新匯入 / 登入，此時不覆寫 */
  expectRefreshToken: string;
  tokens?: Tokens;
  expired?: string | null;
  lastRefresh?: string | null;
  email?: string | null;
  planType?: string | null;
  invalid?: boolean;
  invalidReason?: string | null;
}

function validateTokenPatch(body: unknown): TokenPatch {
  if (!isObj(body)) throw new HttpError(400, "body must be an object");
  if (!isStr(body.expectRefreshToken)) throw new HttpError(400, "expectRefreshToken is required");
  if (body.tokens !== undefined) {
    const t = body.tokens;
    if (!isObj(t) || !isStr(t.access_token) || !isStr(t.refresh_token) || !isStr(t.id_token) || !t.refresh_token) {
      throw new HttpError(400, "invalid tokens");
    }
  }
  for (const k of ["expired", "lastRefresh", "email", "planType", "invalidReason"]) {
    if (body[k] !== undefined && !isStrOrNull(body[k])) throw new HttpError(400, `invalid ${k}`);
  }
  if (body.invalid !== undefined && typeof body.invalid !== "boolean") throw new HttpError(400, "invalid invalid");
  return body as unknown as TokenPatch;
}

/** refresh 後立刻寫回新 token（每次 refresh 舊 refresh token 就失效，不能等到最後） */
export const ghaTokenRoute: Handler = async ({ request, env, params }) => {
  requireBearer(request);
  const patch = validateTokenPatch(await readJson(request));
  let applied = false;
  const found = await updateStored(env, params.id, (a) => {
    if (a.tokens.refresh_token !== patch.expectRefreshToken) return;
    applied = true;
    if (patch.tokens) a.tokens = patch.tokens;
    if (patch.expired !== undefined) a.expired = patch.expired;
    if (patch.lastRefresh !== undefined) a.lastRefresh = patch.lastRefresh;
    if (patch.email) a.email = patch.email;
    if (patch.planType) a.planType = patch.planType;
    if (patch.invalid !== undefined) a.invalid = patch.invalid;
    if (patch.invalidReason !== undefined) a.invalidReason = patch.invalidReason;
  });
  if (!found) throw new HttpError(404, "account not found");
  return json({ tokensApplied: applied });
};

function validateStatus(raw: unknown): Partial<AccountStatus> {
  if (!isObj(raw)) throw new HttpError(400, "invalid status entry");
  const out: Partial<AccountStatus> = {};
  if (raw.usage !== undefined) {
    if (raw.usage !== null && (!isObj(raw.usage) || !Array.isArray((raw.usage as unknown as UsageSnapshot).windows))) {
      throw new HttpError(400, "invalid usage");
    }
    out.usage = raw.usage as UsageSnapshot | null;
  }
  if (raw.usageError !== undefined) {
    if (!isStrOrNull(raw.usageError)) throw new HttpError(400, "invalid usageError");
    out.usageError = raw.usageError as string | null;
  }
  if (raw.lastRun !== undefined) {
    if (raw.lastRun !== null && (!isObj(raw.lastRun) || !isStr(raw.lastRun.at) || !isStr(raw.lastRun.status))) {
      throw new HttpError(400, "invalid lastRun");
    }
    out.lastRun = raw.lastRun as RunRecord | null;
  }
  return out;
}

/** 一次執行的所有額度結果整批寫回（KV 一次寫入） */
export const ghaStatusRoute: Handler = async ({ request, env }) => {
  requireBearer(request);
  const body = await readJson<{ updates?: unknown }>(request);
  if (!isObj(body?.updates)) throw new HttpError(400, "updates must be an object");
  const updates: Record<string, Partial<AccountStatus>> = {};
  for (const [id, raw] of Object.entries(body.updates)) updates[id] = validateStatus(raw);
  await mergeStatus(env, updates);
  return json({ ok: true });
};
