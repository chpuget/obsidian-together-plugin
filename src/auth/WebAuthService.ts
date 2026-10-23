import type { AuthManager } from "./AuthManager";
import type { AuthCapabilities, LoginResponse, TogetherSettings } from "../types";
import { base64url, deriveCodeChallenge, encodeState, randomVerifier } from "./pkce";

// Browser sign-in (works on desktop and mobile):
//   plugin -> POST {server}/auth/app/start -> opens {webUrl}/signin?flow=…&state=…
//   the user signs in on the web page, then either
//   - the page deep-links obsidian://hubfolks-auth?code=…&state=… -> handleCallback() -> POST /auth/app/token, or
//   - POST /auth/app/poll (every 2.5 s) returns the session once the flow is approved.
// Whichever path gets the session first stores it; the other stops silently.
export const AUTH_PROTOCOL_ACTION = "hubfolks-auth";

export const SIGN_IN_EXPIRED = "Sign-in link expired, please start again";
const POLL_INTERVAL_MS = 2500;
const FLOW_TTL_MS = 15 * 60 * 1000;

export interface WebAuthDeps {
  authManager: AuthManager;
  getSettings(): TogetherSettings;
  saveSettings(): Promise<void>;
  emit(event: string, payload: unknown): void;
  openUrl(url: string): void;
  vaultName: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface PendingFlow {
  serverUrl: string;
  flowId: string;
  verifier: string;
  state: string;
  expiresAt: number;
  /** True while the callback's /auth/app/token request is in flight: the server consumes the
   *  flow on exchange, so a concurrent poll answering 400 must not fail the sign-in. */
  exchanging: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve(): void;
  reject(e: Error): void;
}

function isOk(res: Response): boolean {
  return res.status >= 200 && res.status < 300;
}

export class WebAuthService {
  private pending: PendingFlow | null = null;
  /** Bumped by cancel(): a start() still in its async setup checks it before opening the browser. */
  private generation = 0;

  constructor(private deps: WebAuthDeps) {}

  /** Never hand back the bare global: `this.fetch(url)` would call it with this service as
   *  `this`, which browsers (Obsidian included) reject with "Illegal invocation". */
  private get fetch(): typeof fetch {
    return this.deps.fetch ?? ((input, init) => fetch(input, init));
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private post(url: string, body: unknown): Promise<Response> {
    return this.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** `'unreachable'` on a network error or a server error; old servers (404) have no web flow. */
  async getCapabilities(serverUrl: string): Promise<AuthCapabilities | "unreachable"> {
    try {
      const res = await this.fetch(`${serverUrl}/auth/capabilities`);
      if (res.status === 404) return { webFlow: false, webUrl: "" };
      if (!isOk(res)) return "unreachable";
      const data = await res.json() as Partial<AuthCapabilities>;
      return { webFlow: data.webFlow === true, webUrl: typeof data.webUrl === "string" ? data.webUrl : "" };
    } catch {
      return "unreachable";
    }
  }

  /** Opens the browser sign-in and resolves once signed in. A second call cancels the first. */
  async start(mode: "signin" | "signup", serverUrl: string): Promise<void> {
    this.cancel();
    const generation = this.generation;

    const caps = await this.getCapabilities(serverUrl);
    if (caps === "unreachable") throw new Error("Cannot reach the HubFolks server. Check your connection and try again.");
    if (!caps.webFlow || !caps.webUrl) throw new Error("Browser sign-in is not available on this server.");

    const verifier = randomVerifier();
    const codeChallenge = await deriveCodeChallenge(verifier);
    const res = await this.post(`${serverUrl}/auth/app/start`, { codeChallenge });
    if (!isOk(res)) throw new Error("Could not start the sign-in, please try again.");
    const { flowId, expiresAt } = await res.json() as { flowId: string; expiresAt: string };
    if (generation !== this.generation) throw new Error("Cancelled");

    const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const state = encodeState(nonce, this.deps.vaultName);
    const serverExpiry = Date.parse(expiresAt);
    const maxExpiry = this.now() + FLOW_TTL_MS;

    const done = new Promise<void>((resolve, reject) => {
      this.pending = {
        serverUrl,
        flowId,
        verifier,
        state,
        expiresAt: Number.isFinite(serverExpiry) ? Math.min(serverExpiry, maxExpiry) : maxExpiry,
        exchanging: false,
        timer: null,
        resolve,
        reject,
      };
    });
    const flow = this.pending!;

    const webUrl = caps.webUrl.replace(/\/+$/, "");
    this.deps.openUrl(`${webUrl}/${mode}?flow=${encodeURIComponent(flowId)}&state=${encodeURIComponent(state)}`);
    this.schedulePoll(flow);
    return done;
  }

  /** Registered as the `obsidian://hubfolks-auth` protocol handler. Ignores unknown or stale states. */
  async handleCallback(params: { code?: string; state?: string; error?: string }): Promise<void> {
    const flow = this.pending;
    if (!flow || !params.state || params.state !== flow.state) return;
    if (params.error) {
      this.fail(flow, new Error("Sign-in was cancelled in the browser."));
      return;
    }
    if (!params.code) return;

    flow.exchanging = true;
    try {
      const res = await this.post(`${flow.serverUrl}/auth/app/token`, { code: params.code, verifier: flow.verifier });
      const session = isOk(res) ? await res.json() as LoginResponse : null;
      if (this.pending !== flow) return;
      if (session) {
        await this.complete(flow, session);
        return;
      }
    } catch {
      // network error — polling keeps going and can still pick the session up
    }
    // On any failure (a 400 included), hand over to polling: if a concurrent poll consumed the flow
    // its answer carries the session; if the link really expired, the next poll fails with SIGN_IN_EXPIRED.
    flow.exchanging = false;
  }

  /** Abandons the pending sign-in, if any; its start() promise rejects with "Cancelled". */
  cancel(): void {
    this.generation++;
    const flow = this.pending;
    if (flow) this.fail(flow, new Error("Cancelled"));
  }

  private schedulePoll(flow: PendingFlow): void {
    flow.timer = setTimeout(() => void this.poll(flow), POLL_INTERVAL_MS);
  }

  private async poll(flow: PendingFlow): Promise<void> {
    flow.timer = null;
    if (this.pending !== flow) return;
    if (this.now() >= flow.expiresAt) {
      this.fail(flow, new Error(SIGN_IN_EXPIRED));
      return;
    }

    let res: Response;
    try {
      res = await this.post(`${flow.serverUrl}/auth/app/poll`, { flowId: flow.flowId, verifier: flow.verifier });
    } catch {
      // Offline or server down: keep polling, never touch saved accounts
      if (this.pending === flow) this.schedulePoll(flow);
      return;
    }
    if (this.pending !== flow) return;

    if (res.status === 400 && !flow.exchanging) {
      this.fail(flow, new Error(SIGN_IN_EXPIRED));
      return;
    }
    if (isOk(res)) {
      const data = await res.json().catch(() => null) as { status?: string; session?: LoginResponse } | null;
      if (this.pending !== flow) return;
      if (data?.status === "approved" && data.session) {
        await this.complete(flow, data.session);
        return;
      }
    }
    // pending, 429 (polled too fast), 5xx, or a 400 while the callback exchange runs: try again
    this.schedulePoll(flow);
  }

  /** First path to get a session wins; it is the only place saved accounts are written. */
  private async complete(flow: PendingFlow, session: LoginResponse): Promise<void> {
    this.clear(flow);
    try {
      this.deps.authManager.storeSession(session, flow.serverUrl);
      await this.deps.saveSettings();
      const s = this.deps.authManager.getState();
      this.deps.emit("together:account-switched", { username: s.username, serverUrl: s.serverUrl });
    } catch (e) {
      flow.reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    flow.resolve();
  }

  private fail(flow: PendingFlow, error: Error): void {
    if (this.pending !== flow) return;
    this.clear(flow);
    flow.reject(error);
  }

  private clear(flow: PendingFlow): void {
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = null;
    if (this.pending === flow) this.pending = null;
  }
}
