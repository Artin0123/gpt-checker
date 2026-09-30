import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCallback, pkceChallenge } from "../src/lib/oauth";
import { TOKEN_URL } from "../src/lib/openai";
import { bearer, call, makeEnv } from "./helpers";
import { fakeAccessToken, fakeIdToken } from "./fixtures";
import { jsonRes, mockFetch } from "./fetch-mock";

afterEach(() => vi.unstubAllGlobals());

async function start(env: ReturnType<typeof makeEnv>) {
  const res = await call(env, "POST", "/api/oauth/start", { headers: bearer });
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; state: string };
}

const tokenOk = () =>
  jsonRes({
    access_token: fakeAccessToken(),
    refresh_token: "rt-oauth",
    id_token: fakeIdToken({ email: "oauth@example.com", accountId: "acc-oauth", plan: "free" }),
    expires_in: 864000,
  });

describe("OAuth start", () => {
  it("授權網址參數與 CPA 相同，session 存入 KV", async () => {
    const env = makeEnv();
    const { url, state } = await start(env);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
    const q = Object.fromEntries(u.searchParams);
    expect(q).toMatchObject({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      response_type: "code",
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid email profile offline_access",
      state,
      code_challenge_method: "S256",
      prompt: "login",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });
    const session = JSON.parse(env.kv.store.get(`oauth:${state}`)!.value);
    expect(q.code_challenge).toBe(await pkceChallenge(session.codeVerifier));
    expect(env.kv.store.get(`oauth:${state}`)!.expiresAt).toBeGreaterThan(Date.now() + 899_000);
  });
});

describe("parseCallback", () => {
  it("從完整網址、只有 path、明確欄位取值", () => {
    const state = "s".repeat(32);
    expect(parseCallback({ redirect_url: `http://localhost:1455/auth/callback?code=c1&state=${state}` })).toEqual({ state, code: "c1", error: "" });
    expect(parseCallback({ redirect_url: `/auth/callback?code=c2&state=${state}` }).code).toBe("c2");
    expect(parseCallback({ state, error: "access_denied" }).error).toBe("access_denied");
  });

  it("缺 state、state 格式錯、缺 code 與 error", () => {
    expect(() => parseCallback({ redirect_url: "http://localhost:1455/auth/callback?code=c" })).toThrow("state is required");
    expect(() => parseCallback({ state: "bad state!", code: "c" })).toThrow("invalid state");
    expect(() => parseCallback({ state: "s".repeat(32) })).toThrow("code or error is required");
  });
});

describe("OAuth callback", () => {
  it("成功：換 token 並新增帳號，form 與 CPA 相同", async () => {
    const env = makeEnv();
    const { state } = await start(env);
    const session = JSON.parse(env.kv.store.get(`oauth:${state}`)!.value);
    const { calls } = mockFetch({ [TOKEN_URL]: tokenOk });
    const res = await call(env, "POST", "/api/oauth/callback", {
      headers: bearer,
      body: { redirect_url: `http://localhost:1455/auth/callback?code=the-code&scope=x&state=${state}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { account: { email: string; accountId: string; planType: string } };
    expect(body.account).toMatchObject({ email: "oauth@example.com", accountId: "acc-oauth", planType: "free" });
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "the-code",
      redirect_uri: "http://localhost:1455/auth/callback",
      code_verifier: session.codeVerifier,
    });
  });

  it("成功後 session 被刪除：重複送出回 404，不會再換一次 token", async () => {
    const env = makeEnv();
    const { state } = await start(env);
    const { calls } = mockFetch({ [TOKEN_URL]: tokenOk });
    const body = { redirect_url: `http://localhost:1455/auth/callback?code=c&state=${state}` };
    expect((await call(env, "POST", "/api/oauth/callback", { headers: bearer, body })).status).toBe(200);
    expect((await call(env, "POST", "/api/oauth/callback", { headers: bearer, body })).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("state 不存在或過期回 404", async () => {
    const env = makeEnv();
    const res = await call(env, "POST", "/api/oauth/callback", {
      headers: bearer,
      body: { redirect_url: `http://localhost:1455/auth/callback?code=c&state=${"x".repeat(32)}` },
    });
    expect(res.status).toBe(404);
  });

  it("網址帶 error：回 502、不打 token endpoint、不寫 KV", async () => {
    const env = makeEnv();
    const { state } = await start(env);
    const { calls } = mockFetch({});
    env.kv.resetOps();
    const body = { redirect_url: `http://localhost:1455/auth/callback?error=access_denied&state=${state}` };
    const res = await call(env, "POST", "/api/oauth/callback", { headers: bearer, body });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("access_denied");
    expect(calls).toHaveLength(0);
    expect(env.kv.ops.put).toBe(0);
  });

  it("token endpoint 失敗回 502；沒有 refresh_token 也拒絕", async () => {
    const env = makeEnv();
    mockFetch({
      [TOKEN_URL]: [() => jsonRes({ error: "invalid_grant" }, 400), () => jsonRes({ access_token: "a", id_token: fakeIdToken() })],
    });
    for (const expected of ["invalid_grant", "missing refresh_token"]) {
      const { state } = await start(env);
      const res = await call(env, "POST", "/api/oauth/callback", {
        headers: bearer,
        body: { redirect_url: `http://localhost:1455/auth/callback?code=c&state=${state}` },
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain(expected);
    }
    expect([...env.kv.store.keys()].some((k) => k.startsWith("account:"))).toBe(false);
  });
});
