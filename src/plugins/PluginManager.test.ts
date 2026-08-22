import { describe, it, expect, vi } from 'vitest';
import { PluginManager, parseVersion } from './PluginManager';

function makepm() {
  return new PluginManager({
    app: {} as any,
    getSettings: () => ({ devMode: false, devRepoRoot: '' } as any),
    getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', username: 'alice', isLoggedIn: true } as any),
  });
}

describe('parseVersion', () => {
  it('parses valid version string', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, build: 3 });
  });

  it('returns null for invalid string', () => {
    expect(parseVersion('bad')).toBeNull();
  });
});

describe('PluginManager.hasUpdate', () => {
  it('returns true when installed version differs from available', () => {
    const pm = new PluginManager({ app: {} as any, getSettings: () => ({ devMode: false, devRepoRoot: '' } as any), getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any) });
    pm['_availablePlugins'] = [{ id: 'games', version: '1.0.5', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }];
    pm['_installedVersions'] = { 'games': '1.0.4' };
    expect(pm.hasUpdate('games')).toBe(true);
  });

  it('returns false when versions match', () => {
    const pm = new PluginManager({ app: {} as any, getSettings: () => ({ devMode: false, devRepoRoot: '' } as any), getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any) });
    pm['_availablePlugins'] = [{ id: 'games', version: '1.0.5', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }];
    pm['_installedVersions'] = { 'games': '1.0.5' };
    expect(pm.hasUpdate('games')).toBe(false);
  });
});

describe('PluginManager path helpers', () => {
  it('_bundlePath uses per-plugin subfolder', () => {
    const pm = makepm();
    expect(pm['_bundlePath']('behringer-console')).toBe(
      '.obsidian/plugins/obsidian-together/sub-plugins/behringer-console/main.js'
    );
  });

  it('_versionPath uses per-plugin subfolder', () => {
    const pm = makepm();
    expect(pm['_versionPath']('games')).toBe(
      '.obsidian/plugins/obsidian-together/sub-plugins/games/main.version'
    );
  });

  it('_buildDatePath uses per-plugin subfolder', () => {
    const pm = makepm();
    expect(pm['_buildDatePath']('music-band')).toBe(
      '.obsidian/plugins/obsidian-together/sub-plugins/music-band/main.builddate'
    );
  });
});

describe('PluginManager.syncEnabledPlugins', () => {
  it('unloads a plugin that is loaded but absent from enabledPlugins', async () => {
    const pm = makepm();
    pm['_loadedPlugins'].set('music-band', { unload: vi.fn() });
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);
    const unload = vi.spyOn(pm, 'unloadPlugin');
    await pm.syncEnabledPlugins('alice');
    expect(unload).toHaveBeenCalledWith('music-band');
  });

  it('loads a plugin in enabledPlugins that is already on disk (offline)', async () => {
    const pm = makepm();
    pm.isOnline = false;
    pm['_availablePlugins'] = [{ id: 'music-band', version: '1.0.0', name: 'Music Band', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }];
    pm['_installedVersions'] = { 'music-band': '1.0.0' };
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['music-band']);
    const download = vi.spyOn(pm, 'downloadPlugin');
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    expect(download).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('music-band');
  });

  it('downloads then loads when online and version differs', async () => {
    const pm = makepm();
    pm.isOnline = true;
    const info = { id: 'games', version: '2.0.0', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} };
    pm['_availablePlugins'] = [info];
    pm['_installedVersions'] = { 'games': '1.0.0' };
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['games']);
    const download = vi.spyOn(pm, 'downloadPlugin').mockResolvedValue(undefined);
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    expect(download).toHaveBeenCalledWith(info);
    expect(load).toHaveBeenCalledWith('games');
  });

  it('never touches together-community', async () => {
    const pm = makepm();
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['together-community']);
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    expect(load).not.toHaveBeenCalled();
  });

  it('skips plugin not found in _availablePlugins', async () => {
    const pm = makepm();
    pm['_availablePlugins'] = [];
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['unknown-plugin']);
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    expect(load).not.toHaveBeenCalled();
  });

  it('does not unload together-community even when absent from enabledPlugins', async () => {
    const pm = makepm();
    pm['_loadedPlugins'].set('together-community', { unload: vi.fn() });
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);
    const unload = vi.spyOn(pm, 'unloadPlugin');
    await pm.syncEnabledPlugins('alice');
    expect(unload).not.toHaveBeenCalledWith('together-community');
  });

  it('loads without downloading when online and version already matches', async () => {
    const pm = makepm();
    pm.isOnline = true;
    const info = { id: 'games', version: '1.0.0', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} };
    pm['_availablePlugins'] = [info];
    pm['_installedVersions'] = { 'games': '1.0.0' };
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['games']);
    const download = vi.spyOn(pm, 'downloadPlugin').mockResolvedValue(undefined);
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    expect(download).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('games');
  });

  it('continues loading remaining plugins when one download fails', async () => {
    const pm = makepm();
    pm.isOnline = true;
    pm['_availablePlugins'] = [
      { id: 'games', version: '2.0.0', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
      { id: 'music-band', version: '1.0.0', name: 'Music Band', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ];
    pm['_installedVersions'] = {};
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['games', 'music-band']);
    vi.spyOn(pm, 'downloadPlugin').mockRejectedValueOnce(new Error('network error')).mockResolvedValue(undefined);
    const load = vi.spyOn(pm, 'loadPlugin').mockResolvedValue(undefined);
    await pm.syncEnabledPlugins('alice');
    // games download failed, games load skipped; music-band should still load
    expect(load).toHaveBeenCalledWith('music-band');
    expect(load).not.toHaveBeenCalledWith('games');
  });
});

describe('PluginManager._migrateOldFlatFiles', () => {
  function makePmWithAdapter(adapter: any) {
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false, devRepoRoot: '' } as any),
      getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', username: 'alice', isLoggedIn: true } as any),
    });
    return pm;
  }

  it('removes .js files from sub-plugins directory', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.js',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.js');
  });

  it('removes .version files from sub-plugins directory', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin.version',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/plugin.version');
  });

  it('removes .builddate files from sub-plugins directory', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin.builddate',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/plugin.builddate');
  });

  it('skips files that do not match .js, .version, or .builddate extensions', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/readme.txt',
          '.obsidian/plugins/obsidian-together/sub-plugins/config.json',
          '.obsidian/plugins/obsidian-together/sub-plugins/data.md',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('removes only matching files and skips others when mixed', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.js',
          '.obsidian/plugins/obsidian-together/sub-plugins/readme.txt',
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin.version',
          '.obsidian/plugins/obsidian-together/sub-plugins/config.json',
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin.builddate',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).toHaveBeenCalledTimes(3);
    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.js');
    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/plugin.version');
    expect(adapter.remove).toHaveBeenCalledWith('.obsidian/plugins/obsidian-together/sub-plugins/plugin.builddate');
  });

  it('is a no-op when directory does not exist', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(false),
      list: vi.fn(),
      remove: vi.fn(),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.list).not.toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('is a no-op when directory exists but no flat files remain', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [],
        folders: [
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin-subdir',
        ],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('handles remove errors gracefully (ignore failures)', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin.js',
        ],
        folders: [],
      }),
      remove: vi.fn().mockRejectedValue(new Error('Permission denied')),
    };
    const pm = makePmWithAdapter(adapter);

    // Should not throw, errors are silently caught
    await expect(pm['_migrateOldFlatFiles']()).resolves.toBeUndefined();
    expect(adapter.remove).toHaveBeenCalled();
  });

  it('removes all three file types in a single call', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [
          '.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.js',
          '.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.version',
          '.obsidian/plugins/obsidian-together/sub-plugins/old-plugin.builddate',
        ],
        folders: [],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    await pm['_migrateOldFlatFiles']();

    expect(adapter.remove).toHaveBeenCalledTimes(3);
  });

  it('second call with no remaining flat files is a clean no-op', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [],
        folders: [
          '.obsidian/plugins/obsidian-together/sub-plugins/plugin-new-layout',
        ],
      }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePmWithAdapter(adapter);

    // First call - no files to remove
    await pm['_migrateOldFlatFiles']();
    expect(adapter.remove).not.toHaveBeenCalled();

    // Second call - should also be a no-op with no side effects
    adapter.list.mockClear();
    adapter.remove.mockClear();
    await pm['_migrateOldFlatFiles']();

    expect(adapter.list).toHaveBeenCalled();
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
