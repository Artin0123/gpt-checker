// 去識別化的假資料：JWT 由本檔產生，簽章為假值
import { b64urlEncode } from "../src/lib/crypto";

const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));

export function fakeJwt(payload: Record<string, unknown>): string {
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.fake-signature`;
}

export function fakeIdToken(opts: { email?: string; accountId?: string; plan?: string } = {}) {
  return fakeJwt({
    email: opts.email ?? "user1@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId ?? "acc-00000000-0000-0000-0000-000000000001",
      chatgpt_plan_type: opts.plan ?? "free",
    },
  });
}

export function fakeAccessToken(expUnix = 2_000_000_000, accountId = "acc-00000000-0000-0000-0000-000000000001") {
  return fakeJwt({ exp: expUnix, "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

export const cpaCredential = () => ({
  type: "codex",
  id_token: fakeIdToken(),
  access_token: fakeAccessToken(),
  refresh_token: "rt-fake-cpa",
  account_id: "acc-00000000-0000-0000-0000-000000000001",
  email: "user1@example.com",
  expired: "2033-05-18T03:33:20.000Z",
  last_refresh: "2026-09-01T00:00:00Z",
  plan_type: "free",
});

export const codexAuthJson = (email = "user2@example.com", accountId = "acc-00000000-0000-0000-0000-000000000002") => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: fakeIdToken({ email, accountId, plan: "plus" }),
    access_token: fakeAccessToken(2_000_000_000, accountId),
    refresh_token: "rt-fake-authjson",
    account_id: accountId,
  },
  last_refresh: "2026-09-02T00:00:00Z",
});

export const codexToolsStore = () => ({
  version: 2,
  accounts: [
    {
      id: "ct-1",
      label: "work",
      sourceKind: "chatgpt",
      email: "user3@example.com",
      accountId: "acc-00000000-0000-0000-0000-000000000003",
      planType: "team",
      authJson: codexAuthJson("user3@example.com", "acc-00000000-0000-0000-0000-000000000003"),
      addedAt: 1_780_000_000,
      updatedAt: 1_780_000_000,
      usage: null,
    },
    { id: "ct-2", label: "relay", sourceKind: "relay", accountId: "x", authJson: {} },
  ],
  settings: {},
});
