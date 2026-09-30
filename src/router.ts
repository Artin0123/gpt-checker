import type { Env } from "./env";

export interface Ctx {
  request: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Response>;

export interface Route {
  method: string;
  /** 例如 `/api/accounts/:id/usage` */
  path: string;
  handler: Handler;
  /** 不需要登入 */
  public?: boolean;
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) {
      try {
        params[p[i].slice(1)] = decodeURIComponent(s[i]);
      } catch {
        return null;
      }
    } else if (p[i] !== s[i]) {
      return null;
    }
  }
  return params;
}
