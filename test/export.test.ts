import { describe, expect, it } from "vitest";
import { parseImport } from "../src/lib/import";
import { safeFileName } from "../src/lib/export";
import { bearer, call, makeEnv } from "./helpers";
import { codexAuthJson, cpaCredential } from "./fixtures";

async function seed() {
  const env = makeEnv();
  await call(env, "POST", "/api/import", { headers: bearer, body: [cpaCredential(), codexAuthJson()] });
  const { accounts } = (await (await call(env, "GET", "/api/accounts", { headers: bearer })).json()) as {
    accounts: { id: string; email: string }[];
  };
  return { env, accounts };
}

describe("匯出選取的帳號（CPA 格式）", () => {
  it("單一帳號：欄位與 CPA token.go 相同，可再匯入", async () => {
    const { env, accounts } = await seed();
    const a = accounts.find((x) => x.email === "user1@example.com")!;
    const res = await call(env, "GET", `/api/export?ids=${encodeURIComponent(a.id)}`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="codex-user1@example.com.json"');
    const data = await res.json();
    expect(data).toEqual(cpaCredential());
    const [r] = parseImport(data);
    expect(r.credential?.tokens.refresh_token).toBe("rt-fake-cpa");
  });

  it("多個帳號：輸出陣列，匯回另一個面板內容一致；只讀選取的帳號", async () => {
    const { env, accounts } = await seed();
    env.kv.resetOps();
    const res = await call(env, "GET", `/api/export?ids=${accounts.map((a) => a.id).join(",")}`, { headers: bearer });
    expect(env.kv.ops.get).toBe(accounts.length);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="codex-2-accounts.json"');
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(2);

    const env2 = makeEnv();
    await call(env2, "POST", "/api/import", { headers: bearer, body: data });
    const strip = (e: typeof env) =>
      [...e.kv.store.entries()]
        .filter(([k]) => k.startsWith("account:"))
        .map(([k, v]) => {
          const a = JSON.parse(v.value);
          return [k, a.email, a.accountId, a.planType, a.tokens, a.lastRefresh, a.expired];
        })
        .sort();
    expect(strip(env2)).toEqual(strip(env));
  });

  it("沒帶 ids 400、沒有符合的帳號 404；匯出不寫 KV", async () => {
    const { env } = await seed();
    env.kv.resetOps();
    expect((await call(env, "GET", "/api/export", { headers: bearer })).status).toBe(400);
    expect((await call(env, "GET", "/api/export?ids=nope", { headers: bearer })).status).toBe(404);
    expect(env.kv.ops.put + env.kv.ops.delete + env.kv.ops.list).toBe(0);
  });

  it("safeFileName", () => {
    expect(safeFileName('a"b/c\\d e@x.com')).toBe("a_b_c_d_e@x.com");
  });
});
