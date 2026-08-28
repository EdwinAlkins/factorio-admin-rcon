import { afterEach, describe, expect, it } from "vitest";
import { clientIp, cookieOptions, isSecureRequest, rateKey } from "@/server/http/context";
import { resetEnvCache, withEnv } from "../helpers";

function request(headers: Record<string, string> = {}, url = "http://panel.test/api/x") {
  return new Request(url, { headers });
}

afterEach(() => {
  withEnv({ TRUST_PROXY: undefined, COOKIE_SECURE: undefined });
  resetEnvCache();
});

describe("client IP", () => {
  it("ignores proxy headers by default", () => {
    // Without a trusted reverse proxy, anyone can forge a different IP on every
    // request and reset their own attempt limit.
    const forged = request({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });

    expect(clientIp(forged)).toBeNull();
    expect(rateKey(forged)).toEqual({ key: "global", perIp: false });
  });

  it("takes the first address in the chain when the proxy is trusted", () => {
    withEnv({ TRUST_PROXY: "true" });

    const chained = request({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" });
    expect(clientIp(chained)).toBe("1.2.3.4");
    expect(rateKey(chained)).toEqual({ key: "ip:1.2.3.4", perIp: true });
  });

  it("falls back to x-real-ip then to the global bucket", () => {
    withEnv({ TRUST_PROXY: "true" });

    expect(clientIp(request({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(request())).toBeNull();
    expect(rateKey(request())).toEqual({ key: "global", perIp: false });
  });
});

describe("session cookie", () => {
  it("is always httpOnly, SameSite=Lax and scoped to the root", () => {
    expect(cookieOptions(request(), 3600)).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
  });

  it("is only marked secure in auto mode when the request is encrypted", () => {
    expect(cookieOptions(request(), 60).secure).toBe(false);
    expect(cookieOptions(request({}, "https://panel.test/api/x"), 60).secure).toBe(true);
  });

  it("ignores x-forwarded-proto until the proxy is trusted", () => {
    const spoofed = request({ "x-forwarded-proto": "https" });
    expect(isSecureRequest(spoofed)).toBe(false);

    withEnv({ TRUST_PROXY: "true" });
    expect(isSecureRequest(spoofed)).toBe(true);
  });

  it("obeys COOKIE_SECURE when it is forced", () => {
    withEnv({ COOKIE_SECURE: "true" });
    expect(cookieOptions(request(), 60).secure).toBe(true);

    withEnv({ COOKIE_SECURE: "false" });
    expect(cookieOptions(request({}, "https://panel.test/api/x"), 60).secure).toBe(false);
  });
});
