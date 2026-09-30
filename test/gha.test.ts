import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordMessages, postDiscord, resolveMode, runAccount, runAll, shouldNotify, type AccountResult, type PanelClient } from "../scripts/runner";
import { RESPONSES_URL, TOKEN_URL, USAGE_URL } from "../src/lib/openai";
import type { Account, AccountStatus } from "../src/lib/types";
import type { TokenPatch } from "../src/routes/gha";
import { bearer, call, makeEnv, TEST_PASSWORD } from "./helpers";
import { codexAuthJson, cpaCredential, fakeIdToken } from "./fixtures";
import { jsonRes, mockFetch } from "./fetch-mock";

afterEach(() => vi.unstubAllGlobals());

async function seeded() {
  const env = makeEnv();
  await call(env, "POST", "/api/import", { headers: bearer, body: [cpaCredential(), codexAuthJson()] });
  const { accounts } = (await (await call(env, "GET", "/api/accounts", { headers: bearer })).json()) as { accounts: Account[] };
  return { env, accounts };
}

async function cookieFor(env: ReturnType<typeof makeEnv>) {
  const res = await call(env, "POST", "/api/login", { body: { password: TEST_PASSWORD } });
  return res.headers.get("Set-Cookie")!.split(";")[0];
}

const listIds = async (env: ReturnType<typeof makeEnv>, path = "/api/accounts") =>
  ((await (await call(env, "GET", path, { headers: bearer })).json()) as { accounts: Account[] }).accounts;

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abc-DEF_ghij";

describe("啟用 / 刪除 / 設定 API", () => {
  it("啟用 / 停用選取的帳號：一次請求只寫 1 次 KV；結果相同不寫；未知 id 被忽略", async () => {
    const { env, accounts } = await seeded();
    const [a, b] = accounts;
    env.kv.resetOps();
    const res = await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body: { ids: [a.id, b.id, "nope"], enabled: true } });
    expect(res.status).toBe(200);
    expect(env.kv.putKeys).toEqual(["enabled"]);
    expect((await listIds(env)).every((x) => x.enabled)).toBe(true);

    env.kv.resetOps();
    await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body: { ids: [a.id], enabled: true } });
    expect(env.kv.ops.put).toBe(0);

    await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body: { ids: [a.id], enabled: false } });
    expect((await listIds(env)).map((x) => [x.id, x.enabled])).toEqual([
      [a.id, false],
      [b.id, true],
    ]);
    for (const body of [{ ids: [], enabled: true }, { ids: "x", enabled: true }, { ids: [a.id] }]) {
      expect((await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body })).status).toBe(400);
    }
  });

  it("整批刪除：每個帳號刪 1 次、索引寫 1 次", async () => {
    const { env, accounts } = await seeded();
    env.kv.resetOps();
    const res = await call(env, "POST", "/api/accounts/delete", { headers: bearer, body: { ids: accounts.map((a) => a.id).concat("nope") } });
    expect(((await res.json()) as { deleted: string[] }).deleted).toHaveLength(2);
    expect(env.kv.ops.delete).toBe(2);
    expect(env.kv.putKeys).toEqual(["index:accounts"]);
    expect(await listIds(env)).toEqual([]);
  });

  it("repo 網址：接受 repo / actions / workflow 頁面網址並正規化，拒絕非 github.com", async () => {
    const env = makeEnv();
    const put = (repoUrl: unknown) => call(env, "PUT", "/api/config", { headers: bearer, body: { repoUrl } });
    const get = async () => ((await (await call(env, "GET", "/api/config", { headers: bearer })).json()) as { config: { repoUrl: string | null } }).config.repoUrl;
    for (const url of ["https://github.com/o/r", "https://github.com/o/r/actions", "https://github.com/o/r/actions/workflows/hi.yml", "https://github.com/o/r.git"]) {
      expect((await put(url)).status).toBe(200);
      expect(await get()).toBe("https://github.com/o/r");
    }
    for (const bad of ["http://github.com/o/r", "https://github.com.evil.com/o/r", "javascript:alert(1)", "https://gist.github.com/o/r", "https://github.com/o", 123]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect((await put(null)).status).toBe(200);
    expect(await get()).toBeNull();
  });

  it("手動執行模式：預設 usage、部分更新、同值不寫 KV、非法值 400", async () => {
    const env = makeEnv();
    const get = async () => ((await (await call(env, "GET", "/api/config", { headers: bearer })).json()) as { config: Record<string, unknown> }).config;
    expect(await get()).toMatchObject({ manualMode: "usage", repoUrl: null });
    await call(env, "PUT", "/api/config", { headers: bearer, body: { repoUrl: "https://github.com/o/r" } });
    await call(env, "PUT", "/api/config", { headers: bearer, body: { manualMode: "hi" } });
    expect(await get()).toMatchObject({ manualMode: "hi", repoUrl: "https://github.com/o/r" });
    env.kv.resetOps();
    await call(env, "PUT", "/api/config", { headers: bearer, body: { manualMode: "hi" } });
    expect(env.kv.ops.put).toBe(0);
    expect((await call(env, "PUT", "/api/config", { headers: bearer, body: { manualMode: "both" } })).status).toBe(400);
  });

  it("Discord webhook：只接受 Discord 網址；儲存後面板讀得回完整網址；改其他欄位不會清掉；可清除", async () => {
    const env = makeEnv();
    const get = async () => ((await (await call(env, "GET", "/api/config", { headers: bearer })).json()) as { config: Record<string, unknown> }).config;
    for (const bad of ["https://example.com/api/webhooks/1/x", "http://discord.com/api/webhooks/1/x", "https://discord.com/api/webhooks/x/y", 5]) {
      expect((await call(env, "PUT", "/api/config", { headers: bearer, body: { discordWebhook: bad } })).status).toBe(400);
    }
    const res = await call(env, "PUT", "/api/config", { headers: bearer, body: { discordWebhook: WEBHOOK } });
    expect(((await res.json()) as { config: { discordWebhook: string } }).config.discordWebhook).toBe(WEBHOOK);
    expect((await get()).discordWebhook).toBe(WEBHOOK);
    await call(env, "PUT", "/api/config", { headers: bearer, body: { manualMode: "hi" } });
    expect((await get()).discordWebhook).toBe(WEBHOOK);
    await call(env, "PUT", "/api/config", { headers: bearer, body: { discordWebhook: "" } });
    expect((await get()).discordWebhook).toBeNull();
  });

  it("舊版 config.ghaUrl 會被讀成 repoUrl", async () => {
    const env = makeEnv();
    await env.kv.put("config", JSON.stringify({ ghaUrl: "https://github.com/o/r/actions", manualMode: "hi" }));
    expect(((await (await call(env, "GET", "/api/config", { headers: bearer })).json()) as { config: unknown }).config).toMatchObject({
      repoUrl: "https://github.com/o/r",
      manualMode: "hi",
    });
  });

  it("跨來源的 cookie 寫入請求被拒絕", async () => {
    const env = makeEnv();
    const cookie = await cookieFor(env);
    const res = await call(env, "PUT", "/api/config", { headers: { Cookie: cookie, Origin: "https://evil.example" }, body: { repoUrl: null } });
    expect(res.status).toBe(403);
    const same = await call(env, "PUT", "/api/config", { headers: { Cookie: cookie, Origin: "https://panel.test" }, body: { repoUrl: null } });
    expect(same.status).toBe(200);
  });
});

describe("KV 用量", () => {
  it("列帳號不呼叫 list()（只讀索引）；索引不存在時才重建一次", async () => {
    const { env } = await seeded();
    env.kv.resetOps();
    await listIds(env);
    await listIds(env);
    expect(env.kv.ops.list).toBe(0);
    expect(env.kv.ops.put).toBe(0);

    await env.kv.delete("index:accounts");
    env.kv.resetOps();
    expect(await listIds(env)).toHaveLength(2);
    await listIds(env);
    expect(env.kv.ops.list).toBe(1);
  });

  it("一次匯入多個帳號：每個帳號寫 1 次 + 索引 1 次；重複匯入相同內容不寫", async () => {
    const env = makeEnv();
    const body = [cpaCredential(), codexAuthJson(), codexAuthJson("user3@example.com", "acc-3")];
    await call(env, "POST", "/api/import", { headers: bearer, body });
    expect(env.kv.putKeys.filter((k) => k === "index:accounts")).toHaveLength(1);
    expect(env.kv.putKeys.filter((k) => k.startsWith("account:"))).toHaveLength(3);
    env.kv.resetOps();
    await call(env, "POST", "/api/import", { headers: bearer, body });
    expect(env.kv.ops.put).toBe(0);
  });

  it("OAuth：開始寫 1 次、成功後刪除 session，沒有其他狀態寫入", async () => {
    const env = makeEnv();
    const { state } = (await (await call(env, "POST", "/api/oauth/start", { headers: bearer })).json()) as { state: string };
    expect(env.kv.putKeys).toEqual([`oauth:${state}`]);
    mockFetch({
      [TOKEN_URL]: () =>
        jsonRes({ access_token: "at", refresh_token: "rt-o", id_token: fakeIdToken({ email: "o@example.com", accountId: "acc-o" }), expires_in: 60 }),
    });
    env.kv.resetOps();
    await call(env, "POST", "/api/oauth/callback", {
      headers: bearer,
      body: { redirect_url: `http://localhost:1455/auth/callback?code=c&state=${state}` },
    });
    expect(env.kv.putKeys.filter((k) => k.startsWith("oauth:"))).toEqual([]);
    expect(env.kv.store.has(`oauth:${state}`)).toBe(false);
  });
});

describe("GHA 專用端點", () => {
  it("只接受 Bearer，回傳啟用的帳號（含 token）、手動模式、完整 webhook", async () => {
    const { env, accounts } = await seeded();
    await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body: { ids: [accounts[1].id], enabled: true } });
    await call(env, "PUT", "/api/config", { headers: bearer, body: { manualMode: "hi", discordWebhook: WEBHOOK } });
    const cookie = await cookieFor(env);
    expect((await call(env, "GET", "/api/gha/accounts", { headers: { Cookie: cookie } })).status).toBe(403);
    const body = (await (await call(env, "GET", "/api/gha/accounts", { headers: bearer })).json()) as {
      accounts: Account[];
      manualMode: string;
      discordWebhook: string;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].tokens.refresh_token).toBe("rt-fake-authjson");
    expect(body.manualMode).toBe("hi");
    expect(body.discordWebhook).toBe(WEBHOOK);
  });

  it("PATCH tokens：refresh token 鏈相同才寫入；不同時不寫", async () => {
    const { env, accounts } = await seeded();
    const id = accounts.find((a) => a.email === "user1@example.com")!.id;
    const tokens = { access_token: "at2", refresh_token: "rt2", id_token: "" };
    let res = await call(env, "PATCH", `/api/gha/accounts/${id}/tokens`, { headers: bearer, body: { expectRefreshToken: "rt-fake-cpa", tokens } });
    expect(await res.json()).toEqual({ tokensApplied: true });

    env.kv.resetOps();
    res = await call(env, "PATCH", `/api/gha/accounts/${id}/tokens`, {
      headers: bearer,
      body: { expectRefreshToken: "rt-fake-cpa", tokens: { ...tokens, refresh_token: "rt3" } },
    });
    expect(await res.json()).toEqual({ tokensApplied: false });
    expect(env.kv.ops.put).toBe(0);
    expect(JSON.parse(env.kv.store.get(`account:${id}`)!.value).tokens.refresh_token).toBe("rt2");
  });

  it("POST status：所有帳號的額度整批寫 1 次；未帶的帳號保留舊值；刪除的帳號被清掉", async () => {
    const { env, accounts } = await seeded();
    const [a, b] = accounts;
    const usage = { fetchedAt: 1, planType: "free", windows: [] };
    env.kv.resetOps();
    await call(env, "POST", "/api/gha/status", {
      headers: bearer,
      body: { updates: { [a.id]: { usage, usageError: null }, [b.id]: { usageError: "boom", lastRun: { at: "t", mode: "hi", status: "failed", reason: "boom" } } } },
    });
    expect(env.kv.putKeys).toEqual(["status"]);
    await call(env, "POST", "/api/gha/status", { headers: bearer, body: { updates: { [b.id]: { usageError: null } } } });
    const list = await listIds(env);
    expect(list.find((x) => x.id === a.id)!.usage).toEqual(usage);
    expect(list.find((x) => x.id === b.id)!.lastRun?.status).toBe("failed");
    expect(list.find((x) => x.id === b.id)!.usageError).toBeNull();

    await call(env, "POST", "/api/accounts/delete", { headers: bearer, body: { ids: [a.id] } });
    await call(env, "POST", "/api/gha/status", { headers: bearer, body: { updates: {} } });
    expect(Object.keys(JSON.parse(env.kv.store.get("status")!.value))).toEqual([b.id]);
  });

  it("輸入驗證", async () => {
    const { env, accounts } = await seeded();
    const id = accounts[0].id;
    for (const body of [{}, { expectRefreshToken: "x", tokens: { access_token: "a" } }, { expectRefreshToken: "x", invalid: "yes" }]) {
      expect((await call(env, "PATCH", `/api/gha/accounts/${id}/tokens`, { headers: bearer, body })).status).toBe(400);
    }
    for (const body of [{}, { updates: [] }, { updates: { [id]: { usage: 5 } } }, { updates: { [id]: { lastRun: "x" } } }]) {
      expect((await call(env, "POST", "/api/gha/status", { headers: bearer, body })).status).toBe(400);
    }
  });

  it("舊版 selection key 會被讀成啟用清單", async () => {
    const { env, accounts } = await seeded();
    await env.kv.put("selection", JSON.stringify([accounts[0].id]));
    expect((await listIds(env)).map((a) => a.enabled)).toEqual([true, false]);
  });

  it("舊版資料（usage / selected 存在帳號裡）仍能讀出來", async () => {
    const env = makeEnv();
    const legacy = {
      id: "old1", email: "old@example.com", accountId: "acc-old", planType: "free",
      tokens: { access_token: "a", refresh_token: "r", id_token: "" }, expired: null, lastRefresh: null,
      selected: true, invalid: false, invalidReason: null, usage: { fetchedAt: 1, planType: null, windows: [] }, usageError: null,
      lastRun: null, addedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    };
    await env.kv.put("account:old1", JSON.stringify(legacy));
    const [a] = await listIds(env);
    expect(a).toMatchObject({ id: "old1", enabled: true, usage: legacy.usage });
  });
});

// ---------- runner ----------

const NOW = Date.parse("2026-09-30T00:00:00Z");
const freshUsage = { plan_type: "free", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_after_seconds: 2592000 } } };
const usedUsage = { plan_type: "free", rate_limit: { primary_window: { used_percent: 0.2, limit_window_seconds: 2592000, reset_after_seconds: 2591000 } } };

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "id1",
    email: "user1@example.com",
    accountId: "acc-1",
    planType: "free",
    tokens: { access_token: "at", refresh_token: "rt", id_token: "" },
    expired: "2026-10-10T00:00:00Z",
    lastRefresh: null,
    enabled: true,
    invalid: false,
    invalidReason: null,
    usage: null,
    usageError: null,
    lastRun: null,
    addedAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function fakePanel(accounts: Account[], opts: { failTokens?: number; failStatus?: number } = {}) {
  const tokenPatches: { id: string; patch: TokenPatch }[] = [];
  const statusPuts: Record<string, Partial<AccountStatus>>[] = [];
  let tokenFailures = opts.failTokens ?? 0;
  let statusFailures = opts.failStatus ?? 0;
  const panel: PanelClient = {
    async fetchJob() {
      return { accounts, manualMode: "usage", discordWebhook: null };
    },
    async patchTokens(id, patch) {
      if (tokenFailures-- > 0) throw new Error("panel down");
      tokenPatches.push({ id, patch });
      return { tokensApplied: true };
    },
    async putStatus(updates) {
      if (statusFailures-- > 0) throw new Error("panel down");
      statusPuts.push(updates);
    },
  };
  return { panel, tokenPatches, statusPuts };
}

function sse(events: unknown[]) {
  return () => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

const opts = { model: "m", effort: "none", now: () => NOW, sleep: async () => { } };

describe("runAccount / runAll", () => {
  it("符合條件：送 hi 後再查額度，結果帶 lastRun", async () => {
    const { panel } = fakePanel([]);
    const { calls } = mockFetch({
      [USAGE_URL]: [() => jsonRes(freshUsage), () => jsonRes(usedUsage)],
      [RESPONSES_URL]: sse([{ type: "response.completed", response: { status: "completed" } }]),
    });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("sent");
    expect(r.anomalies).toEqual([]);
    expect(r.usage?.windows[0].usedPercent).toBe(0.2);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/backend-api/wham/usage", "/backend-api/codex/responses", "/backend-api/wham/usage"]);
    expect(r.statusUpdate?.lastRun).toMatchObject({ mode: "hi", status: "sent" });
  });

  it("不符合條件：略過、不送 hi", async () => {
    const { panel } = fakePanel([]);
    const { calls } = mockFetch({ [USAGE_URL]: () => jsonRes(usedUsage) });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("只查額度模式：即使符合條件也不送 hi，不覆蓋 lastRun", async () => {
    const { panel } = fakePanel([]);
    const { calls } = mockFetch({ [USAGE_URL]: () => jsonRes(freshUsage) });
    const r = await runAccount(panel, account(), { ...opts, mode: "usage" });
    expect(r.status).toBe("refreshed");
    expect(calls).toHaveLength(1);
    expect(r.statusUpdate?.usage?.windows).toHaveLength(1);
    expect(r.statusUpdate).not.toHaveProperty("lastRun");
  });

  it("runAll：所有帳號跑完才整批寫回一次額度", async () => {
    const { panel, statusPuts, tokenPatches } = fakePanel([account({ id: "a" }), account({ id: "b" }), account({ id: "c", invalid: true })]);
    mockFetch({ [USAGE_URL]: () => jsonRes(usedUsage) });
    const results = await runAll(panel, await panel.fetchJob(), { ...opts, mode: "hi" });
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped", "failed"]);
    expect(statusPuts).toHaveLength(1);
    expect(Object.keys(statusPuts[0])).toEqual(["a", "b"]);
    expect(tokenPatches).toHaveLength(0);
  });

  it("runAll：整批寫回失敗時每個帳號都列異常", async () => {
    const { panel } = fakePanel([account()], { failStatus: 99 });
    mockFetch({ [USAGE_URL]: () => jsonRes(usedUsage) });
    const [r] = await runAll(panel, await panel.fetchJob(), { ...opts, mode: "usage" });
    expect(r.anomalies[0]).toContain("額度結果寫回面板失敗");
  });

  it("resolveMode：排程固定送 hi；手動依面板開關", () => {
    expect(resolveMode("schedule", { manualMode: "usage" })).toBe("hi");
    expect(resolveMode("manual", { manualMode: "usage" })).toBe("usage");
    expect(resolveMode("manual", { manualMode: "hi" })).toBe("hi");
  });

  it("token 快過期：先 refresh，新 token 立刻寫回（帶舊 refresh token 當鏈檢查）", async () => {
    const { panel, tokenPatches } = fakePanel([]);
    const { calls } = mockFetch({
      [TOKEN_URL]: () => jsonRes({ access_token: "at2", refresh_token: "rt2", id_token: fakeIdToken(), expires_in: 3600 }),
      [USAGE_URL]: () => jsonRes(usedUsage),
    });
    const r = await runAccount(panel, account({ expired: "2026-09-29T00:00:00Z" }), { ...opts, mode: "hi" });
    expect(r.status).toBe("skipped");
    expect(tokenPatches).toHaveLength(1);
    expect(tokenPatches[0].patch).toMatchObject({ expectRefreshToken: "rt", tokens: { refresh_token: "rt2" } });
    expect(calls[1].headers.get("Authorization")).toBe("Bearer at2");
  });

  it("refresh token 失效：標成 invalid 並列為異常", async () => {
    const { panel, tokenPatches } = fakePanel([]);
    mockFetch({ [TOKEN_URL]: () => jsonRes({ error: { code: "refresh_token_reused" } }, 401) });
    const r = await runAccount(panel, account({ expired: null, tokens: { access_token: "", refresh_token: "rt", id_token: "" } }), {
      ...opts,
      mode: "hi",
    });
    expect(r.status).toBe("failed");
    expect(r.anomalies[0]).toContain("refresh_token_reused");
    expect(tokenPatches.some((p) => p.patch.invalid === true)).toBe(true);
  });

  it("已失效帳號直接列為異常，不打上游、不寫回", async () => {
    const { panel } = fakePanel([]);
    const { calls } = mockFetch({});
    const r = await runAccount(panel, account({ invalid: true, invalidReason: "x" }), { ...opts, mode: "hi" });
    expect(r.anomalies[0]).toContain("失效");
    expect(r.statusUpdate).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("usage 401：強制 refresh 後重試", async () => {
    const { panel } = fakePanel([]);
    const { calls } = mockFetch({
      [USAGE_URL]: [() => jsonRes({ detail: "expired" }, 401), () => jsonRes(usedUsage)],
      [TOKEN_URL]: () => jsonRes({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
    });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("skipped");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/backend-api/wham/usage", "/oauth/token", "/backend-api/wham/usage"]);
  });

  it("送 hi 時對方回報錯誤（例如模型不支援）仍算已送出，不列為異常，錯誤記在 lastRun", async () => {
    const { panel } = fakePanel([]);
    mockFetch({
      [USAGE_URL]: [() => jsonRes(freshUsage), () => jsonRes(usedUsage)],
      [RESPONSES_URL]: () => jsonRes({ detail: "model not supported" }, 400),
    });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("sent");
    expect(r.anomalies).toEqual([]);
    expect(r.reason).toContain("model not supported");
    expect(r.statusUpdate?.lastRun).toMatchObject({ status: "sent", upstreamError: expect.stringContaining("model not supported") });
  });

  it("送 hi 401：refresh 後重送一次", async () => {
    const { panel, tokenPatches } = fakePanel([]);
    const { calls } = mockFetch({
      [USAGE_URL]: [() => jsonRes(freshUsage), () => jsonRes(usedUsage)],
      [RESPONSES_URL]: [() => jsonRes({ detail: "expired" }, 401), sse([{ type: "response.completed" }])],
      [TOKEN_URL]: () => jsonRes({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }),
    });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("sent");
    expect(r.upstreamError).toBeNull();
    expect(tokenPatches).toHaveLength(1);
    const hiCalls = calls.filter((c) => c.url === RESPONSES_URL);
    expect(hiCalls.map((c) => c.headers.get("Authorization"))).toEqual(["Bearer at", "Bearer at2"]);
  });

  it("送 hi 時 GHA 連不上對方才算失敗、列為異常", async () => {
    const { panel } = fakePanel([]);
    mockFetch({
      [USAGE_URL]: () => jsonRes(freshUsage),
      [RESPONSES_URL]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const r = await runAccount(panel, account(), { ...opts, mode: "hi" });
    expect(r.status).toBe("failed");
    expect(r.anomalies[0]).toContain("fetch failed");
  });

  it("新 token 寫回面板失敗：重試後仍失敗就列為異常", async () => {
    const { panel } = fakePanel([], { failTokens: 99 });
    mockFetch({ [TOKEN_URL]: () => jsonRes({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }) });
    const r = await runAccount(panel, account({ expired: "2026-09-29T00:00:00Z" }), { ...opts, mode: "hi" });
    expect(r.status).toBe("failed");
    expect(r.anomalies[0]).toContain("寫回面板失敗");
  });
});

describe("Discord", () => {
  const res = (i: number, anomaly = false): AccountResult => ({
    id: `id${i}`,
    label: `user${i}@example.com`,
    status: anomaly ? "failed" : "skipped",
    reason: anomaly ? "boom" : "不符合條件",
    usage: { fetchedAt: NOW / 1000, planType: "free", windows: [{ name: "primary", usedPercent: 0.2, windowSeconds: 2592000, resetAt: null, resetAfterSeconds: 86400 }] },
    anomalies: anomaly ? ["boom"] : [],
    upstreamError: null,
    statusUpdate: null,
  });

  it("異常放最前面、超過 10 個分批、第一則有摘要", () => {
    const results = Array.from({ length: 12 }, (_, i) => res(i, i === 11));
    const msgs = buildDiscordMessages(results, { runUrl: "https://github.com/o/r/actions/runs/1", now: NOW });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].embeds).toHaveLength(10);
    expect(msgs[1].embeds).toHaveLength(2);
    expect(msgs[0].embeds[0].title).toBe("⚠️ user11@example.com");
    expect(msgs[0].embeds[0].color).toBe(0xdc2626);
    expect(msgs[0].content).toContain("異常 1");
    expect(msgs[0].content).toContain("actions/runs/1");
    expect(msgs[1].content).toBeUndefined();
    expect(msgs[0].embeds[1].description).toContain("剩 **99.8%**");
    expect(msgs[0].embeds[1].description).toContain("1.0 天後");
    expect(msgs[0].allowed_mentions).toEqual({ parse: [] });
  });

  it("沒有帳號也送一則摘要", () => {
    const msgs = buildDiscordMessages([], {});
    expect(msgs).toHaveLength(1);
    expect(msgs[0].embeds).toEqual([]);
  });

  it("只有送 hi 模式通知；只查額度模式有異常也不通知", () => {
    expect(shouldNotify("hi")).toBe(true);
    expect(shouldNotify("usage")).toBe(false);
  });

  it("postDiscord 遇到 429 依 retry_after 重試", async () => {
    const { calls } = mockFetch({ "https://discord.test/": [() => jsonRes({ retry_after: 0.01 }, 429), () => new Response(null, { status: 204 })] });
    await postDiscord("https://discord.test/hook", { content: "x" }, async () => { });
    expect(calls).toHaveLength(2);
  });
});
