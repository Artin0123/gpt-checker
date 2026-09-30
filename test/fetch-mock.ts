import { vi } from "vitest";

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

type Responder = (req: Recorded) => Response | Promise<Response>;

/** 依 URL 前綴回應；每個前綴可給單一 responder 或依序使用的佇列 */
export function mockFetch(routes: Record<string, Responder | Responder[]>) {
  const calls: Recorded[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const rec: Recorded = { url: req.url, method: req.method, headers: req.headers, body: await req.text() };
    calls.push(rec);
    for (const [prefix, r] of queues) {
      if (!rec.url.startsWith(prefix)) continue;
      const responder = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]) : r;
      if (!responder) break;
      return responder(rec);
    }
    throw new Error(`unexpected fetch ${rec.method} ${rec.url}`);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

export const jsonRes = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
