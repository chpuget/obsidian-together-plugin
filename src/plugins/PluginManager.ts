import type { App } from 'obsidian';
import { normalizePath, Notice } from 'obsidian';
import { unzipSync, strFromU8 } from 'fflate';
import type { TogetherSettings, AuthState, PluginInfo } from '../types';
import { PreviewCache } from './PreviewCache';

export interface PluginManagerOptions {
  app: App;
  getSettings: () => TogetherSettings;
  getAuth: () => AuthState;
}

export function parseVersion(v: string): { major: number; minor: number; build: number } | null {
  const parts = v.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return { major: parts[0], minor: parts[1], build: parts[2] };
}

export class PluginManager {
  private _availablePlugins: PluginInfo[] = [];
  private _installedVersions: Record<string, string> = {};
  private _installedBuildDates: Record<string, string> = {};
  private _loadedPlugins = new Map<string, any>();
  private _loadingPromise: Promise<void> | null = null;
  private _previewCache: PreviewCache | null = null;
  isOnline = false;

  constructor(private readonly opts: PluginManagerOptions) {}

  // ── Public API ────────────────────────────────────────────────────────────────

  getAvailablePlugins(): PluginInfo[] { return this._availablePlugins; }

  getLoadedPluginIds(): string[] { return [...this._loadedPlugins.keys()]; }

  getInstalledVersions(): { id: string; version: string; buildDate?: string }[] {
    return Object.entries(this._installedVersions).map(([id, version]) => ({
      id,
      version,
      buildDate: this._installedBuildDates[id],
    }));
  }

  hasUpdate(id: string): boolean {
    const avail = this._availablePlugins.find((p) => p.id === id);
    if (!avail) return false;
    if (avail.roadmap) return false;
    const installed = this._installedVersions[id];
    if (!installed) return true;
    const ip = parseVersion(installed);
    const ap = parseVersion(avail.version);
    if (!ip || !ap) return installed !== avail.version;
    if (ap.major !== ip.major) return ap.major > ip.major;
    if (ap.minor !== ip.minor) return ap.minor > ip.minor;
    return ap.build > ip.build;
  }

  getPreviewCache(): PreviewCache {
    if (!this._previewCache) {
      const adapter = (this.opts.app.vault.adapter as any);
      const base: string = adapter.basePath ?? adapter.getBasePath?.() ?? '';
      const vaultBase = '.obsidian/plugins/obsidian-together/previews';
      this._previewCache = new PreviewCache(
        base ? `${base}/${vaultBase}` : null,
        undefined,
        adapter,
        vaultBase,
      );
    }
    return this._previewCache;
  }

  /** Update the available-plugins list and refresh any stale preview cache entries using
   *  the supplied data — no extra server call needed, presigned URLs are already in the list.
   *  Call this when the caller already has a freshly-fetched plugin list (e.g. from HubClient). */
  async updateFromPluginList(plugins: PluginInfo[]): Promise<void> {
    this._availablePlugins = plugins;
    this.isOnline = true;
    const cache = this.getPreviewCache();
    const stale = plugins.filter(info => !cache.isCurrent(info.id, info.version, info.previewChecksum));
    console.log(`[PluginManager] updateFromPluginList: ${plugins.length} plugins, ${stale.length} stale`);
    const refreshes = stale
      .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
        .catch((e) => console.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
    if (refreshes.length > 0) await Promise.allSettled(refreshes);
    console.log(`[PluginManager] updateFromPluginList: done`);
  }

  /** Lightweight refresh: re-fetches the available-plugins list from the server and
   *  updates _availablePlugins so hasUpdate() reflects the latest versions.
   *  Called after each periodic sync so the UI shows available updates without restart. */
  async refreshAvailablePlugins(): Promise<void> {
    const auth = this.opts.getAuth();
    if (!auth.isLoggedIn || !auth.serverUrl || !auth.token) return;
    try {
      const r = await fetch(`${auth.serverUrl}/plugins`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (r.ok) {
        this._availablePlugins = await r.json() as PluginInfo[];
        this.isOnline = true;
        const cache = this.getPreviewCache();
        const refreshes = this._availablePlugins
          .filter(info => !cache.isCurrent(info.id, info.version, info.previewChecksum))
          .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
            .catch((e) => console.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
        if (refreshes.length > 0) await Promise.allSettled(refreshes);
      }
    } catch {
      this.isOnline = false;
    }
  }

  async ensurePluginsLoaded(): Promise<void> {
    if (this._loadingPromise) return this._loadingPromise;
    this._loadingPromise = this._ensurePluginsLoadedImpl();
    try {
      await this._loadingPromise;
    } finally {
      this._loadingPromise = null;
    }
  }

  private async _ensurePluginsLoadedImpl(): Promise<void> {
    const { getAuth } = this.opts;
    const auth = getAuth();
    console.log(`[PluginManager] ensurePluginsLoaded start — isLoggedIn: ${auth.isLoggedIn}, serverUrl: ${auth.serverUrl ?? 'none'}`);

    // Only hit the server when fully authenticated
    if (auth.isLoggedIn && auth.serverUrl && auth.token) {
      try {
        console.log(`[PluginManager] ensurePluginsLoaded fetching plugin list from server…`);
        const r = await fetch(`${auth.serverUrl}/plugins`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (r.ok) {
          this._availablePlugins = await r.json() as PluginInfo[];
          this.isOnline = true;
          console.log(`[PluginManager] ensurePluginsLoaded fetched ${this._availablePlugins.length} plugins, isOnline: true`);
          const cache = this.getPreviewCache();
          const refreshes = this._availablePlugins
            .filter(info => !cache.isCurrent(info.id, info.version, info.previewChecksum))
            .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
              .catch((e) => console.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
          if (refreshes.length > 0) await Promise.allSettled(refreshes);
        } else {
          this.isOnline = false;
          console.log(`[PluginManager] ensurePluginsLoaded server responded ${r.status}, isOnline: false`);
        }
      } catch (e) {
        this.isOnline = false;
        console.log(`[PluginManager] ensurePluginsLoaded server unreachable, isOnline: false`, e);
      }
    } else {
      console.log(`[PluginManager] ensurePluginsLoaded skipping server fetch (not authenticated)`);
    }

    // Load installed versions from disk
    await this._loadInstalledVersions();
    console.log(`[PluginManager] ensurePluginsLoaded installed versions: ${JSON.stringify(this._installedVersions)}`);

    // together-community is always required
    const tcInfo = this._availablePlugins.find((p) => p.id === 'together-community');
    if (tcInfo) {
      const installed = this._installedVersions['together-community'];
      if (!installed || installed !== tcInfo.version) {
        console.log(`[PluginManager] ensurePluginsLoaded downloading together-community (installed: ${installed ?? 'none'}, available: ${tcInfo.version})`);
        try {
          await this.downloadPlugin(tcInfo);
        } catch (e) {
          console.error('[PluginManager] ensurePluginsLoaded failed to download together-community:', e);
          new Notice(`Failed to download together-community: ${(e as Error).message ?? e}`);
        }
      }
    }
    if (!this._loadedPlugins.has('together-community')) {
      const bundlePath = this._resolvedBundlePath('together-community');
      if (await this._bundleExists(bundlePath)) {
        console.log(`[PluginManager] ensurePluginsLoaded loading together-community`);
        await this.loadPlugin('together-community');
        console.log(`[PluginManager] ensurePluginsLoaded together-community loaded`);
      } else {
        console.log(`[PluginManager] ensurePluginsLoaded together-community bundle not found on disk`);
      }
    } else {
      console.log(`[PluginManager] ensurePluginsLoaded together-community already loaded`);
    }

    // Load optional plugins the user previously enabled
    const authState = this.opts.getAuth();
    if (authState.username) {
      const enabledIds = await this._readEnabledPluginsFromVault(authState.username);
      console.log(`[PluginManager] ensurePluginsLoaded optional plugins for ${authState.username}: [${enabledIds.join(', ')}]`);
      for (const id of enabledIds) {
        if (id === 'together-community') continue;
        if (this._loadedPlugins.has(id)) continue;
        const bundlePath = this._resolvedBundlePath(id);
        if (await this._bundleExists(bundlePath)) {
          console.log(`[PluginManager] ensurePluginsLoaded loading optional plugin: ${id}`);
          try { await this.loadPlugin(id); console.log(`[PluginManager] ensurePluginsLoaded loaded: ${id}`); } catch (e) { console.error(`PluginManager: failed to load ${id}:`, e); }
        } else {
          console.log(`[PluginManager] ensurePluginsLoaded skip optional plugin (not on disk): ${id}`);
        }
      }
    }
    console.log(`[PluginManager] ensurePluginsLoaded done`);
  }

  async downloadPlugin(info: PluginInfo): Promise<void> {
    const settings = this.opts.getSettings();
    if (settings.devMode) return; // dev mode: skip download, load from disk directly

    const auth = this.opts.getAuth();
    const downloadUrl = `${auth.serverUrl}/plugins/${info.id}/download`;
    const r = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!r.ok) throw new Error(`Download failed for ${info.id}: HTTP ${r.status}`);

    const zipBuffer = await r.arrayBuffer();
    const adapter = this.opts.app.vault.adapter;
    const dir = this._subPluginsDir();
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);

    await this.extractPluginZip(info.id, zipBuffer);

    await adapter.write(this._versionPath(info.id), info.version);
    if (info.buildDate) {
      await adapter.write(this._buildDatePath(info.id), info.buildDate);
      this._installedBuildDates[info.id] = info.buildDate;
    }
    this._installedVersions[info.id] = info.version;
  }

  private async extractPluginZip(id: string, zipBuffer: ArrayBuffer): Promise<void> {
    const adapter = this.opts.app.vault.adapter;
    const subDir = this._subPluginsDir();
    const bundlePath = this._bundlePath(id);
    const assetsDir = normalizePath(`${subDir}/${id}/assets`);

    const unzipped = unzipSync(new Uint8Array(zipBuffer));

    // Check for main.js before cleaning old files
    if (!('main.js' in unzipped)) {
      throw new Error(`extractPluginZip: zip for "${id}" contains no main.js entry`);
    }

    // Write new files first, then clean up old assets (so old bundle survives if write fails)
    for (const [relativePath, data] of Object.entries(unzipped)) {
      if (relativePath.endsWith('/')) continue; // skip directory entries from archiver
      if (relativePath === 'main.js') {
        await adapter.write(bundlePath, strFromU8(data));
      } else if (relativePath.startsWith('assets/')) {
        const assetPath = normalizePath(`${subDir}/${id}/${relativePath}`);
        const parentDir = assetPath.substring(0, assetPath.lastIndexOf('/'));
        if (!(await adapter.exists(parentDir))) {
          await adapter.mkdir(parentDir);
        }
        await adapter.writeBinary(assetPath, data.buffer as ArrayBuffer);
      }
    }

    // Remove stale assets only after successful extraction
    if (await adapter.exists(assetsDir)) {
      await (adapter as any).rmdir(assetsDir, true);
    }
  }

  async loadPlugin(id: string): Promise<void> {
    if (this._loadedPlugins.has(id)) return;
    const bundlePath = this._resolvedBundlePath(id);

    const settings = this.opts.getSettings();
    let code: string;
    if (settings.devMode) {
      const fs = this._requireFs();
      if (!fs.existsSync(bundlePath)) throw new Error(`Bundle not found: ${bundlePath}`);
      code = fs.readFileSync(bundlePath, 'utf-8');
    } else {
      if (!(await this.opts.app.vault.adapter.exists(bundlePath))) {
        throw new Error(`Bundle not found: ${bundlePath}`);
      }
      code = await this.opts.app.vault.adapter.read(bundlePath);
    }

    const nodeRequire = typeof require !== 'undefined' ? require : null;

    // Capture obsidian here, in plugin-core's module context where it resolves correctly.
    // Sub-plugin bundles call require('obsidian') but Node can't resolve it for child modules;
    // we hand it explicitly via the shim below.
    let obsidianMod: any = {};
    if (nodeRequire) {
      try { obsidianMod = nodeRequire('obsidian'); } catch { /* mobile */ }
    }

    // Clear the cache entry so reloads pick up new code.
    if (nodeRequire) {
      try { delete nodeRequire.cache?.[nodeRequire.resolve?.(bundlePath) ?? bundlePath]; } catch { /* ignore */ }
    }

    const fakeModule: { exports: any } = { exports: {} };
    const subRequire = (m: string) => {
      if (m === 'obsidian') return obsidianMod;
      if (nodeRequire) { try { return nodeRequire(m); } catch { return {}; } }
      return {};
    };
    new Function('module', 'exports', 'require', code)(fakeModule, fakeModule.exports, subRequire);

    const Klass = fakeModule.exports?.default ?? fakeModule.exports;
    if (!Klass) throw new Error(`No default export in ${id} bundle`);

    const info = this._availablePlugins.find((p) => p.id === id);
    const manifest = {
      id,
      name: info?.name ?? id,
      version: info?.version ?? '0.0.0',
      minAppVersion: '1.0.0',
      description: info?.description ?? '',
      author: 'Obsidian Together',
      authorUrl: '',
      isDesktopOnly: false,
    };

    const instance = new Klass(this.opts.app, manifest);
    await instance.load();
    this._loadedPlugins.set(id, instance);
  }

  async unloadPlugin(id: string): Promise<void> {
    const instance = this._loadedPlugins.get(id);
    if (instance) {
      try { instance.unload?.(); } catch (e) { console.error(`PluginManager: error unloading ${id}:`, e); }
      this._loadedPlugins.delete(id);
    }
    if (typeof document !== 'undefined') {
      document.querySelector(`style[data-plugin-id="${id}"]`)?.remove();
    }
  }

  async reloadAll(): Promise<void> {
    const ids = [...this._loadedPlugins.keys()];
    for (const id of ids) await this.unloadPlugin(id);
    for (const id of ids) await this.loadPlugin(id);
  }

  unloadAll(): void {
    for (const [id, instance] of this._loadedPlugins) {
      try { instance.unload?.(); } catch (e) { console.error(`PluginManager: error unloading ${id}:`, e); }
      if (typeof document !== 'undefined') {
        document.querySelector(`style[data-plugin-id="${id}"]`)?.remove();
      }
    }
    this._loadedPlugins.clear();
  }

  async syncEnabledPlugins(username: string): Promise<void> {
    console.log(`[PluginManager] syncEnabledPlugins start — user: ${username}`);
    const enabledInVault = await this._readEnabledPluginsFromVault(username);
    console.log(`[PluginManager] syncEnabledPlugins vault enabled: [${enabledInVault.join(', ')}]`);

    const optionalLoaded = [...this._loadedPlugins.keys()].filter(id => id !== 'together-community');
    for (const id of optionalLoaded) {
      if (!enabledInVault.includes(id)) {
        console.log(`[PluginManager] syncEnabledPlugins unloading removed plugin: ${id}`);
        await this.unloadPlugin(id);
      }
    }

    for (const id of enabledInVault) {
      if (id === 'together-community') continue;
      if (this._loadedPlugins.has(id)) { console.log(`[PluginManager] syncEnabledPlugins skip (already loaded): ${id}`); continue; }
      const info = this._availablePlugins.find(p => p.id === id);
      if (!info) { console.log(`[PluginManager] syncEnabledPlugins skip (not in available list): ${id}`); continue; }
      try {
        if (this.isOnline) {
          const installed = this._installedVersions[id];
          if (!installed || installed !== info.version) {
            console.log(`[PluginManager] syncEnabledPlugins downloading: ${id} (installed: ${installed ?? 'none'}, available: ${info.version})`);
            await this.downloadPlugin(info);
          }
        }
        console.log(`[PluginManager] syncEnabledPlugins loading: ${id}`);
        await this.loadPlugin(id);
        console.log(`[PluginManager] syncEnabledPlugins loaded: ${id}`);
      } catch (e) {
        console.error(`PluginManager: failed to sync plugin ${id}:`, e);
      }
    }
    console.log(`[PluginManager] syncEnabledPlugins done`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /** Only used in devMode where absolute paths and Node fs are needed. */
  private _requireFs(): any {
    if (typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        if (fs && typeof fs.existsSync === 'function') return fs;
      } catch { /* mobile */ }
    }
    return {
      existsSync: () => false,
      readFileSync: () => '',
      writeFileSync: () => {},
      mkdirSync: () => {},
      readdirSync: () => [],
    };
  }

  /** Check if a bundle exists — uses vault adapter for non-devMode, fs for devMode. */
  private async _bundleExists(bundlePath: string): Promise<boolean> {
    const settings = this.opts.getSettings();
    if (settings.devMode) return this._requireFs().existsSync(bundlePath);
    return this.opts.app.vault.adapter.exists(bundlePath);
  }

  private _subPluginsDir(): string {
    const settings = this.opts.getSettings();
    if (settings.devMode && settings.devRepoRoot) {
      return settings.devRepoRoot + '/apps';
    }
    // vault-relative path — works on both desktop and mobile via vault.adapter
    return '.obsidian/plugins/obsidian-together/sub-plugins';
  }

  private _bundlePath(id: string): string {
    return this._subPluginsDir() + `/${id}.js`;
  }

  private _buildDatePath(id: string): string {
    return this._subPluginsDir() + `/${id}.builddate`;
  }

  private _versionPath(id: string): string {
    return this._subPluginsDir() + `/${id}.version`;
  }

  private _resolvedBundlePath(id: string): string {
    const settings = this.opts.getSettings();
    if (settings.devMode && settings.devRepoRoot) {
      return `${settings.devRepoRoot}/apps/${id}/main.js`;
    }
    return this._bundlePath(id);
  }

  private async _readEnabledPluginsFromVault(username: string): Promise<string[]> {
    try {
      const userFilePath = `The Hub/users/${username}.md`;
      const exists = await this.opts.app.vault.adapter.exists(userFilePath);
      if (!exists) return [];
      const content = await this.opts.app.vault.adapter.read(userFilePath);
      // Simple frontmatter parse — extract enabledPlugins array
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return [];
      const fm = match[1];
      const listMatch = fm.match(/enabledPlugins:\s*\n((?:\s*-\s*.+\n?)*)/);
      if (!listMatch) return [];
      return listMatch[1]
        .split('\n')
        .map(l => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async _loadInstalledVersions(): Promise<void> {
    const settings = this.opts.getSettings();
    if (settings.devMode) {
      // In dev mode, read version.json from repo using Node fs
      const fs = this._requireFs();
      for (const id of ['together-community', 'games', 'music-band']) {
        const vp = `${settings.devRepoRoot}/apps/${id}/version.json`;
        if (fs.existsSync(vp)) {
          try {
            const v = JSON.parse(fs.readFileSync(vp, 'utf-8'));
            this._installedVersions[id] = `${v.major}.${v.minor}.${v.build}`;
            if (v.buildDate) this._installedBuildDates[id] = v.buildDate;
          } catch { /* ignore */ }
        }
      }
      return;
    }

    // Non-dev: scan vault-relative sub-plugins directory for *.version files
    const dir = this._subPluginsDir();
    const adapter = this.opts.app.vault.adapter;
    if (!(await adapter.exists(dir))) return;
    const { files } = await adapter.list(dir);
    for (const filePath of files) {
      const file = filePath.split('/').pop()!;
      if (!file.endsWith('.version')) continue;
      const id = file.slice(0, -'.version'.length);
      try {
        const version = (await adapter.read(filePath)).trim();
        if (version) this._installedVersions[id] = version;
      } catch { /* ignore */ }
      try {
        const bdPath = `${dir}/${id}.builddate`;
        if (await adapter.exists(bdPath)) {
          const buildDate = (await adapter.read(bdPath)).trim();
          if (buildDate) this._installedBuildDates[id] = buildDate;
        }
      } catch { /* ignore */ }
    }
  }
}
