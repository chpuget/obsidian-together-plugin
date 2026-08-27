# Obsolete Plugin Cleanup on Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the server sends a plugin list during sync, automatically remove any locally-installed plugin folder (and its `enabledPlugins` vault entry) whose ID no longer appears in that list.

**Architecture:** Add two private helpers to `PluginManager` — `_removeFromEnabledPlugins` rewrites the user's vault file, `_cleanupObsoletePlugins` orchestrates unload + disk delete + vault cleanup — then call the latter at the top of the existing `syncEnabledPlugins` method.

**Tech Stack:** TypeScript, Obsidian vault adapter API, vitest

## Global Constraints

- `devMode` guard: skip all disk cleanup when `settings.devMode === true`
- Offline guard: skip cleanup when `_availablePlugins.length === 0`
- Sub-plugins dir: `.obsidian/plugins/obsidian-together/sub-plugins`
- User file path: `The Hub/users/<username>.md`
- Cleanup is silent (no Obsidian `Notice`)
- All write errors in `_removeFromEnabledPlugins` caught and logged as warnings — never throws
- `community` is always in `_availablePlugins` when online, so it will never be deleted; no special guard needed

---

### Task 1: `_removeFromEnabledPlugins` helper

**Files:**
- Modify: `src/plugins/PluginManager.ts` — add private method
- Test: `src/plugins/PluginManager.test.ts` — new describe block

**Interfaces:**
- Produces: `private async _removeFromEnabledPlugins(username: string, id: string): Promise<void>` — reads `The Hub/users/<username>.md`, removes `id` from the `enabledPlugins` YAML list, writes back. No-op if file missing, key missing, or id not in list.

- [ ] **Step 1: Write the failing tests**

Add a new describe block at the bottom of `src/plugins/PluginManager.test.ts`:

```typescript
describe('PluginManager._removeFromEnabledPlugins', () => {
  function makePmWithAdapter(adapter: any) {
    return new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false } as any),
      getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
    });
  }

  it('removes the target id from enabledPlugins and keeps others', async () => {
    const vaultContent = '---\nenabledPlugins:\n  - together-community\n  - music-band\n---\n\nuser content';
    let writtenContent = '';
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockImplementation((_p: string, c: string) => { writtenContent = c; return Promise.resolve(); }),
    };
    const pm = makePmWithAdapter(adapter);
    await pm['_removeFromEnabledPlugins']('alice', 'together-community');
    expect(writtenContent).not.toContain('together-community');
    expect(writtenContent).toContain('music-band');
  });

  it('writes enabledPlugins: [] when list becomes empty', async () => {
    const vaultContent = '---\nenabledPlugins:\n  - together-community\n---\n\nbody';
    let writtenContent = '';
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockImplementation((_p: string, c: string) => { writtenContent = c; return Promise.resolve(); }),
    };
    const pm = makePmWithAdapter(adapter);
    await pm['_removeFromEnabledPlugins']('alice', 'together-community');
    expect(writtenContent).toContain('enabledPlugins: []');
    expect(writtenContent).not.toContain('together-community');
  });

  it('is a no-op when id is not in enabledPlugins', async () => {
    const vaultContent = '---\nenabledPlugins:\n  - music-band\n---\n\nbody';
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn(),
    };
    const pm = makePmWithAdapter(adapter);
    await pm['_removeFromEnabledPlugins']('alice', 'nonexistent');
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('is a no-op when file does not exist', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      read: vi.fn(),
      write: vi.fn(),
    };
    const pm = makePmWithAdapter(adapter);
    await pm['_removeFromEnabledPlugins']('alice', 'together-community');
    expect(adapter.read).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('does not throw when write fails', async () => {
    const vaultContent = '---\nenabledPlugins:\n  - together-community\n---\n';
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const pm = makePmWithAdapter(adapter);
    await expect(pm['_removeFromEnabledPlugins']('alice', 'together-community')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/I505237/SAPDevelop/obsidian-together-plugin && pnpm test 2>&1 | grep -E "FAIL|PASS|_removeFromEnabledPlugins"
```

Expected: 5 failures with "is not a function" or "not defined"

- [ ] **Step 3: Implement `_removeFromEnabledPlugins` in `PluginManager.ts`**

Add after the `_loadInstalledVersions` method (before the closing `}`):

```typescript
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
      ? `enabledPlugins:\n${newList.map((p: string) => `  - ${p}`).join('\n')}\n`
      : `enabledPlugins: []\n`;
    const newFm = fm.replace(/enabledPlugins:\s*\n(?:\s*-\s*.+\n?)*/, newBlock);
    const newContent = content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`);
    await adapter.write(userFilePath, newContent);
  } catch (e) {
    console.warn(`[PluginManager] _removeFromEnabledPlugins failed for ${username}/${id}:`, e);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test 2>&1 | grep -E "FAIL|PASS|_removeFromEnabledPlugins"
```

Expected: all 5 new tests PASS, no regressions

- [ ] **Step 5: Commit**

```bash
git add src/plugins/PluginManager.ts src/plugins/PluginManager.test.ts
git commit -m "feat(plugin-manager): add _removeFromEnabledPlugins helper"
```

---

### Task 2: `_cleanupObsoletePlugins` + call in `syncEnabledPlugins`

**Files:**
- Modify: `src/plugins/PluginManager.ts` — add `_cleanupObsoletePlugins`, call at top of `syncEnabledPlugins`
- Test: `src/plugins/PluginManager.test.ts` — 3 new cases in the existing `syncEnabledPlugins` describe block

**Interfaces:**
- Consumes: `_removeFromEnabledPlugins(username, id)` from Task 1
- Consumes: `unloadPlugin(id)` (existing), `this.opts.app.vault.adapter.rmdir(path, true)` (existing Obsidian API), `_subPluginsDir()` (existing)
- Produces: cleanup runs automatically at the start of every `syncEnabledPlugins` call

- [ ] **Step 1: Write the failing tests**

Add three new test cases inside the existing `describe('PluginManager.syncEnabledPlugins', ...)` block in `src/plugins/PluginManager.test.ts`:

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

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test 2>&1 | grep -E "FAIL|PASS|obsolete|cleanup|offline guard"
```

Expected: 3 new failures

- [ ] **Step 3: Implement `_cleanupObsoletePlugins`**

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
  }
}
```

- [ ] **Step 4: Call `_cleanupObsoletePlugins` at the top of `syncEnabledPlugins`**

In `syncEnabledPlugins`, add two lines right after the opening `console.log`:

```typescript
async syncEnabledPlugins(username: string): Promise<void> {
  console.log(`[PluginManager] syncEnabledPlugins start — user: ${username}`);
  const serverIds = new Set(this._availablePlugins.map(p => p.id));
  await this._cleanupObsoletePlugins(serverIds, username);
  const enabledInVault = await this._readEnabledPluginsFromVault(username);
  // ... rest unchanged
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm test 2>&1 | tail -20
```

Expected: all tests pass, no regressions

- [ ] **Step 6: Commit**

```bash
git add src/plugins/PluginManager.ts src/plugins/PluginManager.test.ts
git commit -m "feat(plugin-manager): remove obsolete sub-plugin folders on sync"
```
