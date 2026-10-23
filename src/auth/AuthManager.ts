import { Platform } from "obsidian";
import type { AuthState, LoginResponse, SavedAccount, TogetherSettings } from "../types";

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

function getSafeStorage(): SafeStorage | undefined {
  // safeStorage is only available in Electron desktop — skip on mobile and mobile emulation.
  if (Platform.isMobile || typeof process === 'undefined' || !process.versions?.electron) return undefined;
  try {
    return (require('electron') as { safeStorage: SafeStorage }).safeStorage;
  } catch {
    return undefined;
  }
}

/** Reads the `exp` claim (seconds since epoch) of a JWT without verifying it. */
function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export class AuthManager {
  private state: AuthState = {
    token: null,
    userId: null,
    username: null,
    serverUrl: null,
    isLoggedIn: false,
    isAdmin: false,
    branch: null,
  };

  constructor(private getSettings: () => TogetherSettings) {}

  getState(): AuthState {
    return { ...this.state };
  }

  // ── Login / logout ──────────────────────────────────────────────────────────

  /** Login with username+password against the current server URL.
   *  Upserts the account in settings.accounts and sets it active.
   *  Caller must saveSettings() and emit "together:account-switched". */
  async login(username: string, password: string, serverUrl: string): Promise<SavedAccount> {
    const response = await fetch(`${serverUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (response.status !== 201) {
      if (response.status === 401) {
        throw new Error("Invalid username or password");
      }
      const json = await response.json().catch(() => ({}));
      const msg = (json as any)?.message ?? (json as any)?.error ?? "Login failed";
      throw new Error(Array.isArray(msg) ? msg.join(", ") : String(msg));
    }

    const data = await response.json() as LoginResponse;
    return this.storeSession(data, serverUrl, password);
  }

  /** Saves a session returned by the server (password login or browser sign-in):
   *  upserts the account in settings.accounts, sets it active and marks the state logged in.
   *  The password is encrypted and kept only when given (browser sign-in has none).
   *  Caller must saveSettings() and emit "together:account-switched". */
  storeSession(data: LoginResponse, serverUrl: string, password?: string): SavedAccount {
    const { token, user } = data;

    const settings = this.getSettings();
    const idx = settings.accounts.findIndex(a => a.username === user.username && a.serverUrl === serverUrl);
    const account: SavedAccount = {
      username: user.username,
      serverUrl,
      userId: user.id,
      token,
      refreshToken: data.refreshToken,
      displayName: user.displayName,
      isAdmin: user.isAdmin ?? false,
      branch: data.branch,
    };

    if (password !== undefined) {
      const storage = getSafeStorage();
      if (storage?.isEncryptionAvailable()) {
        account.encryptedPassword = storage.encryptString(password).toString('base64');
      }
    }

    if (idx >= 0) {
      settings.accounts[idx] = account;
      settings.activeAccountIndex = idx;
    } else {
      settings.accounts.push(account);
      settings.activeAccountIndex = settings.accounts.length - 1;
    }

    this.state = { token, userId: user.id, username: user.username, serverUrl, isLoggedIn: true, isAdmin: user.isAdmin ?? false, branch: data.branch ?? null };
    return account;
  }

  private async refreshAccessToken(account: SavedAccount): Promise<{ token: string; refreshToken: string } | 'expired' | null> {
    if (!account.refreshToken || !account.serverUrl) return null;
    try {
      const response = await fetch(`${account.serverUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: account.refreshToken }),
      });
      if (response.status === 200 || response.status === 201) {
        return await response.json() as { token: string; refreshToken: string };
      }
      if (response.status === 401 || response.status === 403) return 'expired';
    } catch {
      // network error — treat as failure
    }
    return null;
  }

  private refreshInFlight: Promise<boolean> | null = null;

  /** Renew the active account's JWT using its refresh token, without touching the rest of the session.
   *  Concurrent calls share one request (the refresh token is single-use — a second call would be rejected).
   *  Returns false on network failure (refresh token kept for a later retry) or definitive rejection
   *  (refresh token cleared). Caller must saveSettings(). */
  refreshSession(): Promise<boolean> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefreshSession().finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  private async doRefreshSession(): Promise<boolean> {
    const settings = this.getSettings();
    const account = settings.accounts[settings.activeAccountIndex];
    if (!account?.refreshToken) return false;

    const refreshed = await this.refreshAccessToken(account);
    if (refreshed === 'expired') {
      account.refreshToken = undefined;
      return false;
    }
    if (!refreshed) return false;

    account.token = refreshed.token;
    account.refreshToken = refreshed.refreshToken;
    if (this.state.isLoggedIn && this.state.serverUrl === account.serverUrl) {
      this.state = { ...this.state, token: refreshed.token };
      return true;
    }
    // Session was not established (e.g. offline at startup) — populate state from /auth/me
    return this.validateToken(refreshed.token, account.serverUrl);
  }

  /** True when the in-memory JWT expires within `ms` milliseconds. False if no token or no readable exp. */
  tokenExpiresWithin(ms: number): boolean {
    const exp = this.state.token ? decodeJwtExp(this.state.token) : null;
    return exp !== null && exp * 1000 - Date.now() < ms;
  }

  /** Switch to an already-saved account by index.
   *  Validates the stored token; if expired, tries refresh token then encrypted password.
   *  Caller must saveSettings() and emit "together:account-switched". */
  async switchAccount(index: number): Promise<boolean> {
    const settings = this.getSettings();
    const account = settings.accounts[index];
    if (!account) return false;

    // Set when a credential could not be checked because the server was unreachable:
    // the session is then "offline" (auto-reconnect) rather than requiring a new login.
    let unreachable = false;

    if (account.token) {
      const result = await this.checkToken(account.token, account.serverUrl);
      if (result === 'ok') {
        // checkToken already populated this.state.branch from /auth/me
        settings.activeAccountIndex = index;
        return true;
      }
      if (result === 'unreachable') unreachable = true;
    }

    // Token missing or expired — try refresh token first (works on all platforms)
    if (account.refreshToken) {
      const refreshed = await this.refreshAccessToken(account);
      if (refreshed === 'expired') {
        account.refreshToken = undefined; // server definitively rejected — clear to avoid repeated doomed calls
        unreachable = false; // server answered: the token check failure was not a connectivity issue
      } else if (!refreshed) {
        unreachable = true;
      } else {
        account.token = refreshed.token;
        account.refreshToken = refreshed.refreshToken;
        // checkToken also populates this.state from /auth/me
        const result = await this.checkToken(refreshed.token, account.serverUrl);
        if (result === 'ok') {
          settings.activeAccountIndex = index;
          return true;
        }
        if (result === 'unreachable') unreachable = true;
      }
    }

    // Fallback: try silent re-login with stored encrypted password (desktop only)
    const storage = getSafeStorage();
    if (account.encryptedPassword && storage?.isEncryptionAvailable()) {
      try {
        const pass = storage.decryptString(Buffer.from(account.encryptedPassword, 'base64'));
        await this.login(account.username, pass, account.serverUrl);
        return true;
      } catch {
        // Decryption or re-login failed — fall through to inactive state
      }
    }

    // Cannot authenticate — mark account selected but not logged in
    settings.activeAccountIndex = index;
    this.state = {
      token: null,
      userId: account.userId,
      username: account.username,
      serverUrl: account.serverUrl,
      isLoggedIn: false,
      isAdmin: account.isAdmin ?? false,
      branch: null,
      offline: unreachable,
    };
    return false;
  }

  /** Re-login for an existing account (token expired). Updates the stored token. */
  async relogin(index: number, password: string): Promise<void> {
    const settings = this.getSettings();
    const account = settings.accounts[index];
    if (!account) throw new Error("Account not found");
    await this.login(account.username, password, account.serverUrl);
    // login() already updated settings.accounts[index]
  }

  /** Logout: clears the token for the active account but keeps it in the list. */
  logout(): void {
    const settings = this.getSettings();
    const idx = settings.activeAccountIndex;
    if (idx >= 0 && settings.accounts[idx]) {
      const account = settings.accounts[idx];
      // Fire-and-forget revocation — don't block logout on network
      if (account.refreshToken && account.serverUrl) {
        fetch(`${account.serverUrl}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: account.refreshToken }),
        }).catch(() => {});
      }
      account.token = '';
      account.refreshToken = undefined;
    }
    settings.activeAccountIndex = -1;
    this.state = { token: null, userId: null, username: null, serverUrl: null, isLoggedIn: false, isAdmin: false, branch: null };
  }

  /** Clears the stored encrypted password for the active account.
   *  Call after a successful password change to prevent stale silent re-login. */
  clearStoredPassword(): void {
    const settings = this.getSettings();
    const idx = settings.activeAccountIndex;
    if (idx >= 0 && settings.accounts[idx]) {
      delete settings.accounts[idx].encryptedPassword;
    }
  }

  /** Remove a saved account entirely. */
  removeAccount(index: number): void {
    const settings = this.getSettings();
    settings.accounts.splice(index, 1);
    if (settings.activeAccountIndex === index) {
      settings.activeAccountIndex = -1;
      this.state = { token: null, userId: null, username: null, serverUrl: null, isLoggedIn: false, isAdmin: false, branch: null };
    } else if (settings.activeAccountIndex > index) {
      settings.activeAccountIndex--;
    }
  }

  // ── Token validation ────────────────────────────────────────────────────────

  /** Validate a token against a server URL and populate state if valid. */
  async validateToken(token: string, serverUrl: string): Promise<boolean> {
    return (await this.checkToken(token, serverUrl)) === 'ok';
  }

  /** Like validateToken, but tells a rejected token (401/403) apart from an unreachable server. */
  private async checkToken(token: string, serverUrl: string): Promise<'ok' | 'invalid' | 'unreachable'> {
    if (!token || !serverUrl) return 'invalid';
    try {
      const response = await fetch(`${serverUrl}/auth/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 200) {
        const user = await response.json() as { id: string; username: string; displayName?: string; isAdmin?: boolean; branch?: string };
        const branch = user.branch === 'dev' ? 'dev' : (user.branch ?? null);
        this.state = { token, userId: user.id, username: user.username, serverUrl, isLoggedIn: true, isAdmin: user.isAdmin ?? false, branch };
        return 'ok';
      }
      if (response.status === 401 || response.status === 403) return 'invalid';
    } catch {
      // network error
    }
    return 'unreachable';
  }

  /** Restore session from the active saved account on startup. */
  async restoreSession(): Promise<boolean> {
    const settings = this.getSettings();
    const idx = settings.activeAccountIndex;
    if (idx < 0 || !settings.accounts[idx]) return false;
    return this.switchAccount(idx);
  }
}
