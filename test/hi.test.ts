import { afterEach, describe, expect, it, vi } from "vitest";
import { SseParser, buildHiBody, classifyEvent, hiEligibleWindow, sendHi } from "../src/lib/hi";
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

describe("hiEligibleWindow（剩 100% 且窗口還沒開始倒數）", () => {
  it("實測的未使用窗口：reset_after == 窗口長度、reset_at 比抓取時間多 1 秒，都符合", () => {
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: 2592000 }]))).not.toBeNull();
    expect(hiEligibleWindow(snap([{ resetAt: NOW / 1000 + 2592001 }]))).not.toBeNull();
  });

  it("已開始倒數（剛送過 hi、用量四捨五入仍是 0）不重送", () => {
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: 2592000 - 60 }]))).toBeNull();
    expect(hiEligibleWindow(snap([{ resetAt: NOW / 1000 + 29.5 * 86400 }]))).toBeNull();
  });

  it("容許幾秒誤差，超過就視為已開始", () => {
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: 2592000 - 5 }]))).not.toBeNull();
    expect(hiEligibleWindow(snap([{ resetAfterSeconds: 2592000 - 6 }]))).toBeNull();
  });

  it("用了 1%（剩 99%）不符合", () => {
    expect(hiEligibleWindow(snap([{ usedPercent: 1, resetAfterSeconds: 2592000 }]))).toBeNull();
  });

  it("沒有窗口、沒有窗口長度、沒有重置時間都不符合", () => {
    expect(hiEligibleWindow(snap([]))).toBeNull();
    expect(hiEligibleWindow(snap([{}]))).toBeNull();
    expect(hiEligibleWindow(snap([{ windowSeconds: null, resetAfterSeconds: 2592000 }]))).toBeNull();
  });

  it("任一窗口符合即可；不看方案、窗口長度（5 小時窗口未使用也符合）", () => {
    const s = snap([{ usedPercent: 50, resetAfterSeconds: 2592000 }, { name: "x", windowSeconds: 18000, resetAfterSeconds: 18000 }]);
    expect(hiEligibleWindow(s)?.name).toBe("x");
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

  it("completed 回傳沒有錯誤", async () => {
    mockFetch({ [RESPONSES_URL]: () => sseResponse(['data: {"type":"response.completed"}\n\n']) });
    expect(await sendHi(acc, { model: "m", effort: null })).toEqual({ status: 200, upstreamError: null });
  });

  it("對方回報的錯誤（failed 事件、沒有終止事件、非 2xx）不 throw，只記在 upstreamError", async () => {
    mockFetch({
      [RESPONSES_URL]: [
        () => sseResponse(['data: {"type":"response.failed","response":{"error":{"message":"nope"}}}\n\n']),
        () => sseResponse(['data: {"type":"response.created"}\n\n']),
        () => new Response('{"detail":"The model is not supported"}', { status: 400 }),
      ],
    });
    expect(await sendHi(acc, { model: "m", effort: null })).toEqual({ status: 200, upstreamError: "response.failed: nope" });
    expect((await sendHi(acc, { model: "m", effort: null })).upstreamError).toContain("without a terminal event");
    expect(await sendHi(acc, { model: "m", effort: null })).toEqual({
      status: 400,
      upstreamError: 'HTTP 400: {"detail":"The model is not supported"}',
    });
  });

  it("GHA 這邊的問題才 throw：連不上、被 Cloudflare 擋", async () => {
    mockFetch({
      [RESPONSES_URL]: [
        () => {
          throw new TypeError("fetch failed");
        },
        () => new Response("<html>Just a moment...</html>", { status: 403 }),
      ],
    });
    await expect(sendHi(acc, { model: "m", effort: null })).rejects.toThrow("hi request failed: fetch failed");
    await expect(sendHi(acc, { model: "m", effort: null })).rejects.toThrow("blocked by Cloudflare");
  });

  it("effort 為 null 時不帶 reasoning", () => {
    expect(buildHiBody("m", null)).not.toHaveProperty("reasoning");
  });
});
