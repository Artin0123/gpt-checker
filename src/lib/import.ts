import { isObj, str, type Obj } from "./json";
import { claimsOf } from "./jwt";
import type { Credential } from "./types";

export interface ImportItemResult {
  /** 在輸入中的位置，例如 `$`、`$.accounts[1]`、`$[0]` */
  path: string;
  credential?: Credential;
  /** 無法匯入的原因 */
  error?: string;
}

/**
 * 判斷順序（同 codex-tools expand_import_value）：
 * accounts store → stored account（authJson/auth_json）→ 陣列 → auth.json（tokens 物件）→ CPA 扁平格式
 */
export function parseImport(value: unknown, path = "$"): ImportItemResult[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => parseImport(v, `${path}[${i}]`));
  if (!isObj(value)) return [{ path, error: "不是 JSON 物件" }];

  if (Array.isArray(value.accounts)) {
    return value.accounts.flatMap((v, i) => parseImport(v, `${path}.accounts[${i}]`));
  }

  const authJson = value.authJson ?? value.auth_json;
  if (authJson !== undefined) {
    if (str(value.sourceKind) && value.sourceKind !== "chatgpt") {
      return [{ path, error: `不支援的 sourceKind: ${String(value.sourceKind)}` }];
    }
    if (!isObj(authJson)) return [{ path, error: "authJson 不是物件" }];
    const inner = parseSingle(authJson, path);
    if (inner.credential) {
      const c = inner.credential;
      c.email ??= str(value.email);
      c.planType ??= str(value.planType) ?? str(value.plan_type);
    }
    return [inner];
  }

  return [parseSingle(value, path)];
}

function parseSingle(value: Obj, path: string): ImportItemResult {
  let raw: {
    id_token: string | null;
    access_token: string | null;
    refresh_token: string | null;
    account_id: string | null;
    email: string | null;
    plan_type: string | null;
    expired: string | null;
    last_refresh: string | null;
  };

  if (isObj(value.tokens)) {
    // ~/.codex/auth.json
    const t = value.tokens;
    raw = {
      id_token: str(t.id_token),
      access_token: str(t.access_token),
      refresh_token: str(t.refresh_token),
      account_id: str(t.account_id),
      email: null,
      plan_type: null,
      expired: null,
      last_refresh: str(value.last_refresh),
    };
  } else if ("access_token" in value || "refresh_token" in value || "id_token" in value) {
    // CPA 扁平格式
    if (str(value.type) && value.type !== "codex") {
      return { path, error: `不支援的憑證類型: ${String(value.type)}` };
    }
    raw = {
      id_token: str(value.id_token),
      access_token: str(value.access_token),
      refresh_token: str(value.refresh_token),
      account_id: str(value.account_id),
      email: str(value.email),
      plan_type: str(value.plan_type),
      expired: str(value.expired),
      last_refresh: str(value.last_refresh),
    };
  } else {
    return { path, error: "無法辨識的格式" };
  }

  if (!raw.refresh_token) return { path, error: "缺少 refresh_token" };

  const idClaims = claimsOf(raw.id_token);
  const atClaims = claimsOf(raw.access_token);
  const accountId = raw.account_id ?? idClaims.accountId ?? atClaims.accountId;
  if (!accountId) return { path, error: "缺少 account_id，且無法從 token 取得" };

  const expFromToken = atClaims.exp ? new Date(atClaims.exp * 1000).toISOString() : null;

  return {
    path,
    credential: {
      tokens: {
        id_token: raw.id_token ?? "",
        access_token: raw.access_token ?? "",
        refresh_token: raw.refresh_token,
      },
      accountId,
      email: raw.email ?? idClaims.email ?? atClaims.email,
      planType: raw.plan_type ?? idClaims.planType ?? atClaims.planType,
      expired: raw.expired ?? expFromToken,
      lastRefresh: raw.last_refresh,
    },
  };
}
