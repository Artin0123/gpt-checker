import { describe, expect, it } from "vitest";
import { createSessionToken, readCookie, verifySessionToken, SESSION_TTL_SECONDS } from "../src/lib/session";
import { b64urlDecode, b64urlEncode, secretEquals } from "../src/lib/crypto";

const SECRET = "secret-for-tests-0123456789abcdef";

describe("session token", () => {
  it("簽章後可驗章", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, SECRET)).toBe(true);
  });

  it("換 secret 驗章失敗", async () => {
    const token = await createSessionToken(SECRET);
    expect(await verifySessionToken(token, SECRET + "x")).toBe(false);
  });

  it("竄改 exp 或簽章都會被拒絕", async () => {
    const token = await createSessionToken(SECRET);
    const [v, exp, sig] = token.split(".");
    expect(await verifySessionToken(`${v}.${Number(exp) + 999}.${sig}`, SECRET)).toBe(false);
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(await verifySessionToken(`${v}.${exp}.${flipped}`, SECRET)).toBe(false);
  });

  it("過期會被拒絕", async () => {
    const issued = Date.now() - (SESSION_TTL_SECONDS + 10) * 1000;
    const token = await createSessionToken(SECRET, issued);
    expect(await verifySessionToken(token, SECRET)).toBe(false);
  });

  it("格式錯誤回 false 不丟例外", async () => {
    for (const bad of ["", "abc", "v1.x.y", "v2.1.abc", "v1.123.!!!"]) {
      expect(await verifySessionToken(bad, SECRET)).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("base64url 來回轉換", () => {
    for (const len of [0, 1, 2, 3, 31, 32]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    }
  });

  it("secretEquals", async () => {
    expect(await secretEquals("abc", "abc")).toBe(true);
    expect(await secretEquals("abc", "abd")).toBe(false);
    expect(await secretEquals("abc", "abcd")).toBe(false);
  });

  it("readCookie", () => {
    const req = new Request("https://x", { headers: { Cookie: "a=1; gc_session=v1.2.3; b=4" } });
    expect(readCookie(req, "gc_session")).toBe("v1.2.3");
    expect(readCookie(req, "none")).toBeNull();
  });
});
