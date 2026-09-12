import { Plugin, Platform, Notice } from "obsidian";
import EventEmitter from "eventemitter3";
import type { TogetherAPI, TogetherSettings, SavedAccount, TraceLevel } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { Logger } from "./logger";
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
  logger!: Logger;

  /** Shared API surface exposed on app.together for all ecosystem plugins. */
  togetherAPI!: TogetherAPI;

  private eventBus = new EventEmitter();
  private registeredExtensions = new Map<string, unknown>();
  private traceConfig = new Map<string, TraceLevel>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.logger = new Logger("obsidian-together", () => this.getTraceLevel("obsidian-together"));

    this.authManager = new AuthManager(() => this.settings);

    this.pluginManager = new PluginManager({
      app: this.app,
      getSettings: () => this.settings,
      getAuth: () => this.authManager.getState(),
      onPluginLoaded: (id, instance) => this.registerExtension(id, instance),
      logger: this.logger,
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

      clearStoredPassword: (): void => {
        this.authManager.clearStoredPassword();
        void this.saveSettings();
      },

      createLogger: (pluginId: string) =>
        new Logger(pluginId, () => this.getTraceLevel(pluginId)),

      pluginManager: undefined as any, // overridden via defineProperty below
    };
    Object.defineProperty(this.togetherAPI, "auth", {
      get: () => this.authManager.getState(),
      enumerable: true,
    });
    Object.defineProperty(this.togetherAPI, "isDevMode", {
      get: () => this.settings.devMode,
      enumerable: true,
    });
    Object.defineProperty(this.togetherAPI, "pluginManager", {
      get: () => this.pluginManager,
      enumerable: true,
    });

    // Expose on app.together
    this.app.together = this.togetherAPI;

    // Block automatic file creation when clicking unresolved links.
    // Obsidian's default openLinkText creates an empty file when the target doesn't
    // exist; we intercept it and show a notice instead.
    const _origOpenLinkText = this.app.workspace.openLinkText.bind(this.app.workspace);
    this.app.workspace.openLinkText = (linktext, sourcePath, newLeaf?, openViewState?) => {
      const dest = this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath ?? "");
      if (!dest) {
        new Notice(`File not found: "${linktext}"`);
        return Promise.resolve();
      }
      return _origOpenLinkText(linktext, sourcePath, newLeaf, openViewState);
    };
    this.register(() => { this.app.workspace.openLinkText = _origOpenLinkText; });

    // Settings tab
    this.addSettingTab(new TogetherSettingTab(this.app, this));

    // Ribbon icon (placeholder)
    this.addRibbonIcon("users", "Obsidian Together", () => {
      // TODO: open Together panel
    });

    // Listen for login to trigger plugin loading and refresh trace config
    this.eventBus.on('together:account-switched', async ({ username }: { username: string | null }) => {
      if (this.app.workspace.layoutReady) this.loadTraceConfig();
      if (username) {
        try {
          await this.pluginManager.ensurePluginsLoaded();
          this.eventBus.emit('community:plugins-refreshed');
        } catch (e) { this.logger.error('PluginManager.ensurePluginsLoaded failed:', e); }
      }
    });

    // On startup, ensure plugins are loaded from disk even when not logged in
    // (community must always run so it can display the login screen).
    void this.pluginManager.ensurePluginsLoaded()
      .then(() => this.eventBus.emit('community:plugins-refreshed'))
      .catch((e) => this.logger.error('PluginManager startup load failed:', e));

    // Load trace config once vault is ready, then watch for user note changes
    this.app.workspace.onLayoutReady(() => {
      this.loadTraceConfig();
      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (fm?.type === "user") this.loadTraceConfig();
        })
      );
    });

    this.logger.info("loaded (v" + this.manifest.version + ")");
  }

  onunload(): void {
    this.pluginManager.unloadAll();
    if (this.app.together === this.togetherAPI) {
      delete this.app.together;
    }
    this.eventBus.removeAllListeners();
    this.logger.info("unloaded");
  }

  // ── Trace config ──────────────────────────────────────────────────────────────

  private loadTraceConfig(): void {
    const username = this.authManager.getState().username?.toLowerCase();
    this.traceConfig.clear();
    if (!username) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm?.type !== "user") continue;
      const id = (typeof fm.identifier === "string" ? fm.identifier : file.basename).toLowerCase();
      if (id !== username) continue;
      this.parseTraceConfig(fm.trace);
      return;
    }
  }

  private parseTraceConfig(trace: unknown): void {
    if (!Array.isArray(trace)) return;
    for (const entry of trace) {
      // YAML `- all: info` produces an object; `- "all: info"` produces a string
      if (entry !== null && typeof entry === "object") {
        for (const [pluginId, level] of Object.entries(entry as Record<string, unknown>)) {
          const lvl = String(level).trim() as TraceLevel;
          if (lvl === "error" || lvl === "info" || lvl === "verbose") {
            this.traceConfig.set(pluginId.trim(), lvl);
          }
        }
        continue;
      }
      const str = String(entry).trim();
      const colon = str.lastIndexOf(":");
      if (colon < 1) continue;
      const pluginId = str.slice(0, colon).trim();
      const level = str.slice(colon + 1).trim() as TraceLevel;
      if (level === "error" || level === "info" || level === "verbose") {
        this.traceConfig.set(pluginId, level);
      }
    }
  }

  private getTraceLevel(pluginId: string): TraceLevel {
    return this.traceConfig.get(pluginId) ?? this.traceConfig.get("all") ?? "error";
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

  /** Creates or removes the sub-plugins directory symlink based on devMode state. */
  manageDevSymlink(enable: boolean): { ok: boolean; message: string } {
    if (Platform.isMobile) return { ok: false, message: 'Not supported on mobile' };
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const adapter = this.app.vault.adapter as any;
      const base: string = adapter.basePath ?? adapter.getBasePath?.() ?? '';
      if (!base) return { ok: false, message: 'Could not determine vault path' };
      const targetPath = path.join(base, '.obsidian', 'plugins', 'obsidian-together', 'sub-plugins');

      if (enable) {
        const { devRepoRoot } = this.settings;
        if (!devRepoRoot) return { ok: false, message: 'Set repo root path first' };
        const appsPath = path.join(devRepoRoot, 'apps');
        if (!fs.existsSync(appsPath)) return { ok: false, message: `Not found: ${appsPath}` };
        const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false } as any);
        if (existing) {
          if (existing.isSymbolicLink() || existing.isFile()) {
            fs.unlinkSync(targetPath);
          } else {
            fs.rmSync(targetPath, { recursive: true, force: true });
          }
        }
        fs.symlinkSync(appsPath, targetPath, 'dir');
        return { ok: true, message: `Symlink created → ${appsPath}` };
      } else {
        const stat = fs.lstatSync(targetPath, { throwIfNoEntry: false } as any);
        if (stat?.isSymbolicLink()) fs.unlinkSync(targetPath);
        fs.mkdirSync(targetPath, { recursive: true });
        return { ok: true, message: 'Symlink removed' };
      }
    } catch (e) {
      return { ok: false, message: (e as Error).message ?? String(e) };
    }
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
