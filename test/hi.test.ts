import { afterEach, describe, expect, it, vi } from "vitest";
import { HI_MIN_RESET_SECONDS, SseParser, buildHiBody, classifyEvent, hiEligibleWindow, sendHi } from "../src/lib/hi";
import { RESPONSES_URL } from "../src/lib/openai";
import type { UsageSnapshot } from "../src/lib/types";
import { mockFetch } from "./fetch-mock";

afterEach(() => vi.unstubAllGlobals());

const NOW = 1_800_000_000_000;
const snap = (windows: Partial<UsageSnapshot["windows"][number]>[]): UsageSnapshot => ({
  fetchedAt: NOW / 1000,
  planType: "free",
  windows: windows.map((w, i) => ({ name: `w${i}`, usedPercent: 0, windowSeconds: 2592000, resetAt: null, resetAfterSeconds: null, ...w })),
});

describe("hiEligibleWindow", () => {
  it("剛好 29 天符合、少 1 秒不符合", () => {
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: HI_MIN_RESET_SECONDS }]), NOW)).not.toBeNull();
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: HI_MIN_RESET_SECONDS - 1 }]), NOW)).toBeNull();
  });

  it("用了 1%（剩 99%）不符合", () => {
    expect(hiEligibleWindow(snap([{ usedPercent: 1, resetAfterSeconds: 2592000 }]), NOW)).toBeNull();
  });

  it("沒有窗口、沒有重置時間都不符合", () => {
    expect(hiEligibleWindow(snap([]), NOW)).toBeNull();
    expect(hiEligibleWindow(snap([{}]), NOW)).toBeNull();
  });

  it("沒有 reset_after_seconds 時用 reset_at；任一窗口符合即可", () => {
    const s = snap([{ usedPercent: 50, resetAfterSeconds: 2592000 }, { name: "x", resetAt: NOW / 1000 + 30 * 86400 }]);
    expect(hiEligibleWindow(s, NOW)?.name).toBe("x");
  });

  it("reset_after_seconds 會扣掉抓取後經過的時間", () => {
    const s = snap([{ resetAfterSeconds: HI_MIN_RESET_SECONDS + 10 }]);
    expect(hiEligibleWindow(s, NOW + 11_000)).toBeNull();
  });
});

describe("SSE", () => {
  it("事件被切在不同 chunk、CRLF、[DONE]", () => {
    const p = new SseParser();
    expect(p.feed('event: response.created\ndata: {"type":"response.cr')).toEqual([]);
    expect(p.feed('eated"}\r\n\r\ndata: [DONE]\n\ndata: {"type":"x"}\n')).toEqual([{ type: "response.created" }]);
    expect(p.feed("\n")).toEqual([{ type: "x" }]);
  });

  it("classifyEvent", () => {
    expect(classifyEvent({ type: "response.output_text.delta" })).toBeNull();
    expect(classifyEvent({ type: "response.completed", response: { status: "completed" } })).toEqual({ ok: true });
    expect(classifyEvent({ type: "response.done" })).toEqual({ ok: true });
    expect(classifyEvent({ type: "response.failed", response: { error: { message: "model not allowed" } } })).toEqual({
      ok: false,
      message: "response.failed: model not allowed",
    });
    expect(classifyEvent({ type: "error", message: "rate limited" })).toEqual({ ok: false, message: "error: rate limited" });
  });
});

function sseResponse(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("sendHi", () => {
  const acc = { accountId: "acc-1", tokens: { access_token: "at", refresh_token: "rt", id_token: "" } };

  it("送出 codex-tools 相同的 header 與 body，讀到 completed 成功", async () => {
    const { calls } = mockFetch({
      [RESPONSES_URL]: () =>
        sseResponse(['data: {"type":"response.created"}\n\n', 'data: {"type":"response.completed","response":{"status":"comp', 'leted"}}\n\n']),
    });
    await sendHi(acc, { model: "m1", effort: "none" });
    const h = calls[0].headers;
    expect(h.get("Accept")).toBe("text/event-stream");
    expect(h.get("Originator")).toBe("codex_cli_rs");
    expect(h.get("User-Agent")).toMatch(/^codex_cli_rs\//);
    expect(h.get("ChatGPT-Account-Id")).toBe("acc-1");
    expect(h.get("session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(calls[0].body)).toEqual(buildHiBody("m1", "none"));
    expect(JSON.parse(calls[0].body)).toMatchObject({ stream: true, store: false, instructions: "" });
  });

  it("failed 事件、沒有終止事件、非 2xx 都算失敗", async () => {
    mockFetch({
      [RESPONSES_URL]: [
        () => sseResponse(['data: {"type":"response.failed","response":{"error":{"message":"nope"}}}\n\n']),
        () => sseResponse(['data: {"type":"response.created"}\n\n']),
        () => new Response('{"detail":"The model is not supported"}', { status: 400 }),
      ],
    });
    await expect(sendHi(acc, { model: "m", effort: null })).rejects.toThrow("nope");
    await expect(sendHi(acc, { model: "m", effort: null })).rejects.toThrow("without a terminal event");
    await expect(sendHi(acc, { model: "m", effort: null })).rejects.toThrow("HTTP 400: {\"detail\":\"The model is not supported\"}");
  });

  it("effort 為 null 時不帶 reasoning", () => {
    expect(buildHiBody("m", null)).not.toHaveProperty("reasoning");
  });
});
