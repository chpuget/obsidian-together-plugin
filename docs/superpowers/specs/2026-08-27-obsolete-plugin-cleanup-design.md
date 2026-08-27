# Obsolete Plugin Cleanup on Sync — Design

**Date:** 2026-08-27  
**Scope:** `obsidian-together-plugin` — `src/plugins/PluginManager.ts` + `src/plugins/PluginManager.test.ts`

## Problem

When a sub-plugin is renamed or removed on the server (e.g. `together-community` → `community`), its local folder remains on disk indefinitely. On the next sync the plugin manager skips it (not in `_availablePlugins`), but the folder is never cleaned up. If the old ID was also in the user's `enabledPlugins` vault field, it stays there as a dead entry.

## Solution

At the start of `syncEnabledPlugins(username)`, before the existing load/unload loop, call a new private helper `_cleanupObsoletePlugins(serverIds, username)`.

### Guards — skip cleanup when

- `settings.devMode` is true (disk = source repo, must not be deleted)
- `_availablePlugins.length === 0` (no confirmed server list — offline or not yet fetched)

Both guards checked at the top of `_cleanupObsoletePlugins` before any disk access.

### `_cleanupObsoletePlugins(serverIds: Set<string>, username: string)`

```
serverIds = new Set(_availablePlugins.map(p => p.id))

if _subPluginsDir() does not exist → return (no-op)

for each folder id in _subPluginsDir():
  if id in serverIds → skip
  1. unloadPlugin(id)                       — if loaded in memory
  2. adapter.rmdir(pluginDir, true)         — delete folder recursively
  3. delete _installedVersions[id]          — clean in-memory state
  4. _removeFromEnabledPlugins(username, id) — remove from vault file
  5. log: "[PluginManager] cleanupObsoletePlugins removed: <id>"
```

Cleanup is silent (no Obsidian `Notice`) — infrastructure maintenance, not user-facing.

### `_removeFromEnabledPlugins(username: string, id: string): Promise<void>`

1. Read `The Hub/users/<username>.md`
2. If file does not exist → return (no-op)
3. Parse frontmatter `enabledPlugins` list (same regex as `_readEnabledPluginsFromVault`)
4. If `id` not in list → return (no-op)
5. Rebuild list without `id`
6. Replace the `enabledPlugins:` block in the frontmatter string
7. Write file back

Edge cases:
- `enabledPlugins` list becomes empty after removal → write `enabledPlugins: []`
- `enabledPlugins` key absent → no-op
- File write error → log warning, do not throw (cleanup is best-effort)

## Files Changed

| File | Change |
|------|--------|
| `src/plugins/PluginManager.ts` | Add `_cleanupObsoletePlugins` + `_removeFromEnabledPlugins`; call cleanup at top of `syncEnabledPlugins` |
| `src/plugins/PluginManager.test.ts` | Add 3 new test cases (see below) |

## Tests

Three new test cases in the `syncEnabledPlugins` describe block:

1. **Obsolete plugin unloaded and deleted from disk** — `_availablePlugins = [community, music-band]`, `_loadedPlugins` contains `together-community`, folder present on disk → after sync: `unloadPlugin` called for `together-community`, `rmdir` called, `_installedVersions['together-community']` deleted.

2. **Obsolete plugin removed from enabledPlugins in vault** — same + vault file contains `together-community` in `enabledPlugins` → after sync: file rewritten without `together-community`.

3. **Offline guard** — `_availablePlugins = []` → no `rmdir`, no file modification.

No changes to existing tests.
