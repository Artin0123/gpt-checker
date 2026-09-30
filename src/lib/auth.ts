import type { Env } from "../env";
import { secretEquals } from "./crypto";
import { SESSION_COOKIE, readCookie, verifySessionToken } from "./session";

export function passwordMatches(given: string, env: Env): Promise<boolean> {
  return secretEquals(given, env.PANEL_PASSWORD);
}

/** 瀏覽器用簽章 cookie，GHA 用 `Authorization: Bearer <PANEL_PASSWORD>` */
export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization");
  if (auth !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    return match ? passwordMatches(match[1], env) : false;
  }
  const token = readCookie(request, SESSION_COOKIE);
  return token ? verifySessionToken(token, env.SESSION_SECRET) : false;
}
