import { describe, expect, it } from "vitest";
import { parseImport } from "../src/lib/import";
import { claimsOf } from "../src/lib/jwt";
import { bearer, call, makeEnv } from "./helpers";
import { codexAuthJson, codexToolsStore, cpaCredential, fakeAccessToken, fakeIdToken } from "./fixtures";

describe("parseImport", () => {
  it("CPA 扁平格式", () => {
    const [r] = parseImport(cpaCredential());
    expect(r.error).toBeUndefined();
    expect(r.credential).toMatchObject({
      accountId: "acc-00000000-0000-0000-0000-000000000001",
      email: "user1@example.com",
      planType: "free",
      expired: "2033-05-18T03:33:20.000Z",
      tokens: { refresh_token: "rt-fake-cpa" },
    });
  });

  it("~/.codex/auth.json：email / plan 從 id_token 取得", () => {
    const [r] = parseImport(codexAuthJson());
    expect(r.credential).toMatchObject({ email: "user2@example.com", planType: "plus", lastRefresh: "2026-09-02T00:00:00Z" });
    // expired 從 access token 的 exp 推得
    expect(r.credential!.expired).toBe(new Date(2_000_000_000 * 1000).toISOString());
  });

  it("codex-tools accounts store：chatgpt 匯入、relay 拒絕", () => {
    const results = parseImport(codexToolsStore());
    expect(results).toHaveLength(2);
    expect(results[0].path).toBe("$.accounts[0]");
    expect(results[0].credential?.email).toBe("user3@example.com");
    expect(results[1].error).toContain("sourceKind");
  });

  it("單一 stored account（auth_json snake_case）", () => {
    const [r] = parseImport({ email: "user4@example.com", auth_json: codexAuthJson("user4@example.com") });
    expect(r.credential?.email).toBe("user4@example.com");
  });

  it("陣列混合格式", () => {
    const results = parseImport([cpaCredential(), codexAuthJson()]);
    expect(results.map((r) => r.path)).toEqual(["$[0]", "$[1]"]);
    expect(results.every((r) => r.credential)).toBe(true);
  });

  it("缺 refresh_token 拒絕", () => {
    const { refresh_token: _, ...noRt } = cpaCredential();
    expect(parseImport(noRt)[0].error).toBe("缺少 refresh_token");
    const auth = codexAuthJson();
    auth.tokens.refresh_token = "";
    expect(parseImport(auth)[0].error).toBe("缺少 refresh_token");
  });

  it("缺 account_id 時從 id_token claim 補上", () => {
    const { account_id: _, ...noId } = cpaCredential();
    expect(parseImport(noId)[0].credential?.accountId).toBe("acc-00000000-0000-0000-0000-000000000001");
  });

  it("只有 access_token 帶 account claim 也能補", () => {
    const [r] = parseImport({ refresh_token: "rt", access_token: fakeAccessToken(1, "acc-from-at") });
    expect(r.credential?.accountId).toBe("acc-from-at");
  });

  it("完全取不到 account_id 時拒絕", () => {
    expect(parseImport({ refresh_token: "rt" })[0].error).toContain("account_id");
  });

  it("非 codex 類型、未知格式、非物件", () => {
    expect(parseImport({ ...cpaCredential(), type: "claude" })[0].error).toContain("claude");
    expect(parseImport({ foo: 1 })[0].error).toBe("無法辨識的格式");
    expect(parseImport("text")[0].error).toBe("不是 JSON 物件");
  });

  it("claimsOf 容忍壞 token", () => {
    expect(claimsOf("not-a-jwt").accountId).toBeNull();
    expect(claimsOf(fakeIdToken({ accountId: "abc" })).accountId).toBe("abc");
  });
});

describe("匯入 / 列表 / 刪除 API", () => {
  it("匯入兩個帳號後列表不含 token，刪除其中一個", async () => {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/import", { headers: bearer, body: [cpaCredential(), codexAuthJson()] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: unknown[]; errors: unknown[] };
    expect(body.imported).toHaveLength(2);

    const list = await call(env, "GET", "/api/accounts", { headers: bearer });
    const text = await list.text();
    expect(text).not.toContain("rt-fake");
    expect(text).not.toContain("access_token");
    const { accounts } = JSON.parse(text) as { accounts: { id: string; email: string }[] };
    expect(accounts.map((a) => a.email).sort()).toEqual(["user1@example.com", "user2@example.com"]);

    const del = await call(env, "POST", "/api/accounts/delete", { headers: bearer, body: { ids: [accounts[0].id] } });
    expect(del.status).toBe(200);
    const after = (await (await call(env, "GET", "/api/accounts", { headers: bearer })).json()) as { accounts: unknown[] };
    expect(after.accounts).toHaveLength(1);
  });

  it("重複匯入覆蓋 token、保留啟用狀態與 addedAt", async () => {
    const env = makeEnv();
    await call(env, "POST", "/api/import", { headers: bearer, body: cpaCredential() });
    const key = [...env.kv.store.keys()].find((k) => k.startsWith("account:"))!;
    const stored = JSON.parse(env.kv.store.get(key)!.value);
    stored.invalid = true;
    await env.kv.put(key, JSON.stringify(stored));
    await call(env, "POST", "/api/accounts/enabled", { headers: bearer, body: { ids: [stored.id], enabled: true } });

    await call(env, "POST", "/api/import", { headers: bearer, body: { ...cpaCredential(), refresh_token: "rt-new" } });
    expect([...env.kv.store.keys()].filter((k) => k.startsWith("account:"))).toHaveLength(1);
    const updated = JSON.parse(env.kv.store.get(key)!.value);
    expect(updated.tokens.refresh_token).toBe("rt-new");
    const { accounts } = (await (await call(env, "GET", "/api/accounts", { headers: bearer })).json()) as { accounts: { enabled: boolean }[] };
    expect(accounts[0].enabled).toBe(true);
    expect(updated.invalid).toBe(false);
    expect(updated.addedAt).toBe(stored.addedAt);
  });

  it("全部失敗回 400 並列出錯誤", async () => {
    const res = await call(makeEnv(), "POST", "/api/import", { headers: bearer, body: [{ foo: 1 }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { path: string }[] };
    expect(body.errors[0].path).toBe("$[0]");
  });

  it("KV list() 還看不到新 key 時，靠索引仍能列出；刪除後從索引移除", async () => {
    const env = makeEnv();
    env.kv.list = async () => ({ keys: [], list_complete: true, cursor: "", cacheStatus: null });
    await call(env, "POST", "/api/import", { headers: bearer, body: cpaCredential() });
    const { accounts } = (await (await call(env, "GET", "/api/accounts", { headers: bearer })).json()) as { accounts: { id: string }[] };
    expect(accounts).toHaveLength(1);
    await call(env, "POST", "/api/accounts/delete", { headers: bearer, body: { ids: [accounts[0].id] } });
    expect(JSON.parse(env.kv.store.get("index:accounts")!.value)).toEqual([]);
  });

  it("刪除不存在的帳號：回傳空清單、不動 KV", async () => {
    const env = makeEnv();
    await call(env, "POST", "/api/import", { headers: bearer, body: cpaCredential() });
    env.kv.resetOps();
    const res = await call(env, "POST", "/api/accounts/delete", { headers: bearer, body: { ids: ["nope"] } });
    expect(await res.json()).toEqual({ deleted: [] });
    expect(env.kv.ops.put + env.kv.ops.delete).toBe(0);
  });
});
