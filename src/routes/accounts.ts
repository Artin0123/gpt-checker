import { HttpError, json, readJson } from "../http";
import { parseImport } from "../lib/import";
import {
  deleteAccounts,
  getConfig,
  isDiscordWebhook,
  listAccounts,
  normalizeRepoUrl,
  publicConfig,
  setEnabled,
  toSummary,
  updateConfig,
  upsertCredentials,
  type PanelConfig,
} from "../lib/kv";
import type { Credential } from "../lib/types";
import type { Handler } from "../router";

export const listAccountsRoute: Handler = async ({ env }) => {
  const accounts = await listAccounts(env);
  return json({ accounts: accounts.map(toSummary) });
};

/** 面板上方按鈕用：body.ids 必須是非空字串陣列 */
function readIds(body: { ids?: unknown }): string[] {
  const ids = body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length <= 64)) {
    throw new HttpError(400, "ids must be a non-empty array of account ids");
  }
  return ids as string[];
}

/** 刪除選取的帳號（一次請求） */
export const deleteAccountsRoute: Handler = async ({ request, env }) => {
  const ids = readIds(await readJson(request));
  return json({ deleted: await deleteAccounts(env, ids) });
};

/** 啟用 / 停用選取的帳號（交給 GHA 處理與否）：整份清單是一個 KV key，一次請求只寫一次 */
export const setEnabledRoute: Handler = async ({ request, env }) => {
  const body = await readJson<{ ids?: unknown; enabled?: unknown }>(request);
  const ids = readIds(body);
  if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
  return json({ enabled: await setEnabled(env, ids, body.enabled) });
};

/** body 為任意 JSON：單一憑證、陣列、codex-tools accounts.json 皆可 */
export const importRoute: Handler = async ({ request, env }) => {
  const body = await readJson(request);
  const results = parseImport(body);
  const creds: { path: string; credential: Credential }[] = [];
  const errors = [];
  for (const r of results) {
    if (r.credential) creds.push({ path: r.path, credential: r.credential });
    else errors.push({ path: r.path, error: r.error ?? "unknown error" });
  }
  const saved = await upsertCredentials(
    env,
    creds.map((c) => c.credential),
  );
  const imported = saved.map((a, i) => ({ path: creds[i].path, account: { id: a.id, email: a.email, accountId: a.accountId, planType: a.planType } }));
  return json({ imported, errors }, imported.length === 0 && errors.length > 0 ? 400 : 200);
};

export const getConfigRoute: Handler = async ({ env }) => json({ config: publicConfig(await getConfig(env)) });

/**
 * 部分更新設定。沒帶的欄位不變；`discordWebhook: ""` 或 null 代表清除。
 * 內容沒變就不寫 KV；前端的模式開關也會先合併連續切換再送。
 */
export const putConfigRoute: Handler = async ({ request, env }) => {
  const body = await readJson<{ repoUrl?: unknown; manualMode?: unknown; discordWebhook?: unknown }>(request);
  const patch: Partial<PanelConfig> = {};
  if (body.repoUrl !== undefined) {
    if (body.repoUrl === null || body.repoUrl === "") patch.repoUrl = null;
    else if (typeof body.repoUrl !== "string" || !normalizeRepoUrl(body.repoUrl)) {
      throw new HttpError(400, "repoUrl must look like https://github.com/<owner>/<repo>");
    } else patch.repoUrl = normalizeRepoUrl(body.repoUrl);
  }
  if (body.manualMode !== undefined) {
    if (body.manualMode !== "usage" && body.manualMode !== "hi") throw new HttpError(400, 'manualMode must be "usage" or "hi"');
    patch.manualMode = body.manualMode;
  }
  if (body.discordWebhook !== undefined) {
    if (body.discordWebhook === null || body.discordWebhook === "") patch.discordWebhook = null;
    else if (typeof body.discordWebhook !== "string" || !isDiscordWebhook(body.discordWebhook.trim())) {
      throw new HttpError(400, "discordWebhook must be https://discord.com/api/webhooks/<id>/<token>");
    } else patch.discordWebhook = body.discordWebhook.trim();
  }
  return json({ config: publicConfig(await updateConfig(env, patch)) });
};
