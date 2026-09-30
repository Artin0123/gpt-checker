import type { Env } from "../src/env";
import { handleApi } from "../src/app";

/** 最小可用的 in-memory KVNamespace（get/put/delete/list + expirationTtl），並計算各操作次數 */
export class MemoryKV {
  store = new Map<string, { value: string; expiresAt?: number }>();
  ops = { get: 0, put: 0, delete: 0, list: 0 };
  putKeys: string[] = [];

  resetOps() {
    this.ops = { get: 0, put: 0, delete: 0, list: 0 };
    this.putKeys = [];
  }

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  async get(key: string, type?: "text" | "json" | { type: "text" | "json" }): Promise<unknown> {
    this.ops.get++;
    const entry = this.live(key);
    if (!entry) return null;
    const t = typeof type === "object" ? type.type : type;
    return t === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.ops.put++;
    this.putKeys.push(key);
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.ops.delete++;
    this.store.delete(key);
  }

  async list(opts: { prefix?: string } = {}) {
    this.ops.list++;
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? "") && this.live(k))
      .sort()
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "", cacheStatus: null };
  }
}

export const TEST_PASSWORD = "test-password-0123456789";

export function makeEnv(overrides: Partial<Env> = {}): Env & { kv: MemoryKV } {
  const kv = new MemoryKV();
  return {
    ACCOUNTS: kv as unknown as KVNamespace,
    PANEL_PASSWORD: TEST_PASSWORD,
    kv,
    ...overrides,
  };
}

export function call(env: Env, method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    headers.set("Content-Type", "application/json");
  }
  return handleApi(new Request(`https://panel.test${path}`, { method, headers, body }), env);
}

export const bearer = { Authorization: `Bearer ${TEST_PASSWORD}` };
