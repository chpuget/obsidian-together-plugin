import { EventEmitter } from "eventemitter3";

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
}

/**
 * Shared API surface exposed on `app.together` by the Obsidian Together core plugin.
 * All ecosystem plugins access auth state and the event bus through this interface.
 */
export interface TogetherAPI {
  readonly version: string;
  readonly auth: AuthState;
  readonly events: EventEmitter;
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
  pluginManager?: PluginManagerAPI;
}

export interface AuthState {
  readonly token: string | null;
  readonly userId: string | null;
  readonly username: string | null;
  readonly serverUrl: string | null;
  readonly isLoggedIn: boolean;
  readonly isAdmin: boolean;
}

/** A saved account credential (persisted in data.json). */
export interface SavedAccount {
  username: string;
  serverUrl: string;
  userId: string;
  token: string;           // JWT — may be empty if logged out
  displayName?: string;
  encryptedPassword?: string; // base64-encoded Buffer from electron safeStorage
  isAdmin?: boolean;
}

export interface TogetherSettings {
  /** List of saved accounts (multi-server, multi-user). */
  accounts: SavedAccount[];
  /** Index into accounts[] of the currently active account. -1 = none. */
  activeAccountIndex: number;
  devMode: boolean;
  devRepoRoot: string;
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
};

