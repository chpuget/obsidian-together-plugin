import type { App } from 'obsidian';
import { normalizePath, Notice, Platform } from 'obsidian';
import { unzipSync, strFromU8 } from 'fflate';
import type { TogetherSettings, AuthState, PluginInfo } from '../types';
import { PreviewCache } from './PreviewCache';
import type { Logger } from '../logger';

export interface PluginManagerOptions {
  app: App;
  getSettings: () => TogetherSettings;
  getAuth: () => AuthState;
  onPluginLoaded?: (id: string, instance: unknown) => void;
  logger: Logger;
}

export function parseVersion(v: string): { major: number; minor: number; build: number } | null {
  const parts = v.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  return { major: parts[0], minor: parts[1], build: parts[2] };
}

export function resolveUpdateOrder(plugins: PluginInfo[]): PluginInfo[] {
  const ids = new Set(plugins.map(p => p.id));
  const inDegree = new Map<string, number>(plugins.map(p => [p.id, 0]));
  const adj = new Map<string, string[]>(plugins.map(p => [p.id, []]));

  for (const p of plugins) {
    for (const dep of (p.requires ?? [])) {
      if (!ids.has(dep)) continue; // dep not in update set — skip
      inDegree.set(p.id, inDegree.get(p.id)! + 1);
      adj.get(dep)!.push(p.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const pluginMap = new Map(plugins.map(p => [p.id, p]));
  const result: PluginInfo[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(pluginMap.get(id)!);
    for (const next of adj.get(id)!) {
      const deg = inDegree.get(next)! - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  // Cycle fallback: return original order
  return result.length === plugins.length ? result : plugins;
}

export class PluginManager {
  private _availablePlugins: PluginInfo[] = [];
  private _installedVersions: Record<string, string> = {};
  private _installedBuildDates: Record<string, string> = {};
  private _loadedPlugins = new Map<string, any>();
  private _loadingPromise: Promise<void> | null = null;
  private _previewCache: PreviewCache | null = null;
  isOnline = false;
  private readonly logger: Logger;

  constructor(private readonly opts: PluginManagerOptions) {
    this.logger = opts.logger;
  }

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

  checkDependencies(id: string): PluginInfo[] {
    const info = this._availablePlugins.find(p => p.id === id);
    if (!info) return [];
    const loaded = new Set(this.getLoadedPluginIds());
    return (info.requires ?? [])
      .filter(dep => dep !== 'obsidian-together')
      .map(dep => this._availablePlugins.find(p => p.id === dep))
      .filter((p): p is PluginInfo => !!p && !loaded.has(p.id));
  }

  getSubPluginAssetResourceUrl(pluginId: string, assetRelPath: string): string {
    const vaultRelPath = normalizePath(`${this._subPluginsDir()}/${pluginId}/${assetRelPath}`);
    return (this.opts.app.vault.adapter as { getResourcePath(p: string): string }).getResourcePath(vaultRelPath);
  }

  async autoUpdate(): Promise<{ abortSync: boolean }> {
    await this.refreshAvailablePlugins();
    const toUpdate = this._availablePlugins.filter(
      p => p.id in this._installedVersions && this.hasUpdate(p.id)
    );
    if (toUpdate.length === 0) return { abortSync: false };

    const ordered = resolveUpdateOrder(toUpdate);
    const names = ordered.map(p => p.name).join(', ');
    new Notice(`Auto-updating plugins: ${names}`);

    const tc = ordered.find(p => p.id === 'community');
    const others = ordered.filter(p => p.id !== 'community');

    for (const p of others) {
      await this.downloadPlugin(p);
      await this.unloadPlugin(p.id);
      await this.loadPlugin(p.id);
    }

    if (tc) {
      await this.downloadPlugin(tc);
      await this.unloadPlugin(tc.id);
      await this.loadPlugin(tc.id);
      return { abortSync: true };
    }

    return { abortSync: false };
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
        Platform.isMobile,
        this.logger,
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
    this.logger.verbose(`[PluginManager] updateFromPluginList: ${plugins.length} plugins, ${stale.length} stale`);
    const refreshes = stale
      .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
        .catch((e) => this.logger.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
    if (refreshes.length > 0) await Promise.allSettled(refreshes);
    await this._evictObsoletePreviews(new Set(plugins.map(p => p.id)));
    this.logger.verbose(`[PluginManager] updateFromPluginList: done`);
  }

  /** Lightweight refresh: re-fetches the available-plugins list from the server and
   *  updates _availablePlugins so hasUpdate() reflects the latest versions.
   *  Called after each periodic sync so the UI shows available updates without restart. */
  async refreshAvailablePlugins(): Promise<void> {
    const auth = this.opts.getAuth();
    if (!auth.isLoggedIn || !auth.serverUrl || !auth.token) return;
    try {
      const pluginsUrl = `${auth.serverUrl}/plugins${auth.branch === 'dev' ? '?branch=dev' : ''}`;
      const r = await fetch(pluginsUrl, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (r.ok) {
        this._availablePlugins = await r.json() as PluginInfo[];
        this.isOnline = true;
        const cache = this.getPreviewCache();
        const refreshes = this._availablePlugins
          .filter(info => !cache.isCurrent(info.id, info.version, info.previewChecksum))
          .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
            .catch((e) => this.logger.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
        if (refreshes.length > 0) await Promise.allSettled(refreshes);
        await this._evictObsoletePreviews(new Set(this._availablePlugins.map(p => p.id)));
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
    this.logger.verbose(`[PluginManager] ensurePluginsLoaded start — isLoggedIn: ${auth.isLoggedIn}, serverUrl: ${auth.serverUrl ?? 'none'}`);

    // Only hit the server when fully authenticated
    if (auth.isLoggedIn && auth.serverUrl && auth.token) {
      try {
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded fetching plugin list from server…`);
        const r = await fetch(`${auth.serverUrl}/plugins${auth.branch === 'dev' ? '?branch=dev' : ''}`, {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (r.ok) {
          this._availablePlugins = await r.json() as PluginInfo[];
          this.isOnline = true;
          this.logger.verbose(`[PluginManager] ensurePluginsLoaded fetched ${this._availablePlugins.length} plugins, isOnline: true`);
          const cache = this.getPreviewCache();
          const refreshes = this._availablePlugins
            .filter(info => !cache.isCurrent(info.id, info.version, info.previewChecksum))
            .map(info => cache.refresh(info.id, info.version, info.previewChecksum, info.previewUrls)
              .catch((e) => this.logger.warn(`PluginManager: preview refresh failed for ${info.id}:`, e)));
          if (refreshes.length > 0) await Promise.allSettled(refreshes);
        } else {
          this.isOnline = false;
          this.logger.verbose(`[PluginManager] ensurePluginsLoaded server responded ${r.status}, isOnline: false`);
        }
      } catch (e) {
        this.isOnline = false;
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded server unreachable, isOnline: false`, e);
      }
    } else {
      this.logger.verbose(`[PluginManager] ensurePluginsLoaded skipping server fetch (not authenticated)`);
    }

    // Load installed versions from disk
    await this._loadInstalledVersions();
    this.logger.verbose(`[PluginManager] ensurePluginsLoaded installed versions: ${JSON.stringify(this._installedVersions)}`);

    // community is always required
    const tcInfo = this._availablePlugins.find((p) => p.id === 'community');
    if (tcInfo) {
      const installed = this._installedVersions['community'];
      const bundlePath = this._bundlePath('community');
      const bundleOnDisk = await this._bundleExists(bundlePath);
      if (!installed || installed !== tcInfo.version || !bundleOnDisk) {
        const reason = !bundleOnDisk && installed === tcInfo.version
          ? 'bundle missing on disk'
          : `installed: ${installed ?? 'none'}`;
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded downloading community (${reason}, available: ${tcInfo.version})`);
        try {
          await this.downloadPlugin(tcInfo);
        } catch (e) {
          this.logger.error('[PluginManager] ensurePluginsLoaded failed to download community:', e);
          new Notice(`Failed to download community: ${(e as Error).message ?? e}`);
        }
      }
    }
    if (!this._loadedPlugins.has('community')) {
      const bundlePath = this._bundlePath('community');
      // Fallback: bundle absent but tcInfo was null (list fetch may have failed at startup).
      // Re-fetch the plugin list with a fresh auth token, then use the normal download path.
      if (!(await this._bundleExists(bundlePath))) {
        const freshAuth = this.opts.getAuth();
        if (freshAuth.isLoggedIn && freshAuth.serverUrl && freshAuth.token) {
          this.logger.verbose(`[PluginManager] ensurePluginsLoaded community bundle missing — retrying plugin list fetch`);
          try {
            await this.refreshAvailablePlugins();
            const retryInfo = this._availablePlugins.find(p => p.id === 'community');
            if (retryInfo) {
              this.logger.verbose(`[PluginManager] ensurePluginsLoaded community retry: list fetched, downloading`);
              await this.downloadPlugin(retryInfo);
              this.logger.verbose(`[PluginManager] ensurePluginsLoaded community retry download succeeded`);
            } else {
              this.logger.error(`[PluginManager] ensurePluginsLoaded community not found in plugin list after retry`);
              new Notice('Community plugin not found on server. Please contact support.');
            }
          } catch (e) {
            this.logger.error('[PluginManager] ensurePluginsLoaded community retry failed:', e);
            new Notice(`Community plugin unavailable: ${(e as Error).message ?? e}. Check your connection.`);
          }
        }
      }
      if (await this._bundleExists(bundlePath)) {
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded loading community`);
        await this.loadPlugin('community');
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded community loaded`);
      } else {
        this.logger.verbose(`[PluginManager] ensurePluginsLoaded community bundle not found on disk`);
        new Notice('Community plugin could not be loaded. Please check your connection and reload.');
      }
    } else {
      this.logger.verbose(`[PluginManager] ensurePluginsLoaded community already loaded`);
    }

    // Load optional plugins the user previously enabled
    const authState = this.opts.getAuth();
    if (authState.username) {
      const enabledIds = await this._readEnabledPluginsFromVault(authState.username);
      this.logger.verbose(`[PluginManager] ensurePluginsLoaded optional plugins for ${authState.username}: [${enabledIds.join(', ')}]`);
      for (const id of enabledIds) {
        if (id === 'community') continue;
        if (this._loadedPlugins.has(id)) continue;
        const bundlePath = this._bundlePath(id);
        if (await this._bundleExists(bundlePath)) {
          this.logger.verbose(`[PluginManager] ensurePluginsLoaded loading optional plugin: ${id}`);
          try { await this.loadPlugin(id); this.logger.verbose(`[PluginManager] ensurePluginsLoaded loaded: ${id}`); } catch (e) { this.logger.error(`PluginManager: failed to load ${id}:`, e); }
        } else {
          this.logger.verbose(`[PluginManager] ensurePluginsLoaded skip optional plugin (not on disk): ${id}`);
        }
      }
    }
    this.logger.verbose(`[PluginManager] ensurePluginsLoaded done`);
  }

  async downloadPlugin(info: PluginInfo): Promise<void> {
    const settings = this.opts.getSettings();
    if (settings.devMode) return; // dev mode: skip download, load from disk directly

    const auth = this.opts.getAuth();
    const downloadUrl = `${auth.serverUrl}/plugins/${info.id}/download${auth.branch === 'dev' ? '?branch=dev' : ''}`;
    const r = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!r.ok) throw new Error(`Download failed for ${info.id}: HTTP ${r.status}`);

    const zipBuffer = await r.arrayBuffer();
    const adapter = this.opts.app.vault.adapter;
    const dir = this._subPluginsDir();
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const pluginDir = normalizePath(`${dir}/${info.id}`);
    if (!(await adapter.exists(pluginDir))) await adapter.mkdir(pluginDir);

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

    const unzipped = unzipSync(new Uint8Array(zipBuffer));

    // Check for main.js before cleaning old files
    if (!('main.js' in unzipped)) {
      throw new Error(`extractPluginZip: zip for "${id}" contains no main.js entry`);
    }

    // Remove stale assets before writing new ones
    const assetsDir = normalizePath(`${subDir}/${id}/assets`);
    if (await adapter.exists(assetsDir)) {
      await (adapter as any).rmdir(assetsDir, true);
    }

    // Ensure plugin dir exists
    const pluginDir = normalizePath(`${subDir}/${id}`);
    if (!(await adapter.exists(pluginDir))) await adapter.mkdir(pluginDir);

    for (const [relativePath, data] of Object.entries(unzipped)) {
      if (relativePath.endsWith('/')) continue;
      if (relativePath === 'main.js') {
        const content = strFromU8(data);
        await adapter.write(bundlePath, content);
      } else if (relativePath.startsWith('assets/')) {
        const assetPath = normalizePath(`${subDir}/${id}/${relativePath}`);
        const parentDir = assetPath.substring(0, assetPath.lastIndexOf('/'));
        if (!(await adapter.exists(parentDir))) {
          await adapter.mkdir(parentDir);
        }
        await adapter.writeBinary(assetPath, data.buffer as ArrayBuffer);
      }
    }
  }

  async loadPlugin(id: string): Promise<void> {
    if (this._loadedPlugins.has(id)) return;
    const bundlePath = this._bundlePath(id);

    if (!(await this.opts.app.vault.adapter.exists(bundlePath))) {
      throw new Error(`Bundle not found: ${bundlePath}`);
    }
    const code = await this.opts.app.vault.adapter.read(bundlePath);

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

    const firstBytes = Array.from(code.slice(0, 8)).map(c => c.charCodeAt(0).toString(16)).join(' ');
    this.logger.verbose(`[PluginManager] loadPlugin ${id}: code length=${code.length}, first bytes=[${firstBytes}], preview=${JSON.stringify(code.slice(0, 120))}`);

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
    this.opts.onPluginLoaded?.(id, instance);
  }

  async unloadPlugin(id: string): Promise<void> {
    const instance = this._loadedPlugins.get(id);
    if (instance) {
      try { instance.unload?.(); } catch (e) { this.logger.error(`PluginManager: error unloading ${id}:`, e); }
      this._loadedPlugins.delete(id);
    }
    if (typeof document !== 'undefined') {
      document.querySelector(`style[data-plugin-id="${id}"]`)?.remove();
    }
  }

  async reloadAll(): Promise<void> {
    const idsToLoad = [...this._loadedPlugins.keys()];
    for (const id of idsToLoad) await this.unloadPlugin(id);
    for (const id of idsToLoad) {
      try { await this.loadPlugin(id); } catch (e) { this.logger.error(`PluginManager: reloadAll failed to load ${id}:`, e); }
    }
  }

  unloadAll(): void {
    for (const [id, instance] of this._loadedPlugins) {
      try { instance.unload?.(); } catch (e) { this.logger.error(`PluginManager: error unloading ${id}:`, e); }
      if (typeof document !== 'undefined') {
        document.querySelector(`style[data-plugin-id="${id}"]`)?.remove();
      }
    }
    this._loadedPlugins.clear();
  }

  async syncEnabledPlugins(username: string): Promise<void> {
    this.logger.verbose(`[PluginManager] syncEnabledPlugins start — user: ${username}`);
    const serverIds = new Set(this._availablePlugins.map(p => p.id));
    await this._cleanupObsoletePlugins(serverIds, username);
    const enabledInVault = await this._readEnabledPluginsFromVault(username);
    this.logger.verbose(`[PluginManager] syncEnabledPlugins vault enabled: [${enabledInVault.join(', ')}]`);

    const optionalLoaded = [...this._loadedPlugins.keys()].filter(id => id !== 'community');
    for (const id of optionalLoaded) {
      if (!enabledInVault.includes(id)) {
        this.logger.verbose(`[PluginManager] syncEnabledPlugins unloading removed plugin: ${id}`);
        await this.unloadPlugin(id);
      }
    }

    for (const id of enabledInVault) {
      if (id === 'community') continue;
      if (this._loadedPlugins.has(id)) { this.logger.verbose(`[PluginManager] syncEnabledPlugins skip (already loaded): ${id}`); continue; }
      const info = this._availablePlugins.find(p => p.id === id);
      if (!info) { this.logger.verbose(`[PluginManager] syncEnabledPlugins skip (not in available list): ${id}`); continue; }
      const missingDeps = this.checkDependencies(id);
      if (missingDeps.length > 0) {
        this.logger.warn(`[PluginManager] syncEnabledPlugins: skipping ${id} — missing deps: ${missingDeps.map(d => d.id).join(', ')}`);
        continue;
      }
      try {
        if (this.isOnline) {
          const installed = this._installedVersions[id];
          const bundlePath = this._bundlePath(id);
          const bundleOnDisk = await this._bundleExists(bundlePath);
          if (!installed || installed !== info.version || !bundleOnDisk) {
            const reason = !bundleOnDisk && installed === info.version
              ? 'bundle missing on disk'
              : `installed: ${installed ?? 'none'}`;
            this.logger.verbose(`[PluginManager] syncEnabledPlugins downloading: ${id} (${reason}, available: ${info.version})`);
            await this.downloadPlugin(info);
          }
        }
        this.logger.verbose(`[PluginManager] syncEnabledPlugins loading: ${id}`);
        await this.loadPlugin(id);
        this.logger.verbose(`[PluginManager] syncEnabledPlugins loaded: ${id}`);
      } catch (e) {
        this.logger.error(`PluginManager: failed to sync plugin ${id}:`, e);
      }
    }
    this.logger.verbose(`[PluginManager] syncEnabledPlugins done`);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /** Check if a bundle exists — uses vault adapter. */
  private async _bundleExists(bundlePath: string): Promise<boolean> {
    return this.opts.app.vault.adapter.exists(bundlePath);
  }

  private _subPluginsDir(): string {
    // vault-relative path — works on both desktop and mobile via vault.adapter
    return '.obsidian/plugins/obsidian-together/sub-plugins';
  }

  private _bundlePath(id: string): string {
    return this._subPluginsDir() + `/${id}/main.js`;
  }

  private _buildDatePath(id: string): string {
    return this._subPluginsDir() + `/${id}/main.builddate`;
  }

  private _versionPath(id: string): string {
    return this._subPluginsDir() + `/${id}/main.version`;
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

  private async _migrateOldFlatFiles(): Promise<void> {
    const adapter = this.opts.app.vault.adapter;
    const dir = '.obsidian/plugins/obsidian-together/sub-plugins';
    if (!(await adapter.exists(dir))) return;
    const { files } = await adapter.list(dir);
    for (const filePath of files) {
      const name = filePath.split('/').pop()!;
      if (name.endsWith('.js') || name.endsWith('.version') || name.endsWith('.builddate')) {
        try { await adapter.remove(filePath); } catch { /* ignore */ }
      }
    }
  }

  private async _cleanupObsoletePlugins(serverIds: Set<string>, username: string): Promise<void> {
    const settings = this.opts.getSettings();
    if (serverIds.size === 0) return;
    const adapter = this.opts.app?.vault?.adapter;
    if (!adapter) return;

    // Sub-plugin folder cleanup — skipped in devMode (dev repo source files must not be deleted)
    if (!settings.devMode) {
      const dir = this._subPluginsDir();
      if (await adapter.exists(dir)) {
        const { folders } = await adapter.list(dir);
        for (const folderPath of folders) {
          const id = folderPath.split('/').pop()!;
          if (!id || serverIds.has(id)) continue;
          this.logger.verbose(`[PluginManager] cleanupObsoletePlugins removing sub-plugin: ${id}`);
          await this.unloadPlugin(id);
          try { await (adapter as any).rmdir(folderPath, true); } catch (e) { this.logger.warn(`[PluginManager] cleanup failed to delete ${id}:`, e); }
          delete this._installedVersions[id];
          await this._removeFromEnabledPlugins(username, id);
        }
      }
    }

    // Preview cache cleanup — always runs (including devMode); evicts orphaned preview folders
    await this._evictObsoletePreviews(serverIds);
  }

  private async _evictObsoletePreviews(serverIds: Set<string>): Promise<void> {
    if (serverIds.size === 0) return;
    const adapter = this.opts.app?.vault?.adapter;
    if (!adapter) return;
    const previewsDir = '.obsidian/plugins/obsidian-together/previews';
    if (!(await adapter.exists(previewsDir))) return;
    const { folders } = await adapter.list(previewsDir);
    for (const folderPath of folders) {
      const id = folderPath.split('/').pop()!;
      if (!id || serverIds.has(id)) continue;
      this.logger.verbose(`[PluginManager] evictObsoletePreviews: removing stale preview ${id}`);
      try { await this.getPreviewCache().evict(id); } catch (e) { this.logger.warn(`[PluginManager] evictObsoletePreviews failed for ${id}:`, e); }
    }
  }

  private async _removeFromEnabledPlugins(username: string, id: string): Promise<void> {
    try {
      const userFilePath = `The Hub/users/${username}.md`;
      const adapter = this.opts.app.vault.adapter;
      if (!(await adapter.exists(userFilePath))) return;
      const content = await adapter.read(userFilePath);
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return;
      const fm = fmMatch[1];
      const listMatch = fm.match(/enabledPlugins:\s*\n((?:\s*-\s*.+\n?)*)/);
      if (!listMatch) return;
      const currentList = listMatch[1]
        .split('\n')
        .map((l: string) => l.replace(/^\s*-\s*/, '').trim())
        .filter(Boolean);
      if (!currentList.includes(id)) return;
      const newList = currentList.filter((p: string) => p !== id);
      const newBlock = newList.length > 0
        ? `enabledPlugins:\n${newList.map((p: string) => `  - ${p}`).join('\n')}`
        : `enabledPlugins: []`;
      const newFm = fm.replace(
        /(enabledPlugins:[^\n]*(?:\n\s*-[^\n]*)*)(\n?)/,
        (_: string, _block: string, trailingNl: string) => newBlock + trailingNl
      );
      const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`);
      await adapter.write(userFilePath, newContent);
    } catch (e) {
      this.logger.warn(`[PluginManager] _removeFromEnabledPlugins failed for ${username}/${id}:`, e);
    }
  }

  private async _loadInstalledVersions(): Promise<void> {
    const settings = this.opts.getSettings();
    if (settings.devMode) {
      const dir = this._subPluginsDir();
      const adapter = this.opts.app.vault.adapter;
      if (await adapter.exists(dir)) {
        const { folders } = await adapter.list(dir);
        for (const folderPath of folders) {
          const id = folderPath.split('/').pop()!;
          if (!id) continue;
          const vp = normalizePath(`${folderPath}/version.json`);
          if (await adapter.exists(vp)) {
            try {
              const v = JSON.parse(await adapter.read(vp));
              this._installedVersions[id] = `${v.major}.${v.minor}.${v.build}`;
              if (v.buildDate) this._installedBuildDates[id] = v.buildDate;
            } catch { /* ignore */ }
          }
        }
      }
      await this._migrateOldFlatFiles();
      return;
    }

    // Migrate old flat-layout files before scanning for per-plugin subdirs
    await this._migrateOldFlatFiles();

    // Non-dev: scan vault-relative sub-plugins directory for per-plugin subdirs
    const dir = this._subPluginsDir();
    const adapter = this.opts.app.vault.adapter;
    if (!(await adapter.exists(dir))) return;
    const { folders } = await adapter.list(dir);
    for (const folderPath of folders) {
      const id = folderPath.split('/').pop()!;
      if (!id) continue;
      try {
        const versionPath = normalizePath(`${folderPath}/main.version`);
        if (await adapter.exists(versionPath)) {
          const version = (await adapter.read(versionPath)).trim();
          if (version) this._installedVersions[id] = version;
        }
      } catch { /* ignore */ }
      try {
        const bdPath = normalizePath(`${folderPath}/main.builddate`);
        if (await adapter.exists(bdPath)) {
          const buildDate = (await adapter.read(bdPath)).trim();
          if (buildDate) this._installedBuildDates[id] = buildDate;
        }
      } catch { /* ignore */ }
    }
  }
}
