import { describe, expect, it } from "vitest";
import { createSession, deleteSession, readCookie, verifySession, SESSION_TTL_SECONDS } from "../src/lib/session";
import { b64urlDecode, b64urlEncode, secretEquals } from "../src/lib/crypto";
import { call, makeEnv, TEST_PASSWORD } from "./helpers";

describe("KV session", () => {
  it("建立後可驗證；KV 只存雜湊不存 token；TTL 7 天", async () => {
    const env = makeEnv();
    const token = await createSession(env);
    expect(await verifySession(env, token)).toBe(true);
    const [key] = [...env.kv.store.keys()];
    expect(key.startsWith("session:")).toBe(true);
    expect(key).not.toContain(token);
    expect(env.kv.store.get(key)!.expiresAt).toBeGreaterThan(Date.now() + (SESSION_TTL_SECONDS - 5) * 1000);
  });

  it("刪除後失效；別的 token 不通過", async () => {
    const env = makeEnv();
    const token = await createSession(env);
    const other = await createSession(env);
    await deleteSession(env, token);
    expect(await verifySession(env, token)).toBe(false);
    expect(await verifySession(env, other)).toBe(true);
  });

  it("格式錯誤回 false 且不查 KV（含舊版 v1 簽章 cookie）", async () => {
    const env = makeEnv();
    env.kv.resetOps();
    for (const bad of ["", "abc", "v1.123.abcdefghijklmnopqrstuvwxyz0123456789", "!".repeat(43)]) {
      expect(await verifySession(env, bad)).toBe(false);
    }
    expect(env.kv.ops.get).toBe(0);
  });

  it("登入寫 1 次、登出刪 1 次，登出後 cookie 失效", async () => {
    const env = makeEnv();
    const login = await call(env, "POST", "/api/login", { body: { password: TEST_PASSWORD } });
    expect(env.kv.ops.put).toBe(1);
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    expect((await call(env, "GET", "/api/me", { headers: { Cookie: cookie } })).status).toBe(200);
    const logout = await call(env, "POST", "/api/logout", { headers: { Cookie: cookie } });
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(env.kv.ops.delete).toBe(1);
    expect((await call(env, "GET", "/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("helpers", () => {
  it("base64url 來回轉換", () => {
    for (const len of [0, 1, 2, 3, 31, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    }
  });

  it("secretEquals", async () => {
    expect(await secretEquals("abc", "abc")).toBe(true);
    expect(await secretEquals("abc", "abd")).toBe(false);
    expect(await secretEquals("abc", "abcd")).toBe(false);
  });

  it("readCookie", () => {
    const req = new Request("https://x", { headers: { Cookie: "a=1; gc_session=v1.2.3; b=4" } });
    expect(readCookie(req, "gc_session")).toBe("v1.2.3");
    expect(readCookie(req, "none")).toBeNull();
  });
});
