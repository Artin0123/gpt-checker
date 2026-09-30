import type { Env } from "./env";
import { HttpError, errorResponse } from "./http";
import { isAuthorized } from "./lib/auth";
import { matchPath, type Route } from "./router";
import { deleteAccountsRoute, getConfigRoute, importRoute, listAccountsRoute, putConfigRoute, setEnabledRoute } from "./routes/accounts";
import { ghaListRoute, ghaStatusRoute, ghaTokenRoute } from "./routes/gha";
import { exportRoute, oauthCallbackRoute, oauthStartRoute } from "./routes/oauth-export";
import { login, logout, me } from "./routes/session";

export const routes: Route[] = [
  { method: "POST", path: "/api/login", handler: login, public: true },
  { method: "POST", path: "/api/logout", handler: logout, public: true },
  { method: "GET", path: "/api/me", handler: me },
  { method: "GET", path: "/api/accounts", handler: listAccountsRoute },
  { method: "POST", path: "/api/accounts/enabled", handler: setEnabledRoute },
  { method: "POST", path: "/api/accounts/delete", handler: deleteAccountsRoute },
  { method: "POST", path: "/api/import", handler: importRoute },
  { method: "GET", path: "/api/export", handler: exportRoute },
  { method: "POST", path: "/api/oauth/start", handler: oauthStartRoute },
  { method: "POST", path: "/api/oauth/callback", handler: oauthCallbackRoute },
  { method: "GET", path: "/api/config", handler: getConfigRoute },
  { method: "PUT", path: "/api/config", handler: putConfigRoute },
  { method: "GET", path: "/api/gha/accounts", handler: ghaListRoute },
  { method: "PATCH", path: "/api/gha/accounts/:id/tokens", handler: ghaTokenRoute },
  { method: "POST", path: "/api/gha/status", handler: ghaStatusRoute },
];

/** 會改狀態的 cookie 請求要求同源（SameSite=Strict 之外再擋一層 CSRF） */
function sameOriginOk(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  if (request.headers.get("Authorization")) return true;
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  // 設定缺漏時一律拒絕（fail closed）
  if (!env.PANEL_PASSWORD) {
    return errorResponse(500, "server misconfigured: PANEL_PASSWORD not set");
  }
  const url = new URL(request.url);

  let matched: { route: Route; params: Record<string, string> } | null = null;
  let pathExists = false;
  for (const route of routes) {
    const params = matchPath(route.path, url.pathname);
    if (!params) continue;
    pathExists = true;
    if (route.method === request.method) {
      matched = { route, params };
      break;
    }
  }

  if (!matched?.route.public && !(await isAuthorized(request, env))) {
    return errorResponse(401, "unauthorized");
  }
  if (!matched) return errorResponse(pathExists ? 405 : 404, pathExists ? "method not allowed" : "not found");
  if (!sameOriginOk(request, url)) return errorResponse(403, "cross-origin request rejected");

  try {
    return await matched.route.handler({ request, env, url, params: matched.params });
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    // 只記錄錯誤訊息，避免把 token 之類的內容寫進 log
    console.error("unhandled error", err instanceof Error ? err.message : String(err));
    return errorResponse(500, "internal error");
  }
}
