# Task 2: _cleanupObsoletePlugins + PreviewCache.evict

## Context

This is Task 2 of the obsolete plugin cleanup feature in `obsidian-together-plugin` (`/Users/I505237/SAPDevelop/obsidian-together-plugin`). Task 1 (already committed) added `_removeFromEnabledPlugins` to `PluginManager`. This task adds:

1. `PreviewCache.evict(pluginId)` — removes stale preview files from disk and in-memory cache
2. `PluginManager._cleanupObsoletePlugins(serverIds, username)` — orchestrates full cleanup
3. Call `_cleanupObsoletePlugins` at the top of `syncEnabledPlugins`

## Files to modify

- `src/plugins/PreviewCache.ts` — add public `evict(pluginId: string): Promise<void>` method
- `src/plugins/PreviewCache.spec.ts` — tests for `evict`
- `src/plugins/PluginManager.ts` — add `_cleanupObsoletePlugins` private method, call at top of `syncEnabledPlugins`
- `src/plugins/PluginManager.test.ts` — 3 tests for `_cleanupObsoletePlugins` in the existing `syncEnabledPlugins` describe block

## Part A — `PreviewCache.evict(pluginId)`

### What it does

```
1. this._metaCache.delete(pluginId)
2. this._bodyCache.delete(pluginId)
3. Clear _imageCache entries for this plugin:
   this._imageCache.delete(`${pluginId}/__refreshed`)
   this._imageCache.delete(`${pluginId}/${pluginId}.jpg`)
   this._imageCache.delete(`${pluginId}/${pluginId}.cover.jpg`)
4. If this._adapter && this._vaultBase:
   dir = `${this._vaultBase}/${pluginId}`
   if (await this._adapter.exists(dir)) await (this._adapter as any).rmdir(dir, true)
5. If this._basePath && this._hasFsAccess:
   dir = `${this._basePath}/${pluginId}`
   if (this._fs.existsSync(dir)) this._fs.rmSync(dir, { recursive: true, force: true })
```

Errors from rmdir/rmSync are caught and logged as `console.warn` — never throws.

### Implementation

Add after `listCachedIds()` in `PreviewCache.ts`:

```typescript
async evict(pluginId: string): Promise<void> {
  this._metaCache.delete(pluginId);
  this._bodyCache.delete(pluginId);
  this._imageCache.delete(`${pluginId}/__refreshed`);
  this._imageCache.delete(`${pluginId}/${pluginId}.jpg`);
  this._imageCache.delete(`${pluginId}/${pluginId}.cover.jpg`);
  if (this._adapter && this._vaultBase) {
    const dir = `${this._vaultBase}/${pluginId}`;
    try {
      if (await this._adapter.exists(dir)) await (this._adapter as any).rmdir(dir, true);
    } catch (e) {
      console.warn(`[PreviewCache] evict ${pluginId}: adapter rmdir failed`, e);
    }
  }
  if (this._basePath && this._hasFsAccess) {
    const dir = `${this._basePath}/${pluginId}`;
    try {
      if (this._fs.existsSync(dir)) this._fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[PreviewCache] evict ${pluginId}: fs rmSync failed`, e);
    }
  }
}
```

### Tests for `evict` in `PreviewCache.spec.ts`

Add inside the existing `describe('PreviewCache', ...)` block. The existing tests use `tmpDir` and `nodeFs` (real fs). Add a new sub-describe:

```typescript
describe('evict', () => {
  it('removes per-plugin folder from disk and clears in-memory caches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-evict-'));
    const cache = new PreviewCache(tmpDir, nodeFs);
    // Pre-populate caches
    const pluginDir = path.join(tmpDir, 'together-community');
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'together-community.md'), '---\nversion: "1.0.0"\npreviewChecksum: "abc"\n---\nhello');
    // Warm in-memory cache
    cache.readMeta('together-community');
    expect(cache.readBody('together-community')).toBe('hello');
    await cache.evict('together-community');
    expect(fs.existsSync(pluginDir)).toBe(false);
    expect(cache.readMeta('together-community')).toBeNull();
    expect(cache.readBody('together-community')).toBeNull();
    fs.rmdirSync(tmpDir, { recursive: true } as any);
  });

  it('is a no-op when folder does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-evict2-'));
    const cache = new PreviewCache(tmpDir, nodeFs);
    await expect(cache.evict('nonexistent')).resolves.toBeUndefined();
    fs.rmdirSync(tmpDir, { recursive: true } as any);
  });

  it('evicts via adapter when no basePath', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      rmdir: vi.fn().mockResolvedValue(undefined),
    };
    const cache = new PreviewCache(null, undefined, adapter, '.obsidian/plugins/obsidian-together/previews');
    cache['_metaCache'].set('together-community', { version: '1.0.0' });
    await cache.evict('together-community');
    expect(adapter.rmdir).toHaveBeenCalledWith(
      '.obsidian/plugins/obsidian-together/previews/together-community',
      true
    );
    expect(cache.readMeta('together-community')).toBeNull();
  });
});
```

The existing `PreviewCache.spec.ts` already imports `fs`, `path`, `os`, `vi`. Check the import list and add any missing ones.

## Part B — `PluginManager._cleanupObsoletePlugins`

### Implementation

Add before `_removeFromEnabledPlugins` in `PluginManager.ts`:

```typescript
private async _cleanupObsoletePlugins(serverIds: Set<string>, username: string): Promise<void> {
  const settings = this.opts.getSettings();
  if (settings.devMode) return;
  if (serverIds.size === 0) return;
  const adapter = this.opts.app.vault.adapter;
  const dir = this._subPluginsDir();
  if (!(await adapter.exists(dir))) return;
  const { folders } = await adapter.list(dir);
  for (const folderPath of folders) {
    const id = folderPath.split('/').pop()!;
    if (!id || serverIds.has(id)) continue;
    console.log(`[PluginManager] cleanupObsoletePlugins removing: ${id}`);
    await this.unloadPlugin(id);
    try { await (adapter as any).rmdir(folderPath, true); } catch (e) { console.warn(`[PluginManager] cleanup failed to delete ${id}:`, e); }
    delete this._installedVersions[id];
    await this._removeFromEnabledPlugins(username, id);
    try { await this.getPreviewCache().evict(id); } catch (e) { console.warn(`[PluginManager] cleanup preview evict failed for ${id}:`, e); }
  }
}
```

### Call site in `syncEnabledPlugins`

Add two lines right after the first `console.log` in `syncEnabledPlugins`:

```typescript
const serverIds = new Set(this._availablePlugins.map(p => p.id));
await this._cleanupObsoletePlugins(serverIds, username);
```

### Tests — 3 new cases in `describe('PluginManager.syncEnabledPlugins', ...)`

```typescript
it('unloads and deletes obsolete plugin folder from disk', async () => {
  const adapter = {
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue({
      files: [],
      folders: ['.obsidian/plugins/obsidian-together/sub-plugins/together-community'],
    }),
    rmdir: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
  };
  const pm = new PluginManager({
    app: { vault: { adapter } } as any,
    getSettings: () => ({ devMode: false } as any),
    getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
  });
  pm['_availablePlugins'] = [
    { id: 'community', version: '1.0.0', name: 'Community', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    { id: 'music-band', version: '1.0.0', name: 'Music Band', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
  ] as any;
  pm['_installedVersions'] = { 'together-community': '0.1.1' };
  pm['_loadedPlugins'].set('together-community', { unload: vi.fn() });
  pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);
  const unload = vi.spyOn(pm, 'unloadPlugin');

  await pm.syncEnabledPlugins('alice');

  expect(unload).toHaveBeenCalledWith('together-community');
  expect(adapter.rmdir).toHaveBeenCalledWith(
    '.obsidian/plugins/obsidian-together/sub-plugins/together-community',
    true
  );
  expect(pm['_installedVersions']['together-community']).toBeUndefined();
});

it('removes obsolete plugin id from enabledPlugins in vault file', async () => {
  const vaultContent = '---\nenabledPlugins:\n  - together-community\n  - music-band\n---\n\nbody';
  let writtenContent = '';
  const adapter = {
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue({
      files: [],
      folders: ['.obsidian/plugins/obsidian-together/sub-plugins/together-community'],
    }),
    rmdir: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue(vaultContent),
    write: vi.fn().mockImplementation((_p: string, c: string) => { writtenContent = c; return Promise.resolve(); }),
  };
  const pm = new PluginManager({
    app: { vault: { adapter } } as any,
    getSettings: () => ({ devMode: false } as any),
    getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
  });
  pm['_availablePlugins'] = [
    { id: 'community', version: '1.0.0', name: 'Community', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
  ] as any;
  pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);

  await pm.syncEnabledPlugins('alice');

  expect(writtenContent).not.toContain('together-community');
  expect(writtenContent).toContain('music-band');
});

it('skips cleanup when _availablePlugins is empty (offline guard)', async () => {
  const adapter = {
    exists: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue({
      files: [],
      folders: ['.obsidian/plugins/obsidian-together/sub-plugins/together-community'],
    }),
    rmdir: vi.fn().mockResolvedValue(undefined),
  };
  const pm = new PluginManager({
    app: { vault: { adapter } } as any,
    getSettings: () => ({ devMode: false } as any),
    getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
  });
  pm['_availablePlugins'] = [];
  pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);

  await pm.syncEnabledPlugins('alice');

  expect(adapter.rmdir).not.toHaveBeenCalled();
});
```

## Global Constraints

- devMode guard: skip when `settings.devMode === true`
- Offline guard: skip when `_availablePlugins.length === 0`
- Sub-plugins dir: `.obsidian/plugins/obsidian-together/sub-plugins`
- Preview dir: `.obsidian/plugins/obsidian-together/previews`
- Cleanup is silent (no Obsidian Notice)
- All errors caught and logged as warnings — never throws

## Test command

```bash
pnpm test
```

## Commit

```bash
git add src/plugins/PreviewCache.ts src/plugins/PreviewCache.spec.ts src/plugins/PluginManager.ts src/plugins/PluginManager.test.ts
git commit -m "feat(plugin-manager): remove obsolete sub-plugin folders and preview cache on sync"
```

## Report

Write to: `/Users/I505237/SAPDevelop/obsidian-together-plugin/.superpowers/briefs/task-2-report.md`

Return: Status (DONE/BLOCKED), commit hash, test count.
