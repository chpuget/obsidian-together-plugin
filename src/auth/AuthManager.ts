import type { AuthState, SavedAccount, TogetherSettings } from "../types";

type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
};

function getSafeStorage(): SafeStorage | undefined {
  try {
    return (require('electron') as { safeStorage: SafeStorage }).safeStorage;
  } catch {
    return undefined;
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

    const { token, user } = await response.json() as { token: string; user: { id: string; username: string; displayName?: string; isAdmin?: boolean } };

    const settings = this.getSettings();
    const idx = settings.accounts.findIndex(a => a.username === user.username && a.serverUrl === serverUrl);
    const account: SavedAccount = {
      username: user.username,
      serverUrl,
      userId: user.id,
      token,
      displayName: user.displayName,
      isAdmin: user.isAdmin ?? false,
    };

    const storage = getSafeStorage();
    if (storage?.isEncryptionAvailable()) {
      account.encryptedPassword = storage.encryptString(password).toString('base64');
    }

    if (idx >= 0) {
      settings.accounts[idx] = account;
      settings.activeAccountIndex = idx;
    } else {
      settings.accounts.push(account);
      settings.activeAccountIndex = settings.accounts.length - 1;
    }

    this.state = { token, userId: user.id, username: user.username, serverUrl, isLoggedIn: true, isAdmin: user.isAdmin ?? false };
    return account;
  }

  /** Switch to an already-saved account by index.
   *  Validates the stored token; if expired, tries silent re-login with stored encrypted password.
   *  Caller must saveSettings() and emit "together:account-switched". */
  async switchAccount(index: number): Promise<boolean> {
    const settings = this.getSettings();
    const account = settings.accounts[index];
    if (!account) return false;

    if (account.token) {
      const ok = await this.validateToken(account.token, account.serverUrl);
      if (ok) {
        settings.activeAccountIndex = index;
        return true;
      }
    }

    // Token missing or expired — try silent re-login with stored encrypted password
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
      settings.accounts[idx].token = "";
    }
    settings.activeAccountIndex = -1;
    this.state = { token: null, userId: null, username: null, serverUrl: null, isLoggedIn: false, isAdmin: false };
  }

  /** Remove a saved account entirely. */
  removeAccount(index: number): void {
    const settings = this.getSettings();
    settings.accounts.splice(index, 1);
    if (settings.activeAccountIndex === index) {
      settings.activeAccountIndex = -1;
      this.state = { token: null, userId: null, username: null, serverUrl: null, isLoggedIn: false, isAdmin: false };
    } else if (settings.activeAccountIndex > index) {
      settings.activeAccountIndex--;
    }
  }

  // ── Token validation ────────────────────────────────────────────────────────

  /** Validate a token against a server URL and populate state if valid. */
  async validateToken(token: string, serverUrl: string): Promise<boolean> {
    if (!token || !serverUrl) return false;
    try {
      const response = await fetch(`${serverUrl}/auth/me`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 200) {
        const user = await response.json() as { id: string; username: string; displayName?: string; isAdmin?: boolean };
        this.state = { token, userId: user.id, username: user.username, serverUrl, isLoggedIn: true, isAdmin: user.isAdmin ?? false };
        return true;
      }
    } catch {
      // network error — treat as invalid
    }
    return false;
  }

  /** Restore session from the active saved account on startup. */
  async restoreSession(): Promise<boolean> {
    const settings = this.getSettings();
    const idx = settings.activeAccountIndex;
    if (idx < 0 || !settings.accounts[idx]) return false;
    return this.switchAccount(idx);
  }
}
