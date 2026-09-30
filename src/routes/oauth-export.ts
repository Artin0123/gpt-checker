import { HttpError, json, readJson } from "../http";
import { safeFileName, toCpa } from "../lib/export";
import { listAccounts, upsertCredentials } from "../lib/kv";
import { OAuthCallbackError, completeOAuth, startOAuth, type CallbackInput } from "../lib/oauth";
import type { Handler } from "../router";

export const oauthStartRoute: Handler = async ({ env }) => json(await startOAuth(env));

export const oauthCallbackRoute: Handler = async ({ request, env }) => {
  const body = await readJson<CallbackInput>(request);
  try {
    const cred = await completeOAuth(env, body ?? {});
    const [a] = await upsertCredentials(env, [cred]);
    return json({ account: { id: a.id, email: a.email, accountId: a.accountId, planType: a.planType } });
  } catch (err) {
    if (err instanceof OAuthCallbackError) throw new HttpError(err.status, err.message);
    throw err;
  }
};

function download(data: unknown, filename: string): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 匯出選取的帳號（只讀 KV），CLIProxyAPI 格式：
 *   ?ids=a,b  一個帳號是單一物件，多個帳號是陣列（本面板可直接匯回）
 */
export const exportRoute: Handler = async ({ env, url }) => {
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  if (ids.length === 0) throw new HttpError(400, "ids is required");
  const wanted = new Set(ids);
  const accounts = (await listAccounts(env)).filter((a) => wanted.has(a.id));
  if (accounts.length === 0) throw new HttpError(404, "no matching accounts");
  return accounts.length === 1
    ? download(toCpa(accounts[0]), `codex-${safeFileName(accounts[0].email ?? accounts[0].accountId)}.json`)
    : download(accounts.map(toCpa), `codex-${accounts.length}-accounts.json`);
};
