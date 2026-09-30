// 送 "hi" 啟動額度窗口；請求格式參考 codex-tools proxy_service/warmup.rs
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  CODEX_VERSION,
  RESPONSES_URL,
  UpstreamError,
  describeUpstreamFailure,
  isCloudflareBlock,
} from "./openai";
import type { Account, UsageSnapshot, UsageWindow } from "./types";

const HI_TIMEOUT_MS = 90_000;
const MAX_STREAM_BYTES = 1024 * 1024;
/** reset_at 與抓取時間可能差 1 秒（實測 2592001 vs 2592000），容許一點誤差 */
export const UNSTARTED_TOLERANCE_SECONDS = 10;

/**
 * 窗口還沒開始倒數：以「抓取當下」算，距離重置 == 窗口長度。
 * 實測（free / go 帳號）：沒用過的窗口每次查詢 reset_after_seconds 都等於 limit_window_seconds，
 * reset_at 跟著抓取時間往後移；一旦開始使用，reset_at 就固定下來，剩餘秒數開始變少。
 */
export function windowNotStarted(w: UsageWindow, usage: UsageSnapshot): boolean {
  if (w.windowSeconds === null) return false;
  const left = w.resetAfterSeconds ?? (w.resetAt !== null ? w.resetAt - usage.fetchedAt : null);
  return left !== null && left >= w.windowSeconds - UNSTARTED_TOLERANCE_SECONDS;
}

/**
 * 條件：任一窗口還沒開始倒數。不用看剩餘 %：用過就會開始倒數，沒倒數就一定是 100%。
 * 已經開始倒數（例如剛送過 hi，用量四捨五入後仍是 0）就不送，避免重送。
 */
export function hiEligibleWindow(usage: UsageSnapshot): UsageWindow | null {
  return usage.windows.find((w) => windowNotStarted(w, usage)) ?? null;
}

/** 逐塊解析 SSE；事件可能被切在不同 chunk */
export class SseParser {
  private buf = "";

  feed(chunk: string): unknown[] {
    this.buf = (this.buf + chunk).replace(/\r\n/g, "\n");
    const events: unknown[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data));
      } catch {
        // 忽略非 JSON 的 data
      }
    }
    return events;
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export type Terminal = { ok: true } | { ok: false; message: string };

/** 終止事件：completed/done（status completed）成功；failed/incomplete/cancelled/error 失敗 */
export function classifyEvent(event: unknown): Terminal | null {
  const ev = obj(event);
  const type = str(ev.type);
  const response = obj(ev.response);
  if (type === "response.completed" || type === "response.done") {
    const status = str(response.status);
    return !status || status === "completed" ? { ok: true } : { ok: false, message: `response ${status}` };
  }
  if (type === "response.failed" || type === "response.incomplete" || type === "response.cancelled" || type === "response.canceled") {
    const message =
      str(obj(response.error).message) ?? str(obj(response.incomplete_details).reason) ?? str(response.status) ?? type;
    return { ok: false, message: `${type}: ${message}` };
  }
  if (type === "error") {
    return { ok: false, message: `error: ${str(ev.message) ?? str(obj(ev.error).message) ?? str(ev.code) ?? "unknown"}` };
  }
  return null;
}

/** 只要求回 hi，讓回覆盡量短、少吃額度 */
export const HI_PROMPT = "only reply hi";

export function buildHiBody(model: string, effort: string | null) {
  return {
    model,
    instructions: "",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: HI_PROMPT }] }],
    stream: true,
    store: false,
    ...(effort ? { reasoning: { effort } } : {}),
  };
}

/**
 * 送 hi 的結果：請求送到 OpenAI、對方有回應就算送出，對方回報的錯誤（模型不支援、failed 事件等）
 * 只記在 upstreamError，不算失敗。只有 GHA 這邊的問題才 throw：連不上 / 逾時、被 Cloudflare 擋（請求沒進到 OpenAI）。
 */
export interface HiResult {
  /** 對方的 HTTP 狀態碼 */
  status: number;
  /** 對方回報的錯誤；null 代表正常完成 */
  upstreamError: string | null;
}

export async function sendHi(
  account: Pick<Account, "tokens" | "accountId">,
  opts: { model: string; effort: string | null },
): Promise<HiResult> {
  let res: Response;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.tokens.access_token}`,
        "ChatGPT-Account-Id": account.accountId,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "User-Agent": CODEX_USER_AGENT,
        Originator: CODEX_ORIGINATOR,
        Version: CODEX_VERSION,
        "session-id": crypto.randomUUID(),
      },
      body: JSON.stringify(buildHiBody(opts.model, opts.effort)),
      signal: AbortSignal.timeout(HI_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError("hi_failed", `hi request failed: ${(err as Error).message}`);
  }
  const status = res.status;
  const upstream = (message: string): HiResult => ({ status, upstreamError: message });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isCloudflareBlock(body)) throw new UpstreamError("hi_failed", `hi failed: ${describeUpstreamFailure(status, body)}`, status);
    return upstream(describeUpstreamFailure(status, body));
  }
  if (!res.body) return upstream("empty response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let total = 0;
  try {
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
        const t = classifyEvent(ev);
        if (!t) continue;
        return t.ok ? { status, upstreamError: null } : upstream(t.message);
      }
      if (total > MAX_STREAM_BYTES) return upstream("stream exceeded 1 MiB without completion");
    }
  } catch (err) {
    // 對方已經回 2xx 開始串流，請求已送達；中途斷線只記錄
    return upstream(`stream error: ${(err as Error).message}`);
  } finally {
    reader.cancel().catch(() => { });
  }
  return upstream("stream ended without a terminal event");
}
