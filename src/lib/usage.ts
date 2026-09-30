// 純函式：由 GHA 腳本呼叫（Cloudflare Workers 打 chatgpt.com 會被 403 擋，見 docs/plan.md）
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  UPSTREAM_TIMEOUT_MS,
  USAGE_URL,
  UpstreamError,
  describeUpstreamFailure,
} from "./openai";
import type { Account, UsageSnapshot, UsageWindow } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseWindow(name: string, raw: unknown): UsageWindow | null {
  if (!isObj(raw)) return null;
  const usedPercent = num(raw.used_percent);
  if (usedPercent === null) return null;
  return {
    name,
    usedPercent,
    windowSeconds: num(raw.limit_window_seconds),
    resetAt: num(raw.reset_at),
    resetAfterSeconds: num(raw.reset_after_seconds),
  };
}

/** 整理 wham/usage 回應：primary / secondary / additional_rate_limits[] 全部攤平 */
export function parseUsage(payload: unknown, now = Date.now()): UsageSnapshot {
  const p = isObj(payload) ? payload : {};
  const windows: UsageWindow[] = [];
  const collect = (prefix: string, rl: unknown) => {
    if (!isObj(rl)) return;
    for (const key of ["primary_window", "secondary_window"] as const) {
      const w = parseWindow(`${prefix}${key.replace("_window", "")}`, rl[key]);
      if (w) windows.push(w);
    }
  };
  collect("", p.rate_limit);
  if (Array.isArray(p.additional_rate_limits)) {
    p.additional_rate_limits.forEach((item, i) => {
      if (!isObj(item)) return;
      const label = typeof item.limit_name === "string" ? item.limit_name : `additional[${i}]`;
      collect(`${label}.`, item.rate_limit);
    });
  }
  return {
    fetchedAt: Math.floor(now / 1000),
    planType: typeof p.plan_type === "string" ? p.plan_type : null,
    windows,
  };
}

/** 距離重置的秒數：優先 reset_after_seconds（以抓取時間校正），否則 reset_at - now */
export function secondsUntilReset(w: UsageWindow, snapshot: UsageSnapshot, now = Date.now()): number | null {
  const nowSec = Math.floor(now / 1000);
  if (w.resetAfterSeconds !== null) return w.resetAfterSeconds - (nowSec - snapshot.fetchedAt);
  if (w.resetAt !== null) return w.resetAt - nowSec;
  return null;
}

export async function fetchUsage(account: Pick<Account, "tokens" | "accountId">, now = Date.now()): Promise<UsageSnapshot> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${account.tokens.access_token}`,
        "ChatGPT-Account-Id": account.accountId,
        Accept: "application/json",
        "User-Agent": CODEX_USER_AGENT,
        Originator: CODEX_ORIGINATOR,
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    body = await res.text();
  } catch (err) {
    throw new UpstreamError("usage_failed", `usage request failed: ${(err as Error).message}`);
  }
  if (res.status !== 200) {
    throw new UpstreamError("usage_failed", `usage fetch failed: ${describeUpstreamFailure(res.status, body)}`, res.status);
  }
  try {
    return parseUsage(JSON.parse(body), now);
  } catch {
    throw new UpstreamError("usage_failed", "usage response is not JSON");
  }
}
