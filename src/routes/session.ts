import { HttpError, json, readJson } from "../http";
import { passwordMatches } from "../lib/auth";
import { SESSION_COOKIE, clearSessionCookie, createSession, deleteSession, readCookie, sessionCookie } from "../lib/session";
import type { Handler } from "../router";

export const login: Handler = async ({ request, env }) => {
  const body = await readJson<{ password?: unknown }>(request);
  if (typeof body.password !== "string" || !(await passwordMatches(body.password, env))) {
    throw new HttpError(401, "invalid password");
  }
  const token = await createSession(env);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token) });
};

export const logout: Handler = async ({ request, env }) => {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await deleteSession(env, token);
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
};

export const me: Handler = async () => json({ ok: true });
