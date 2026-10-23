import { EventEmitter } from "eventemitter3";
import type { Logger, TraceLevel } from "./logger";
export type { Logger, TraceLevel };

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  buildDate?: string;
  checksum: string;
  size: number;
  previewChecksum: string | null;
  previewUrls: { md?: string; jpg?: string; coverJpg?: string };
  required?: boolean;
  roadmap?: boolean;
  requires?: string[];
}

export interface PluginManagerAPI {
  ensurePluginsLoaded(): Promise<void>;
  refreshAvailablePlugins(): Promise<void>;
  downloadPlugin(info: PluginInfo): Promise<void>;
  loadPlugin(id: string): Promise<void>;
  unloadPlugin(id: string): Promise<void>;
  reloadAll(): Promise<void>;
  getInstalledVersions(): { id: string; version: string; buildDate?: string }[];
  getAvailablePlugins(): PluginInfo[];
  getLoadedPluginIds(): string[];
  hasUpdate(id: string): boolean;
  syncEnabledPlugins(username: string): Promise<void>;
  autoUpdate(): Promise<{ abortSync: boolean }>;
  checkDependencies(id: string): PluginInfo[];
  /** Returns a platform-correct resource URL for an asset file bundled with a sub-plugin.
   *  Works in both dev mode (absolute repo path) and production (vault-relative path). */
  getSubPluginAssetResourceUrl(pluginId: string, assetRelPath: string): string;
}

/**
 * Shared API surface exposed on `app.together` by the HubFolks core plugin.
 * All ecosystem plugins access auth state and the event bus through this interface.
 */
export interface TogetherAPI {
  readonly version: string;
  readonly auth: AuthState;
  readonly events: EventEmitter;
  readonly isDevMode: boolean;
  /** Look up a loaded extension plugin by its manifest id. */
  getPlugin(id: string): unknown;
  /** Login with credentials. Stores encrypted password if safeStorage is available.
   *  Emits `together:account-switched` on success. Throws on auth failure. */
  login(username: string, password: string, serverUrl: string): Promise<void>;
  /** Logout the active account. Keeps encryptedPassword for future re-login.
   *  Emits `together:account-switched`. */
  logout(): Promise<void>;
  /** Return the full list of saved accounts (including the active one). */
  getSavedAccounts(): SavedAccount[];
  /** Switch to a saved account by index. Tries stored JWT first; if expired and
   *  encryptedPassword is available, re-logs in silently. On failure emits
   *  `together:relogin-required` with `{ index }`. */
  switchToAccount(index: number): Promise<void>;
  /** Remove a saved account from the list. Adjusts activeAccountIndex. */
  removeAccount(index: number): void;
  /** Clear the stored encrypted password for the active account.
   *  Call after a successful password change. */
  clearStoredPassword(): void;
  /** Silently renew the JWT with the stored refresh token. Call on an HTTP 401 before
   *  prompting for re-login: resolves true when `auth.token` now holds a fresh token.
   *  Optional so older versions of plugin-core don't break sub-plugins. */
  refreshAuth?(): Promise<boolean>;
  /** Create a logger bound to a plugin ID, respecting the current user's trace config.
   *  Optional so older versions of plugin-core don't break sub-plugins. */
  createLogger?(pluginId: string): Logger;
  pluginManager?: PluginManagerAPI;
  /** Sign in (or sign up) in the browser; the session comes back via the
   *  `obsidian://hubfolks-auth` callback or by polling. Resolves once signed in and
   *  `together:account-switched` was emitted; rejects on cancel or expiry. */
  startWebSignIn(mode: 'signin' | 'signup'): Promise<void>;
  /** Whether the server offers the browser sign-in; `'unreachable'` when offline. */
  getAuthCapabilities(): Promise<AuthCapabilities | 'unreachable'>;
  /** Abandons a pending `startWebSignIn`, which then rejects with "Cancelled".
   *  Optional so older versions of plugin-core don't break sub-plugins. */
  cancelWebSignIn?(): void;
}

/** Session returned by `/auth/login`, `/auth/app/token` and an approved `/auth/app/poll`. */
export interface LoginResponse {
  token: string;
  refreshToken?: string;
  user: { id: string; username: string; displayName?: string; isAdmin?: boolean };
  availablePlugins?: unknown[];
  branch?: string;
}

/** `GET /auth/capabilities`. Old servers (404) are reported as `{ webFlow: false, webUrl: "" }`. */
export interface AuthCapabilities {
  webFlow: boolean;
  webUrl: string;
}

export interface AuthState {
  readonly token: string | null;
  readonly userId: string | null;
  readonly username: string | null;
  readonly serverUrl: string | null;
  readonly isLoggedIn: boolean;
  readonly isAdmin: boolean;
  readonly branch: string | null;   // "dev" | "prod" | null (null = prod default)
  /** True when not logged in only because the server could not be reached (no network,
   *  server down): credentials are kept and the session reconnects automatically.
   *  UIs should show an offline indicator rather than a login prompt. */
  readonly offline?: boolean;
}

/** A saved account credential (persisted in data.json). */
export interface SavedAccount {
  username: string;
  serverUrl: string;
  userId: string;
  token: string;           // JWT — may be empty if logged out
  displayName?: string;
  encryptedPassword?: string; // base64-encoded Buffer from electron safeStorage
  refreshToken?: string;  // long-lived token for silent JWT renewal
  isAdmin?: boolean;
  branch?: string;   // "dev" | "prod" — absent means prod
}

export interface TogetherSettings {
  /** List of saved accounts (multi-server, multi-user). */
  accounts: SavedAccount[];
  /** Index into accounts[] of the currently active account. -1 = none. */
  activeAccountIndex: number;
  devMode: boolean;
  devRepoRoot: string;
  autoUpdate: boolean;
  // ── Legacy fields kept for migration ──────────────────────────────────────
  serverUrl?: string;
  authToken?: string;
  username?: string;
  localServer?: boolean;
  knownUsernames?: string[];
}

export const DEFAULT_SETTINGS: TogetherSettings = {
  accounts: [],
  activeAccountIndex: -1,
  devMode: false,
  devRepoRoot: '',
  autoUpdate: true,
};

