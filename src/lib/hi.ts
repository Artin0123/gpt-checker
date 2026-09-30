// 送 "hi" 啟動額度窗口；請求格式參考 codex-tools proxy_service/warmup.rs
import {
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  CODEX_VERSION,
  RESPONSES_URL,
  UpstreamError,
  describeUpstreamFailure,
} from "./openai";
import { secondsUntilReset } from "./usage";
import type { Account, UsageSnapshot, UsageWindow } from "./types";

export const HI_MIN_RESET_SECONDS = 29 * 86400;
const HI_TIMEOUT_MS = 90_000;
const MAX_STREAM_BYTES = 1024 * 1024;

/** 條件：任一窗口剩 100%（used_percent == 0）且距離重置 ≥ 29 天 */
export function hiEligibleWindow(usage: UsageSnapshot, now = Date.now()): UsageWindow | null {
  for (const w of usage.windows) {
    if (w.usedPercent !== 0) continue;
    const left = secondsUntilReset(w, usage, now);
    if (left !== null && left >= HI_MIN_RESET_SECONDS) return w;
  }
  return null;
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

export async function sendHi(
  account: Pick<Account, "tokens" | "accountId">,
  opts: { model: string; effort: string | null },
): Promise<void> {
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
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError("hi_failed", `hi failed: ${describeUpstreamFailure(res.status, body)}`, res.status);
  }

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
        if (t.ok) return;
        throw new UpstreamError("hi_failed", `hi failed: ${t.message}`);
      }
      if (total > MAX_STREAM_BYTES) throw new UpstreamError("hi_failed", "hi stream exceeded 1 MiB without completion");
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw new UpstreamError("hi_failed", `hi stream error: ${(err as Error).message}`);
  } finally {
    reader.cancel().catch(() => { });
  }
  throw new UpstreamError("hi_failed", "hi stream ended without a terminal event");
}
