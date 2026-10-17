import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthManager } from "./AuthManager";
import type { TogetherSettings } from "../types";

const URL = "https://hub.test";

function jwt(expSecondsFromNow: number): string {
  const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  return `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1", exp })}.sig`;
}

function makeSettings(): TogetherSettings {
  return {
    accounts: [{ username: "alice", serverUrl: URL, userId: "u1", token: "old-jwt", refreshToken: "rt-1" }],
    activeAccountIndex: 0,
  } as unknown as TogetherSettings;
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return { status, json: async () => body } as Response;
}

describe("AuthManager.refreshSession", () => {
  let settings: TogetherSettings;
  let auth: AuthManager;
  const fetchMock = vi.fn();

  beforeEach(() => {
    settings = makeSettings();
    auth = new AuthManager(() => settings);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("stores the rotated tokens and updates the in-memory token", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return jsonResponse(201, { token: "new-jwt", refreshToken: "rt-2" });
      if (url.endsWith("/auth/me")) return jsonResponse(200, { id: "u1", username: "alice" });
      throw new Error(`unexpected ${url}`);
    });

    expect(await auth.refreshSession()).toBe(true);
    expect(settings.accounts[0].token).toBe("new-jwt");
    expect(settings.accounts[0].refreshToken).toBe("rt-2");
    expect(auth.getState().token).toBe("new-jwt");
    expect(auth.getState().isLoggedIn).toBe(true);
  });

  it("deduplicates concurrent calls into a single /auth/refresh request", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) return jsonResponse(201, { token: "new-jwt", refreshToken: "rt-2" });
      return jsonResponse(200, { id: "u1", username: "alice" });
    });

    const results = await Promise.all([auth.refreshSession(), auth.refreshSession(), auth.refreshSession()]);
    expect(results).toEqual([true, true, true]);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/auth/refresh"))).toHaveLength(1);
  });

  it("clears the refresh token when the server definitively rejects it", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));
    expect(await auth.refreshSession()).toBe(false);
    expect(settings.accounts[0].refreshToken).toBeUndefined();
  });

  it("keeps the refresh token on network failure so it can retry later", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await auth.refreshSession()).toBe(false);
    expect(settings.accounts[0].refreshToken).toBe("rt-1");
  });

  it("returns false without calling the server when there is no refresh token", async () => {
    settings.accounts[0].refreshToken = undefined;
    expect(await auth.refreshSession()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AuthManager.tokenExpiresWithin", () => {
  it("reads the exp claim of the active token", async () => {
    const settings = makeSettings();
    const auth = new AuthManager(() => settings);
    const token = jwt(3600); // 1h left
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { id: "u1", username: "alice" })));
    await auth.validateToken(token, URL);
    vi.unstubAllGlobals();

    expect(auth.tokenExpiresWithin(2 * 3600 * 1000)).toBe(true);
    expect(auth.tokenExpiresWithin(30 * 60 * 1000)).toBe(false);
  });

  it("returns false for tokens without a readable exp claim", () => {
    const settings = makeSettings();
    const auth = new AuthManager(() => settings);
    expect(auth.tokenExpiresWithin(1000)).toBe(false); // no token
  });
});
