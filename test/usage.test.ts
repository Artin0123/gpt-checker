import { afterEach, describe, expect, it, vi } from "vitest";
import usageFree from "./fixtures/usage-free.json";
import { fetchUsage, parseUsage, secondsUntilReset } from "../src/lib/usage";
import { applyTokenResponse, needsRefresh, requestRefresh } from "../src/lib/tokens";
import { TOKEN_URL, USAGE_URL, UpstreamError } from "../src/lib/openai";
import { fakeAccessToken, fakeIdToken } from "./fixtures";
import { jsonRes, mockFetch } from "./fetch-mock";

// usage-free.json 是依 codex-tools / CPA 原始碼推得的形狀，尚未以真實回應校正

afterEach(() => vi.unstubAllGlobals());

describe("parseUsage", () => {
  it("攤平 primary / secondary / additional，略過 null 與缺 used_percent 的窗口", () => {
    const snap = parseUsage(
      {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: 100 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 5000 },
        },
        additional_rate_limits: [
          { limit_name: "codex_other", rate_limit: { primary_window: { used_percent: 1 }, secondary_window: { foo: 1 } } },
          "junk",
        ],
      },
      1_000_000,
    );
    expect(snap.planType).toBe("plus");
    expect(snap.fetchedAt).toBe(1000);
    expect(snap.windows.map((w) => w.name)).toEqual(["primary", "secondary", "codex_other.primary"]);
    expect(snap.windows[0]).toMatchObject({ usedPercent: 12.5, windowSeconds: 18000, resetAt: 100, resetAfterSeconds: null });
  });

  it("free 帳號單一 30 天窗口", () => {
    const snap = parseUsage(usageFree);
    expect(snap.windows).toHaveLength(1);
    expect(snap.windows[0].windowSeconds).toBe(2592000);
  });

  it("壞 payload 不丟例外", () => {
    expect(parseUsage(null).windows).toEqual([]);
    expect(parseUsage({ rate_limit: "x" }).windows).toEqual([]);
  });

  it("secondsUntilReset 優先 reset_after_seconds 並依抓取時間校正", () => {
    const snap = { fetchedAt: 1000, planType: null, windows: [] };
    const w = { name: "p", usedPercent: 0, windowSeconds: null, resetAt: 99999, resetAfterSeconds: 500 };
    expect(secondsUntilReset(w, snap, 1_100_000)).toBe(400);
    expect(secondsUntilReset({ ...w, resetAfterSeconds: null }, snap, 1_100_000)).toBe(99999 - 1100);
    expect(secondsUntilReset({ ...w, resetAfterSeconds: null, resetAt: null }, snap)).toBeNull();
  });
});

describe("fetchUsage", () => {
  const acc = { accountId: "acc-1", tokens: { access_token: "at", refresh_token: "rt", id_token: "" } };

  it("帶正確 header", async () => {
    const { calls } = mockFetch({ [USAGE_URL]: () => jsonRes(usageFree) });
    const snap = await fetchUsage(acc);
    expect(snap.windows).toHaveLength(1);
    expect(calls[0].headers.get("Authorization")).toBe("Bearer at");
    expect(calls[0].headers.get("ChatGPT-Account-Id")).toBe("acc-1");
    expect(calls[0].headers.get("Accept")).toBe("application/json");
  });

  it("Cloudflare 擋下頁面會被辨識；401 帶 status", async () => {
    mockFetch({
      [USAGE_URL]: [
        () => new Response("<html><body><h1>Unable to load site</h1></body></html>", { status: 403 }),
        () => jsonRes({ detail: "bad token" }, 401),
      ],
    });
    await expect(fetchUsage(acc)).rejects.toThrow("blocked by Cloudflare");
    const err = await fetchUsage(acc).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(401);
  });
});

describe("token refresh", () => {
  it("needsRefresh 依 expired、JWT exp、缺 token 判斷", () => {
    const now = Date.parse("2026-09-30T00:00:00Z");
    const tokens = { id_token: "", refresh_token: "rt", access_token: "x" };
    expect(needsRefresh({ expired: "2026-09-30T00:10:00Z", tokens }, now)).toBe(false);
    expect(needsRefresh({ expired: "2026-09-30T00:04:00Z", tokens }, now)).toBe(true);
    expect(needsRefresh({ expired: null, tokens: { ...tokens, access_token: fakeAccessToken(now / 1000 + 3600) } }, now)).toBe(false);
    expect(needsRefresh({ expired: null, tokens }, now)).toBe(true);
    expect(needsRefresh({ expired: "2099-01-01T00:00:00Z", tokens: { ...tokens, access_token: "" } }, now)).toBe(true);
  });

  it("requestRefresh 送出與 CPA 相同的 form", async () => {
    const { calls } = mockFetch({ [TOKEN_URL]: () => jsonRes({ access_token: "at2", refresh_token: "rt2", expires_in: 60 }) });
    await requestRefresh("rt1");
    expect(calls[0].headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "rt1",
      scope: "openid profile email",
    });
  });

  it("refresh_token_reused / invalid_grant 視為失效；500 為暫時失敗", async () => {
    mockFetch({
      [TOKEN_URL]: [
        () => jsonRes({ error: { code: "refresh_token_reused" } }, 401),
        () => jsonRes({ error: "invalid_grant" }, 400),
        () => new Response("oops", { status: 500 }),
      ],
    });
    expect((await requestRefresh("a").catch((e) => e)).kind).toBe("refresh_invalid");
    expect((await requestRefresh("a").catch((e) => e)).kind).toBe("refresh_invalid");
    expect((await requestRefresh("a").catch((e) => e)).kind).toBe("refresh_failed");
  });

  it("applyTokenResponse 沒有新 refresh/id token 時沿用舊的，並從 id_token 取 plan", () => {
    const prev = { access_token: "a", refresh_token: "rt-old", id_token: fakeIdToken({ plan: "plus" }) };
    const now = Date.parse("2026-09-30T00:00:00Z");
    const f = applyTokenResponse(prev, { access_token: "a2", expires_in: 3600 }, now);
    expect(f.tokens).toEqual({ access_token: "a2", refresh_token: "rt-old", id_token: prev.id_token });
    expect(f.expired).toBe("2026-09-30T01:00:00.000Z");
    expect(f.planType).toBe("plus");
  });
});
