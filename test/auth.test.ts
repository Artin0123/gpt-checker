import { describe, expect, it } from "vitest";
import { bearer, call, makeEnv, TEST_PASSWORD } from "./helpers";

describe("API 驗證", () => {
  it("未登入回 401", async () => {
    const res = await call(makeEnv(), "GET", "/api/me");
    expect(res.status).toBe(401);
  });

  it("未知路徑未登入也回 401（不洩漏路由）", async () => {
    const res = await call(makeEnv(), "GET", "/api/nope");
    expect(res.status).toBe(401);
  });

  it("Bearer 正確密碼可通過", async () => {
    const res = await call(makeEnv(), "GET", "/api/me", { headers: bearer });
    expect(res.status).toBe(200);
  });

  it("Bearer 錯誤密碼 401，且不會退回 cookie 驗證", async () => {
    const env = makeEnv();
    const login = await call(env, "POST", "/api/login", { body: { password: TEST_PASSWORD } });
    const cookie = login.headers.get("Set-Cookie")!.split(";")[0];
    const res = await call(env, "GET", "/api/me", { headers: { Authorization: "Bearer wrong", Cookie: cookie } });
    expect(res.status).toBe(401);
  });

  it("登入錯誤密碼回 401，不發 cookie", async () => {
    const res = await call(makeEnv(), "POST", "/api/login", { body: { password: "wrong" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("登入成功發出安全屬性 cookie，之後可存取", async () => {
    const env = makeEnv();
    const login = await call(env, "POST", "/api/login", { body: { password: TEST_PASSWORD } });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("Set-Cookie")!;
    for (const attr of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) expect(setCookie).toContain(attr);
    const res = await call(env, "GET", "/api/me", { headers: { Cookie: setCookie.split(";")[0] } });
    expect(res.status).toBe(200);
  });

  it("未設定密碼時 fail closed", async () => {
    const res = await call(makeEnv({ PANEL_PASSWORD: "" }), "POST", "/api/login", { body: { password: "" } });
    expect(res.status).toBe(500);
  });

  it("已登入但未知路徑回 404、錯誤方法回 405", async () => {
    const env = makeEnv();
    expect((await call(env, "GET", "/api/nope", { headers: bearer })).status).toBe(404);
    expect((await call(env, "DELETE", "/api/me", { headers: bearer })).status).toBe(405);
  });

  it("壞掉的 JSON 回 400", async () => {
    const res = await call(makeEnv(), "POST", "/api/login", { body: "{not json" });
    expect(res.status).toBe(400);
  });
});
