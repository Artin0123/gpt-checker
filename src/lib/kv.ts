// KV 存取層。免費方案限制（https://developers.cloudflare.com/kv/platform/pricing/ ）：
// 每天寫入 1,000、刪除 1,000、list 1,000、讀取 100,000；同一個 key 每秒最多寫 1 次。
// 設計原則：常變動的資料集中在少數 key、整批寫一次；沒變就不寫；不在一般路徑呼叫 list()。
//
// key 配置：
//   account:<id>     StoredAccount（token，只在匯入 / 登入 / refresh / 失效時寫）
//   index:accounts   帳號 id 陣列（新增 / 刪除帳號時寫）
//   enabled          啟用（交給 GHA）的帳號 id 陣列（按「啟用 / 停用」時整批寫一次）
//   status           { [id]: AccountStatus }（GHA 每次執行整批寫一次）
//   config           PanelConfig（repo 網址、手動執行模式、Discord webhook）
//   oauth:<state>    OAuth PKCE session（TTL 15 分鐘）
import type { Env } from "../env";
import { b64urlEncode, sha256 } from "./crypto";
import type { Account, AccountStatus, AccountSummary, Credential, RunMode, StoredAccount } from "./types";

const ACCOUNT_PREFIX = "account:";
const INDEX_KEY = "index:accounts";
const ENABLED_KEY = "enabled";
/** 上一版的 key 名稱，讀取時相容 */
const LEGACY_SELECTION_KEY = "selection";
const STATUS_KEY = "status";
const CONFIG_KEY = "config";

export interface PanelConfig {
  /** GitHub repo 網址（https://github.com/<owner>/<repo>）；面板按鈕開啟 actions/workflows/hi.yml */
  repoUrl: string | null;
  /** 手動執行 GHA 時要做什麼；排程固定是 "hi" */
  manualMode: RunMode;
  /** Discord webhook 網址；只回傳給 GHA（Bearer），面板只看得到是否已設定 */
  discordWebhook: string | null;
}

/** 以 accountId + email 產生穩定 id，同一帳號重複匯入會覆蓋 */
export async function accountIdFor(accountId: string, email: string | null): Promise<string> {
  const digest = await sha256(`${accountId}|${(email ?? "").toLowerCase()}`);
  return b64urlEncode(digest.slice(0, 12));
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------- 單一帳號（token） ----------

type LegacyAccount = StoredAccount & Partial<AccountStatus> & { selected?: boolean };

/** 只保留 StoredAccount 欄位（舊版資料可能還帶 usage / selected） */
function toStored(a: LegacyAccount): StoredAccount {
  return {
    id: a.id,
    email: a.email ?? null,
    accountId: a.accountId,
    planType: a.planType ?? null,
    tokens: a.tokens,
    expired: a.expired ?? null,
    lastRefresh: a.lastRefresh ?? null,
    invalid: !!a.invalid,
    invalidReason: a.invalidReason ?? null,
    addedAt: a.addedAt,
    updatedAt: a.updatedAt,
  };
}

async function getLegacy(env: Env, id: string): Promise<LegacyAccount | null> {
  return (await env.ACCOUNTS.get<LegacyAccount>(ACCOUNT_PREFIX + id, "json")) ?? null;
}

export async function getStored(env: Env, id: string): Promise<StoredAccount | null> {
  const a = await getLegacy(env, id);
  return a ? toStored(a) : null;
}

async function putStored(env: Env, account: StoredAccount): Promise<void> {
  await env.ACCOUNTS.put(ACCOUNT_PREFIX + account.id, JSON.stringify(account));
}

/** 重新讀取最新資料後套用修改；內容沒變就不寫 */
export async function updateStored(env: Env, id: string, mutate: (a: StoredAccount) => void): Promise<StoredAccount | null> {
  const latest = await getStored(env, id);
  if (!latest) return null;
  const before = JSON.stringify(latest);
  mutate(latest);
  if (JSON.stringify(latest) === before) return latest;
  latest.updatedAt = new Date().toISOString();
  await putStored(env, latest);
  return latest;
}

// ---------- 索引 ----------

/**
 * 帳號 id 清單。KV list() 每天只能 1,000 次而且更新有延遲，所以一般路徑只讀索引；
 * 只有索引不存在時（舊資料、第一次使用）才用 list() 重建一次。
 */
async function readIndex(env: Env): Promise<string[]> {
  const ids = await env.ACCOUNTS.get<string[]>(INDEX_KEY, "json");
  if (Array.isArray(ids)) return ids;
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ACCOUNTS.list({ prefix: ACCOUNT_PREFIX, cursor });
    for (const k of page.keys) found.push(k.name.slice(ACCOUNT_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  await env.ACCOUNTS.put(INDEX_KEY, JSON.stringify(found));
  return found;
}

async function updateIndex(env: Env, mutate: (ids: Set<string>) => void): Promise<void> {
  const current = await readIndex(env);
  const ids = new Set(current);
  mutate(ids);
  const next = [...ids];
  if (!sameJson(next, current)) await env.ACCOUNTS.put(INDEX_KEY, JSON.stringify(next));
}

// ---------- 啟用 / 狀態 ----------

/** null 表示還沒存過（舊資料）：沿用上一版的 selection key 或帳號上的 selected */
async function readEnabled(env: Env): Promise<string[] | null> {
  const ids = await env.ACCOUNTS.get<string[]>(ENABLED_KEY, "json");
  if (Array.isArray(ids)) return ids;
  const legacy = await env.ACCOUNTS.get<string[]>(LEGACY_SELECTION_KEY, "json");
  return Array.isArray(legacy) ? legacy : null;
}

/** 把指定帳號設成啟用或停用（整批一次寫入）；結果和現在一樣就不寫 */
export async function setEnabled(env: Env, ids: string[], enabled: boolean): Promise<string[]> {
  const accounts = await listAccounts(env);
  const known = new Set(accounts.map((a) => a.id));
  const current = accounts.filter((a) => a.enabled).map((a) => a.id).sort();
  const set = new Set(current);
  for (const id of ids) {
    if (!known.has(id)) continue;
    if (enabled) set.add(id);
    else set.delete(id);
  }
  const next = [...set].sort();
  const stored = await env.ACCOUNTS.get<string[]>(ENABLED_KEY, "json");
  if (!Array.isArray(stored) || !sameJson(next, current)) await env.ACCOUNTS.put(ENABLED_KEY, JSON.stringify(next));
  return next;
}

type StatusMap = Record<string, AccountStatus>;

async function readStatus(env: Env): Promise<StatusMap> {
  const s = await env.ACCOUNTS.get<StatusMap>(STATUS_KEY, "json");
  return s && typeof s === "object" ? s : {};
}

/** GHA 整批寫回額度結果（一次執行一次寫入）；只保留還存在的帳號 */
export async function mergeStatus(env: Env, updates: Record<string, Partial<AccountStatus>>): Promise<void> {
  const known = new Set(await readIndex(env));
  const current = await readStatus(env);
  const next: StatusMap = {};
  for (const id of known) {
    const base = current[id] ?? { usage: null, usageError: null, lastRun: null };
    next[id] = { ...base, ...(updates[id] ?? {}) };
  }
  if (!sameJson(next, current)) await env.ACCOUNTS.put(STATUS_KEY, JSON.stringify(next));
}

// ---------- 組合檢視 ----------

const EMPTY_STATUS: AccountStatus = { usage: null, usageError: null, lastRun: null };

export async function listAccounts(env: Env): Promise<Account[]> {
  const [ids, enabledIds, status] = await Promise.all([readIndex(env), readEnabled(env), readStatus(env)]);
  const raw = await Promise.all(ids.map((id) => getLegacy(env, id)));
  const enabled = new Set(enabledIds ?? []);
  return raw
    .filter((a): a is LegacyAccount => !!a)
    .map((a) => {
      // 舊版資料把 usage / selected 存在帳號裡：新 key 沒有時沿用
      const st = status[a.id] ?? { usage: a.usage ?? null, usageError: a.usageError ?? null, lastRun: a.lastRun ?? null };
      return { ...toStored(a), ...EMPTY_STATUS, ...st, enabled: enabledIds ? enabled.has(a.id) : !!a.selected };
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
}

export function toSummary(account: Account): AccountSummary {
  const { tokens: _tokens, ...rest } = account;
  return rest;
}

// ---------- 新增 / 刪除 ----------

/**
 * 整批寫入或覆蓋帳號：每個有變動的帳號寫一次，索引最多寫一次。
 * 覆蓋時保留 addedAt，並清除失效狀態；內容完全相同的帳號不寫。
 */
export async function upsertCredentials(env: Env, creds: Credential[], now = new Date()): Promise<StoredAccount[]> {
  const ts = now.toISOString();
  const out: StoredAccount[] = [];
  const newIds: string[] = [];
  const seen = new Map<string, StoredAccount>();
  for (const cred of creds) {
    const id = await accountIdFor(cred.accountId, cred.email);
    const existing = seen.get(id) ?? (await getStored(env, id));
    const next: StoredAccount = {
      id,
      email: cred.email,
      accountId: cred.accountId,
      planType: cred.planType ?? existing?.planType ?? null,
      tokens: cred.tokens,
      expired: cred.expired,
      lastRefresh: cred.lastRefresh ?? existing?.lastRefresh ?? null,
      invalid: false,
      invalidReason: null,
      addedAt: existing?.addedAt ?? ts,
      updatedAt: existing?.updatedAt ?? ts,
    };
    const unchanged = existing && sameJson({ ...next, updatedAt: "" }, { ...existing, updatedAt: "" });
    if (!unchanged) {
      next.updatedAt = ts;
      await putStored(env, next);
    }
    if (!existing) newIds.push(id);
    seen.set(id, next);
    out.push(next);
  }
  if (newIds.length) await updateIndex(env, (ids) => newIds.forEach((id) => ids.add(id)));
  return out;
}

/** 整批刪除：每個帳號刪 1 次、索引寫 1 次；enabled / status 裡殘留的 id 讀取時會被忽略 */
export async function deleteAccounts(env: Env, ids: string[]): Promise<string[]> {
  const known = new Set(await readIndex(env));
  const targets = [...new Set(ids)].filter((id) => known.has(id));
  for (const id of targets) await env.ACCOUNTS.delete(ACCOUNT_PREFIX + id);
  if (targets.length) await updateIndex(env, (set) => targets.forEach((id) => set.delete(id)));
  return targets;
}

// ---------- 設定 ----------

/** 接受 https://github.com/<owner>/<repo> 開頭的任何網址（例如 actions 頁），正規化成 repo 網址 */
export function normalizeRepoUrl(value: string): string | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/.exec(value.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** 只接受 Discord 官方 webhook 網址 */
export function isDiscordWebhook(value: string): boolean {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(value);
}

export async function getConfig(env: Env): Promise<PanelConfig> {
  const c = await env.ACCOUNTS.get<Partial<PanelConfig> & { ghaUrl?: string }>(CONFIG_KEY, "json");
  const rawRepo = c?.repoUrl ?? c?.ghaUrl ?? null;
  return {
    repoUrl: rawRepo ? normalizeRepoUrl(rawRepo) : null,
    // 預設只查額度：不會消耗額度也不發通知，要送 hi 必須明確切換
    manualMode: c?.manualMode === "hi" ? "hi" : "usage",
    discordWebhook: c?.discordWebhook && isDiscordWebhook(c.discordWebhook) ? c.discordWebhook : null,
  };
}

/** 部分更新；合併後和現在一樣就不寫（前端也會合併連續切換後才送） */
export async function updateConfig(env: Env, patch: Partial<PanelConfig>): Promise<PanelConfig> {
  const raw = await env.ACCOUNTS.get(CONFIG_KEY);
  const next = { ...(await getConfig(env)), ...patch };
  const serialized = JSON.stringify(next);
  if (raw !== serialized) await env.ACCOUNTS.put(CONFIG_KEY, serialized);
  return next;
}

/** 給面板看的設定（面板本身有密碼保護，且匯出本來就含 token，所以 webhook 直接回傳讓欄位保留） */
export function publicConfig(c: PanelConfig) {
  return { repoUrl: c.repoUrl, manualMode: c.manualMode, discordWebhook: c.discordWebhook };
}
