import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebAuthService } from "./WebAuthService";
import { AuthManager } from "./AuthManager";
import type { TogetherSettings } from "../types";

const SERVER = "https://api.hubfolks.com";
const WEB = "https://www.hubfolks.com";
const EXPIRED = "Sign-in link expired, please start again";

const session = {
  token: "jwt-web",
  refreshToken: "rt-web",
  user: { id: "u9", username: "dana", displayName: "Dana", isAdmin: false },
  availablePlugins: [],
  branch: "prod",
};

function res(status: number, body: unknown = {}): Response {
  return { status, json: async () => body } as Response;
}

type Handler = (body: any) => Response | Promise<Response>;

function setup(routes: { poll?: Handler; token?: Handler; capabilities?: () => Response | Promise<Response> } = {}) {
  const settings = {
    accounts: [{ username: "alice", serverUrl: SERVER, userId: "u1", token: "old-jwt", refreshToken: "rt-1" }],
    activeAccountIndex: 0,
  } as unknown as TogetherSettings;
  const authManager = new AuthManager(() => settings);
  const storeSession = vi.spyOn(authManager, "storeSession");
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === `${SERVER}/auth/capabilities`) return routes.capabilities ? routes.capabilities() : res(200, { webFlow: true, webUrl: WEB });
    if (url === `${SERVER}/auth/app/start`) return res(200, { flowId: "f1", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
    if (url === `${SERVER}/auth/app/poll`) return routes.poll ? routes.poll(body) : res(200, { status: "pending" });
    if (url === `${SERVER}/auth/app/token`) return routes.token ? routes.token(body) : res(200, session);
    throw new Error(`unexpected ${url}`);
  });
  const emit = vi.fn();
  const saveSettings = vi.fn(async () => {});
  const openUrl = vi.fn();
  const service = new WebAuthService({
    authManager,
    getSettings: () => settings,
    saveSettings,
    emit,
    openUrl,
    vaultName: "My Vault",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { service, settings, storeSession, fetchMock, emit, saveSettings, openUrl };
}

/** Lets start() finish its async setup (capabilities, crypto, /auth/app/start) and open the browser. */
async function waitForOpen(openUrl: ReturnType<typeof vi.fn>): Promise<string> {
  await vi.waitFor(() => expect(openUrl).toHaveBeenCalled());
  return openUrl.mock.calls[0][0] as string;
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get("state")!;
}

describe("WebAuthService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("signs in once the poll is approved", async () => {
    const polls = [res(200, { status: "pending" }), res(200, { status: "pending" }), res(200, { status: "approved", session })];
    const t = setup({ poll: () => polls.shift()! });
    const done = t.service.start("signin", SERVER);

    const url = await waitForOpen(t.openUrl);
    expect(url).toMatch(/^https:\/\/www\.hubfolks\.com\/signin\?flow=f1&state=[A-Za-z0-9_-]+$/);
    const startCall = t.fetchMock.mock.calls.find(([u]) => u === `${SERVER}/auth/app/start`)!;
    expect(JSON.parse(String(startCall[1]!.body)).codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await vi.advanceTimersByTimeAsync(2500 * 3);
    await done;

    expect(t.storeSession).toHaveBeenCalledTimes(1);
    expect(t.storeSession).toHaveBeenCalledWith(session, SERVER);
    expect(t.saveSettings).toHaveBeenCalledTimes(1);
    expect(t.emit).toHaveBeenCalledTimes(1);
    expect(t.emit).toHaveBeenCalledWith("together:account-switched", { username: "dana", serverUrl: SERVER });
    expect(t.settings.accounts[1].encryptedPassword).toBeUndefined();
    expect(t.settings.activeAccountIndex).toBe(1);
  });

  it("opens the sign-up page in signup mode", async () => {
    const t = setup();
    const done = t.service.start("signup", SERVER);
    done.catch(() => {});
    expect(await waitForOpen(t.openUrl)).toMatch(/^https:\/\/www\.hubfolks\.com\/signup\?flow=f1&state=/);
    t.service.cancel();
    await expect(done).rejects.toThrow("Cancelled");
  });

  it("lets a matching callback win; a later approved poll does not store again", async () => {
    let approved = false;
    const t = setup({ poll: () => res(200, approved ? { status: "approved", session } : { status: "pending" }) });
    const done = t.service.start("signin", SERVER);
    const url = await waitForOpen(t.openUrl);

    await t.service.handleCallback({ code: "c1", state: stateOf(url) });
    await done;
    approved = true;
    await vi.advanceTimersByTimeAsync(2500 * 4);

    const tokenCall = t.fetchMock.mock.calls.find(([u]) => u === `${SERVER}/auth/app/token`)!;
    expect(JSON.parse(String(tokenCall[1]!.body))).toMatchObject({ code: "c1" });
    expect(JSON.parse(String(tokenCall[1]!.body)).verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.storeSession).toHaveBeenCalledTimes(1);
    expect(t.emit).toHaveBeenCalledTimes(1);
  });

  it("ignores a poll 400 while the callback exchange is in flight (the exchange consumed the flow)", async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => { releaseToken = r; });
    const t = setup({
      poll: () => res(400, { message: EXPIRED }),
      token: async () => { await tokenGate; return res(200, session); },
    });
    const done = t.service.start("signin", SERVER);
    const url = await waitForOpen(t.openUrl);

    const callback = t.service.handleCallback({ code: "c1", state: stateOf(url) });
    await vi.advanceTimersByTimeAsync(2500 * 2);
    releaseToken();
    await callback;
    await done;
    expect(t.storeSession).toHaveBeenCalledTimes(1);
  });

  it("falls back to polling when the token exchange fails, and fails if the link expired", async () => {
    const t = setup({ poll: () => res(400, { message: EXPIRED }), token: () => res(400, { message: EXPIRED }) });
    const done = t.service.start("signin", SERVER);
    const assertion = expect(done).rejects.toThrow(EXPIRED);
    const url = await waitForOpen(t.openUrl);

    await t.service.handleCallback({ code: "c1", state: stateOf(url) });
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(t.storeSession).not.toHaveBeenCalled();
  });

  it("ignores a callback whose state does not match", async () => {
    const t = setup();
    const done = t.service.start("signin", SERVER);
    done.catch(() => {});
    await waitForOpen(t.openUrl);

    await t.service.handleCallback({ code: "c1", state: "forged" });
    expect(t.fetchMock.mock.calls.some(([u]) => u === `${SERVER}/auth/app/token`)).toBe(false);
    expect(t.storeSession).not.toHaveBeenCalled();
    t.service.cancel();
    await expect(done).rejects.toThrow("Cancelled");
  });

  it("keeps polling through network errors and 429 without touching saved accounts", async () => {
    const polls: Array<() => Response> = [
      () => { throw new TypeError("Failed to fetch"); },
      () => { throw new TypeError("Failed to fetch"); },
      () => res(429),
      () => { throw new TypeError("Failed to fetch"); },
      () => res(200, { status: "approved", session }),
    ];
    const t = setup({ poll: () => polls.shift()!() });
    const before = JSON.stringify(t.settings);
    const done = t.service.start("signin", SERVER);
    await waitForOpen(t.openUrl);

    await vi.advanceTimersByTimeAsync(2500 * 4);
    expect(JSON.stringify(t.settings)).toBe(before);
    expect(t.saveSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2500);
    await done;
    expect(t.storeSession).toHaveBeenCalledTimes(1);
  });

  it("rejects when the poll answers 400 (link expired)", async () => {
    const t = setup({ poll: () => res(400, { message: EXPIRED }) });
    const done = t.service.start("signin", SERVER);
    const assertion = expect(done).rejects.toThrow(EXPIRED);
    await waitForOpen(t.openUrl);
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;
    expect(t.storeSession).not.toHaveBeenCalled();
  });

  it("stops at the flow expiry", async () => {
    const t = setup();
    const done = t.service.start("signin", SERVER);
    const assertion = expect(done).rejects.toThrow(EXPIRED);
    await waitForOpen(t.openUrl);
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 2500);
    await assertion;
  });

  it("cancels the pending sign-in when a second one starts", async () => {
    const t = setup();
    const first = t.service.start("signin", SERVER);
    const firstRejected = expect(first).rejects.toThrow("Cancelled");
    await waitForOpen(t.openUrl);

    const second = t.service.start("signin", SERVER);
    second.catch(() => {});
    await firstRejected;
    await vi.waitFor(() => expect(t.openUrl).toHaveBeenCalledTimes(2));
    t.service.cancel();
    await expect(second).rejects.toThrow("Cancelled");
  });

  it("refuses to start when the server does not offer the browser flow", async () => {
    const t = setup({ capabilities: () => res(404) });
    await expect(t.service.start("signin", SERVER)).rejects.toThrow();
    expect(t.openUrl).not.toHaveBeenCalled();
  });
});

describe("WebAuthService.getCapabilities", () => {
  it("returns 'unreachable' on a network error", async () => {
    const t = setup({ capabilities: () => { throw new TypeError("Failed to fetch"); } });
    expect(await t.service.getCapabilities(SERVER)).toBe("unreachable");
  });

  it("reports no web flow on old servers (404)", async () => {
    const t = setup({ capabilities: () => res(404) });
    expect(await t.service.getCapabilities(SERVER)).toEqual({ webFlow: false, webUrl: "" });
  });

  it("returns the server capabilities", async () => {
    const t = setup();
    expect(await t.service.getCapabilities(SERVER)).toEqual({ webFlow: true, webUrl: WEB });
  });
});

describe("WebAuthService default fetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("calls the global fetch unbound, as browsers require (no Illegal invocation)", async () => {
    // Chromium/Obsidian throw "Illegal invocation" when fetch runs with a foreign `this`.
    globalThis.fetch = function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(res(200, { webFlow: true, webUrl: WEB }));
    } as typeof fetch;
    const service = new WebAuthService({
      authManager: {} as AuthManager,
      getSettings: () => ({ accounts: [], activeAccountIndex: -1 }) as unknown as TogetherSettings,
      saveSettings: async () => {},
      emit: () => {},
      openUrl: () => {},
      vaultName: "v",
    });
    expect(await service.getCapabilities(SERVER)).toEqual({ webFlow: true, webUrl: WEB });
  });
});
