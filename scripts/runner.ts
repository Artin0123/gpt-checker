// GHA 協調邏輯（可測試的純邏輯；入口在 scripts/gha-run.ts）
// 流程：面板取勾選帳號 → 需要時 refresh（新 token 立刻寫回）→ 查額度 → 符合條件送 hi → 再查額度
//      → 全部帳號跑完後，額度結果整批寫回一次 → Discord（只有送 hi 模式）
import { hiEligibleWindow, sendHi } from "../src/lib/hi";
import { UpstreamError } from "../src/lib/openai";
import { applyTokenResponse, needsRefresh, requestRefresh } from "../src/lib/tokens";
import { fetchUsage, secondsUntilReset } from "../src/lib/usage";
import type { Account, AccountStatus, RunMode, RunStatus, UsageSnapshot } from "../src/lib/types";
import type { TokenPatch } from "../src/routes/gha";

export interface Job {
  /** 啟用的帳號（含 token） */
  accounts: Account[];
  /** 面板上的手動執行模式 */
  manualMode: RunMode;
  /** 面板上設定的 Discord webhook */
  discordWebhook: string | null;
}

export interface PanelClient {
  fetchJob(): Promise<Job>;
  /** refresh 後立刻寫回 token（每個帳號最多一次 KV 寫入） */
  patchTokens(id: string, patch: TokenPatch): Promise<{ tokensApplied: boolean }>;
  /** 整批寫回額度結果（一次 KV 寫入） */
  putStatus(updates: Record<string, Partial<AccountStatus>>): Promise<void>;
}

export interface RunOptions {
  mode: RunMode;
  model: string;
  effort: string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AccountResult {
  id: string;
  label: string;
  status: RunStatus;
  reason: string;
  usage: UsageSnapshot | null;
  anomalies: string[];
  /** 送 hi 時對方回報的錯誤（仍算已送出，不列為異常） */
  upstreamError: string | null;
  /** 要寫回面板的額度結果；null 表示不用寫（例如已失效的帳號） */
  statusUpdate: Partial<AccountStatus> | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 寫回面板失敗會讓新 refresh token 遺失，所以重試幾次 */
async function withRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

export async function runAccount(panel: PanelClient, account: Account, opts: RunOptions): Promise<AccountResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const label = account.email ?? account.accountId;
  const result: AccountResult = {
    id: account.id,
    label,
    status: "failed",
    reason: "",
    usage: account.usage,
    anomalies: [],
    upstreamError: null,
    statusUpdate: null,
  };

  if (account.invalid) {
    result.reason = `refresh token 已失效，請重新登入或匯入（${account.invalidReason ?? "unknown"}）`;
    result.anomalies.push(result.reason);
    return result;
  }

  let current = account;
  const chain = account.tokens.refresh_token;

  const refresh = async () => {
    try {
      const data = await requestRefresh(current.tokens.refresh_token);
      const fields = applyTokenResponse(current.tokens, data, now());
      current = { ...current, ...fields, email: fields.email ?? current.email, planType: fields.planType ?? current.planType };
      try {
        const { tokensApplied } = await withRetry(
          () => panel.patchTokens(account.id, { expectRefreshToken: chain, ...fields, invalid: false, invalidReason: null }),
          sleep,
        );
        if (!tokensApplied) result.anomalies.push("面板上的 token 在執行期間被更新，本次刷新的 token 未寫回");
      } catch (err) {
        throw new UpstreamError("refresh_failed", `token 已刷新但寫回面板失敗，帳號可能需要重新登入：${(err as Error).message}`);
      }
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "refresh_invalid") {
        await withRetry(() => panel.patchTokens(account.id, { expectRefreshToken: chain, invalid: true, invalidReason: err.message }), sleep).catch(
          () => { },
        );
      }
      throw err;
    }
  };

  const usageWithRetry = async () => {
    try {
      return await fetchUsage(current, now());
    } catch (err) {
      // 401 代表 access token 被撤銷或過期：強制 refresh 後重試一次
      if (err instanceof UpstreamError && err.status === 401) {
        await refresh();
        return fetchUsage(current, now());
      }
      throw err;
    }
  };

  const lastRun = (status: RunStatus, reason: string) =>
    // lastRun 只記錄送 hi 流程；只查額度不覆蓋
    opts.mode === "hi"
      ? { lastRun: { at: new Date(now()).toISOString(), mode: opts.mode, status, reason, upstreamError: result.upstreamError } }
      : {};

  try {
    if (needsRefresh(current, now())) await refresh();

    let usage = await usageWithRetry();
    result.usage = usage;

    if (opts.mode === "usage") {
      result.status = "refreshed";
      result.reason = "已查詢額度";
    } else {
      const w = hiEligibleWindow(usage);
      if (!w) {
        result.status = "skipped";
        result.reason = usage.windows.length ? "窗口已開始倒數，不用再送" : "沒有額度窗口，不用送";
      } else {
        // 對方回報錯誤仍算已送出（見 HiResult）；只有 401 代表 token 問題，refresh 後重送一次
        let hi = await sendHi(current, { model: opts.model, effort: opts.effort });
        if (hi.status === 401) {
          await refresh();
          hi = await sendHi(current, { model: opts.model, effort: opts.effort });
        }
        result.status = "sent";
        result.upstreamError = hi.upstreamError;
        result.reason = hi.upstreamError
          ? `已送 hi（窗口 ${w.name}；對方回報錯誤，仍算送出：${hi.upstreamError}）`
          : `已送 hi（窗口 ${w.name}）`;
        await sleep(3000);
        try {
          usage = await usageWithRetry();
          result.usage = usage;
        } catch (err) {
          result.anomalies.push(`送 hi 後重新查額度失敗：${(err as Error).message}`);
        }
      }
    }
    result.statusUpdate = { usage: result.usage, usageError: null, ...lastRun(result.status, result.reason) };
    return result;
  } catch (err) {
    const message = (err as Error).message;
    result.status = "failed";
    result.reason = message;
    result.anomalies.unshift(message);
    result.statusUpdate = { usageError: message, ...lastRun("failed", message) };
    return result;
  }
}

/** 排程固定查額度＋送 hi；手動執行（workflow_dispatch）依面板上的開關 */
export function resolveMode(trigger: "schedule" | "manual", job: Pick<Job, "manualMode">): RunMode {
  return trigger === "schedule" ? "hi" : job.manualMode;
}

export async function runAll(panel: PanelClient, job: Job, opts: RunOptions): Promise<AccountResult[]> {
  const sleep = opts.sleep ?? defaultSleep;
  const results: AccountResult[] = [];
  // 逐一處理：避免同時打上游，單一帳號失敗不影響其他帳號
  for (const a of job.accounts) results.push(await runAccount(panel, a, opts));

  const updates: Record<string, Partial<AccountStatus>> = {};
  for (const r of results) if (r.statusUpdate) updates[r.id] = r.statusUpdate;
  if (Object.keys(updates).length) {
    await withRetry(() => panel.putStatus(updates), sleep).catch((err) => {
      for (const r of results) r.anomalies.push(`額度結果寫回面板失敗：${(err as Error).message}`);
    });
  }
  return results;
}

// ---------- Discord ----------

const COLOR = { anomaly: 0xdc2626, sent: 0x16a34a, skipped: 0x6b7280, refreshed: 0x2563eb, failed: 0xdc2626 };
const STATUS_TEXT: Record<RunStatus, string> = { sent: "✅ 已送 hi", skipped: "⏭️ 略過", failed: "❌ 失敗", refreshed: "🔄 已查詢" };

function fmtDuration(seconds: number | null): string {
  if (seconds === null) return "?";
  if (seconds >= 86400) return `${(seconds / 86400).toFixed(1)} 天`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} 小時`;
  return `${Math.max(0, Math.round(seconds / 60))} 分`;
}

export function describeUsage(usage: UsageSnapshot | null, now = Date.now()): string {
  if (!usage) return "無額度資料";
  if (usage.windows.length === 0) return "無額度窗口";
  return usage.windows
    .map((w) => {
      const left = secondsUntilReset(w, usage, now);
      const at = w.resetAt ? `<t:${Math.floor(w.resetAt)}:f>` : left !== null ? `<t:${Math.floor(now / 1000 + left)}:f>` : "?";
      return `剩 **${Math.round((100 - w.usedPercent) * 10) / 10}%** · ${w.name} · 重置 ${at}（${fmtDuration(left)}後）`;
    })
    .join("\n");
}

export function buildDiscordMessages(results: AccountResult[], opts: { runUrl?: string; now?: number }) {
  const now = opts.now ?? Date.now();
  const sorted = [...results].sort((a, b) => Number(b.anomalies.length > 0) - Number(a.anomalies.length > 0));
  const embeds = sorted.map((r) => {
    const anomaly = r.anomalies.length > 0;
    const lines = [`${STATUS_TEXT[r.status]}：${r.reason}`, describeUsage(r.usage, now)];
    if (anomaly) lines.push(...r.anomalies.filter((m) => m !== r.reason).map((m) => `⚠️ ${m}`));
    return {
      title: `${anomaly ? "⚠️ " : ""}${r.label}`.slice(0, 256),
      description: lines.join("\n").slice(0, 4000),
      color: anomaly ? COLOR.anomaly : COLOR[r.status],
    };
  });
  const count = (s: RunStatus) => results.filter((r) => r.status === s).length;
  const anomalies = results.filter((r) => r.anomalies.length > 0).length;
  const summary =
    `**GPT Checker** 已送 ${count("sent")}、略過 ${count("skipped")}、失敗 ${count("failed")}` +
    (anomalies ? `，⚠️ 異常 ${anomalies}` : "") +
    (opts.runUrl ? `\n${opts.runUrl}` : "");
  const messages = [];
  for (let i = 0; i < Math.max(1, embeds.length); i += 10) {
    messages.push({ content: i === 0 ? summary : undefined, embeds: embeds.slice(i, i + 10), allowed_mentions: { parse: [] } });
  }
  return messages;
}

/** 只有送 hi 模式通知 Discord；只查額度模式即使有異常也不通知（結果看面板 / GHA log） */
export function shouldNotify(mode: RunMode): boolean {
  return mode === "hi";
}

export async function postDiscord(webhookUrl: string, message: unknown, sleep = defaultSleep): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) });
    if (res.ok) return;
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
      continue;
    }
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("Discord webhook rate limited");
}

// ---------- 面板 API client ----------

export function panelClient(baseUrl: string, password: string): PanelClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${password}`, "Content-Type": "application/json" };
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`panel ${init.method ?? "GET"} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  return {
    async fetchJob() {
      const data = await call("/api/gha/accounts");
      return {
        accounts: data.accounts,
        manualMode: data.manualMode === "hi" ? "hi" : "usage",
        discordWebhook: typeof data.discordWebhook === "string" && data.discordWebhook ? data.discordWebhook : null,
      };
    },
    async patchTokens(id, patch) {
      return call(`/api/gha/accounts/${encodeURIComponent(id)}/tokens`, { method: "PATCH", body: JSON.stringify(patch) });
    },
    async putStatus(updates) {
      await call("/api/gha/status", { method: "POST", body: JSON.stringify({ updates }) });
    },
  };
}
