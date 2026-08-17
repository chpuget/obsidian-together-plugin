import { Plugin } from "obsidian";
import EventEmitter from "eventemitter3";
import type { TogetherAPI, TogetherSettings, SavedAccount } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { AuthManager } from "./auth/AuthManager";
import { PluginManager } from "./plugins/PluginManager";
import { TogetherSettingTab } from "./settings/SettingsTab";
import { applyCoreLegacyMigration } from "./settings-migration";

// Augment the Obsidian App type so TypeScript knows about app.together
declare module "obsidian" {
  interface App {
    together?: TogetherAPI;
  }
}

export default class ObsidianTogetherPlugin extends Plugin {
  settings!: TogetherSettings;
  authManager!: AuthManager;
  pluginManager!: PluginManager;

  /** Shared API surface exposed on app.together for all ecosystem plugins. */
  togetherAPI!: TogetherAPI;

  private eventBus = new EventEmitter();
  private registeredExtensions = new Map<string, unknown>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.authManager = new AuthManager(() => this.settings);

    this.pluginManager = new PluginManager({
      app: this.app,
      getSettings: () => this.settings,
      getAuth: () => this.authManager.getState(),
    });

    // Restore session from saved accounts
    const restored = await this.authManager.restoreSession();
    if (restored) {
      const state = this.authManager.getState();
      // Sync username into account record if needed
      const idx = this.settings.activeAccountIndex;
      if (idx >= 0 && state.username && this.settings.accounts[idx]) {
        this.settings.accounts[idx].userId = state.userId ?? this.settings.accounts[idx].userId;
      }
      await this.saveSettings();
    }

    // Build the shared API surface
    this.togetherAPI = {
      version: this.manifest.version,
      auth: undefined as any, // overridden below via Object.defineProperty
      events: this.eventBus,
      getPlugin: (id: string) => this.registeredExtensions.get(id),

      login: async (username: string, password: string, serverUrl: string): Promise<void> => {
        await this.authManager.login(username, password, serverUrl);
        await this.saveSettings();
        const s = this.authManager.getState();
        this.eventBus.emit("together:account-switched", { username: s.username, serverUrl: s.serverUrl });
      },

      logout: async (): Promise<void> => {
        const { serverUrl } = this.authManager.getState();
        this.authManager.logout();
        await this.saveSettings();
        this.eventBus.emit("together:account-switched", { username: null, serverUrl });
      },

      getSavedAccounts: (): SavedAccount[] => this.settings.accounts,

      switchToAccount: async (index: number): Promise<void> => {
        const ok = await this.authManager.switchAccount(index);
        await this.saveSettings();
        if (ok) {
          const s = this.authManager.getState();
          this.eventBus.emit("together:account-switched", { username: s.username, serverUrl: s.serverUrl });
        } else {
          this.eventBus.emit("together:relogin-required", { index });
        }
      },

      removeAccount: (index: number): void => {
        this.authManager.removeAccount(index);
        void this.saveSettings();
      },
      pluginManager: undefined as any, // overridden via defineProperty below
    };
    Object.defineProperty(this.togetherAPI, "auth", {
      get: () => this.authManager.getState(),
      enumerable: true,
    });
    Object.defineProperty(this.togetherAPI, "pluginManager", {
      get: () => this.pluginManager,
      enumerable: true,
    });

    // Expose on app.together
    this.app.together = this.togetherAPI;

    // Settings tab
    this.addSettingTab(new TogetherSettingTab(this.app, this));

    // Ribbon icon (placeholder)
    this.addRibbonIcon("users", "Obsidian Together", () => {
      // TODO: open Together panel
    });

    // Listen for login to trigger plugin loading
    this.eventBus.on('together:account-switched', async ({ username }: { username: string | null }) => {
      if (username) {
        try { await this.pluginManager.ensurePluginsLoaded(); } catch (e) { console.error('PluginManager.ensurePluginsLoaded failed:', e); }
      }
    });

    // On startup, ensure plugins are loaded from disk even when not logged in
    // (together-community must always run so it can display the login screen).
    void this.pluginManager.ensurePluginsLoaded().catch((e) => console.error('PluginManager startup load failed:', e));

    console.log("Obsidian Together: loaded (v" + this.manifest.version + ")");
  }

  onunload(): void {
    if (this.app.together === this.togetherAPI) {
      delete this.app.together;
    }
    this.eventBus.removeAllListeners();
    console.log("Obsidian Together: unloaded");
  }

  // ── Settings ──────────────────────────────────────────────────────────────────

  private get _lsKey(): string {
    return `obsidian-together:${this.app.vault.getName()}`;
  }

  async loadSettings(): Promise<void> {
    // 1. Try localStorage (post-migration or fresh install)
    const stored = localStorage.getItem(this._lsKey);
    if (stored) {
      try {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(stored)) as TogetherSettings;
        return;
      } catch {
        localStorage.removeItem(this._lsKey);
      }
    }

    // 2. Migrate from legacy data.json
    const legacy = (await this.loadData() ?? {}) as Record<string, unknown>;
    if (Object.keys(legacy).length > 0) {
      applyCoreLegacyMigration(legacy);
      this.settings = Object.assign({}, DEFAULT_SETTINGS, legacy) as TogetherSettings;
      localStorage.setItem(this._lsKey, JSON.stringify(this.settings));
      await this.saveData({}); // clear tokens/passwords from vault
      return;
    }

    this.settings = { ...DEFAULT_SETTINGS };
  }

  saveSettings(): void {
    localStorage.setItem(this._lsKey, JSON.stringify(this.settings));
  }

  // ── Extension registry ────────────────────────────────────────────────────────

  registerExtension(id: string, instance: unknown): void {
    this.registeredExtensions.set(id, instance);
    this.eventBus.emit("together:extension-registered", { id });
  }

  unregisterExtension(id: string): void {
    this.registeredExtensions.delete(id);
    this.eventBus.emit("together:extension-unregistered", { id });
  }
}
