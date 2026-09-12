import { describe, it, expect, vi } from 'vitest';
import { PluginManager, parseVersion, resolveUpdateOrder } from './PluginManager';
import type { PluginInfo } from '../types';

const noopLogger = { verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

function makepm() {
  const adapter = {
    exists: vi.fn().mockResolvedValue(true),
    read: vi.fn().mockResolvedValue(''),
    write: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ files: [], folders: [] }),
  };
  return new PluginManager({
    app: { vault: { adapter } } as any,
    getSettings: () => ({ devMode: false, devRepoRoot: '' } as any),
    getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', username: 'alice', isLoggedIn: true } as any),
    logger: noopLogger,
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
    const pm = new PluginManager({ app: {} as any, getSettings: () => ({ devMode: false, devRepoRoot: '' } as any), getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any), logger: noopLogger });
    pm['_availablePlugins'] = [{ id: 'games', version: '1.0.5', name: 'Games', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }];
    pm['_installedVersions'] = { 'games': '1.0.4' };
    expect(pm.hasUpdate('games')).toBe(true);
  });

  it('returns false when versions match', () => {
    const pm = new PluginManager({ app: {} as any, getSettings: () => ({ devMode: false, devRepoRoot: '' } as any), getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any), logger: noopLogger });
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

describe('PluginManager.loadPlugin', () => {
  it('loadPlugin resolves bundle via vault adapter at the expected path', async () => {
    const bundleCode = `module.exports = { default: class { async load() {} unload() {} } };`;
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(bundleCode),
    };
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: true, devRepoRoot: '/repo' } as any),
      getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
      logger: noopLogger,
    });
    pm['_availablePlugins'] = [{ id: 'music-band', version: '1.0.0', name: 'Music Band', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }] as any;

    await pm.loadPlugin('music-band');

    expect(adapter.exists).toHaveBeenCalledWith(
      expect.stringContaining('sub-plugins/music-band/main.js')
    );
    expect(adapter.read).toHaveBeenCalledWith(
      expect.stringContaining('sub-plugins/music-band/main.js')
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

  it('never touches community', async () => {
    const pm = makepm();
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue(['community']);
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

  it('does not unload community even when absent from enabledPlugins', async () => {
    const pm = makepm();
    pm['_loadedPlugins'].set('community', { unload: vi.fn() });
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);
    const unload = vi.spyOn(pm, 'unloadPlugin');
    await pm.syncEnabledPlugins('alice');
    expect(unload).not.toHaveBeenCalledWith('community');
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

  it('unloads and deletes obsolete plugin folder from disk', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn()
        .mockResolvedValueOnce({ files: [], folders: ['.obsidian/plugins/obsidian-together/sub-plugins/together-community'] })
        .mockResolvedValueOnce({ files: [], folders: [] }),
      rmdir: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false } as any),
      getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
      logger: noopLogger,
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
      list: vi.fn()
        .mockResolvedValueOnce({ files: [], folders: ['.obsidian/plugins/obsidian-together/sub-plugins/together-community'] })
        .mockResolvedValueOnce({ files: [], folders: ['.obsidian/plugins/obsidian-together/previews/together-community'] }),
      rmdir: vi.fn().mockResolvedValue(undefined),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockImplementation((_p: string, c: string) => { writtenContent = c; return Promise.resolve(); }),
    };
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false } as any),
      getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
      logger: noopLogger,
    });
    pm['_availablePlugins'] = [
      { id: 'community', version: '1.0.0', name: 'Community', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ] as any;
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);

    await pm.syncEnabledPlugins('alice');

    expect(writtenContent).not.toContain('together-community');
    expect(writtenContent).toContain('music-band');
    expect(adapter.rmdir).toHaveBeenCalledTimes(2);
    expect(adapter.rmdir).toHaveBeenCalledWith(
      '.obsidian/plugins/obsidian-together/sub-plugins/together-community',
      true
    );
    expect(adapter.rmdir).toHaveBeenCalledWith(
      '.obsidian/plugins/obsidian-together/previews/together-community',
      true
    );
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
      logger: noopLogger,
    });
    pm['_availablePlugins'] = [];
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);

    await pm.syncEnabledPlugins('alice');

    expect(adapter.rmdir).not.toHaveBeenCalled();
  });

  it('evicts stale preview in devMode even though sub-plugin cleanup is skipped', async () => {
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      list: vi.fn().mockResolvedValue({
        files: [],
        folders: ['.obsidian/plugins/obsidian-together/previews/together-community'],
      }),
      rmdir: vi.fn().mockResolvedValue(undefined),
    };
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: true } as any),
      getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
      logger: noopLogger,
    });
    pm['_availablePlugins'] = [
      { id: 'community', version: '1.0.0', name: 'Community', description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ] as any;
    pm['_readEnabledPluginsFromVault'] = vi.fn().mockResolvedValue([]);

    await pm.syncEnabledPlugins('alice');

    expect(adapter.rmdir).toHaveBeenCalledWith(
      '.obsidian/plugins/obsidian-together/previews/together-community',
      true
    );
  });
});

describe('PluginManager._migrateOldFlatFiles', () => {
  function makePmWithAdapter(adapter: any) {
    const pm = new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false, devRepoRoot: '' } as any),
      getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', username: 'alice', isLoggedIn: true } as any),
      logger: noopLogger,
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

describe('resolveUpdateOrder', () => {
  function info(id: string, requires: string[] = []): PluginInfo {
    return { id, name: id, description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {}, requires } as any;
  }

  it('returns single plugin unchanged', () => {
    const result = resolveUpdateOrder([info('community')]);
    expect(result.map(p => p.id)).toEqual(['community']);
  });

  it('places dependency before dependent', () => {
    const result = resolveUpdateOrder([
      info('music-band', ['obsidian-together', 'community']),
      info('community', ['obsidian-together']),
    ]);
    expect(result.map(p => p.id)).toEqual(['community', 'music-band']);
  });

  it('resolves three-level chain: community → music-band → behringer-console', () => {
    const result = resolveUpdateOrder([
      info('behringer-console', ['obsidian-together', 'community', 'music-band']),
      info('music-band', ['obsidian-together', 'community']),
      info('community', ['obsidian-together']),
    ]);
    expect(result.map(p => p.id)).toEqual(['community', 'music-band', 'behringer-console']);
  });

  it('ignores deps not in the update list (e.g. obsidian-together)', () => {
    const result = resolveUpdateOrder([
      info('community', ['obsidian-together']),
      info('games', ['obsidian-together', 'community']),
    ]);
    expect(result.map(p => p.id)).toEqual(['community', 'games']);
  });

  it('handles plugins with no requires', () => {
    const result = resolveUpdateOrder([info('games'), info('music-band')]);
    expect(result).toHaveLength(2);
  });
});

describe('PluginManager.checkDependencies', () => {
  it('returns empty when all deps are loaded', () => {
    const pm = makepm();
    pm['_availablePlugins'] = [
      { id: 'community', name: 'Community', requires: ['obsidian-together'], description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
      { id: 'music-band', name: 'Music Band', requires: ['obsidian-together', 'community'], description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ] as any;
    pm['_loadedPlugins'] = new Map([['community', {}]]);
    expect(pm.checkDependencies('music-band')).toHaveLength(0);
  });

  it('returns missing dep when not loaded', () => {
    const pm = makepm();
    pm['_availablePlugins'] = [
      { id: 'community', name: 'Community', requires: ['obsidian-together'], description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
      { id: 'music-band', name: 'Music Band', requires: ['obsidian-together', 'community'], description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ] as any;
    pm['_loadedPlugins'] = new Map(); // community NOT loaded
    const missing = pm.checkDependencies('music-band');
    expect(missing.map((p: any) => p.id)).toEqual(['community']);
  });

  it('ignores obsidian-together (always satisfied)', () => {
    const pm = makepm();
    pm['_availablePlugins'] = [
      { id: 'community', name: 'Community', requires: ['obsidian-together'], description: '', version: '1.0.0', checksum: '', size: 0, previewChecksum: null, previewUrls: {} },
    ] as any;
    pm['_loadedPlugins'] = new Map();
    expect(pm.checkDependencies('community')).toHaveLength(0);
  });

  it('returns empty for unknown plugin id', () => {
    const pm = makepm();
    pm['_availablePlugins'] = [];
    expect(pm.checkDependencies('nonexistent')).toHaveLength(0);
  });
});

describe('PluginManager._removeFromEnabledPlugins', () => {
  function makePmWithAdapter(adapter: any) {
    return new PluginManager({
      app: { vault: { adapter } } as any,
      getSettings: () => ({ devMode: false } as any),
      getAuth: () => ({ username: 'alice', token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
      logger: noopLogger,
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
    // Exact assertion: verify no spurious blank line before closing ---
    expect(writtenContent).toEqual('---\nenabledPlugins:\n  - music-band\n---\n\nuser content');
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
    // Exact assertion: verify enabledPlugins: [] line with no blank line before ---
    expect(writtenContent).toEqual('---\nenabledPlugins: []\n---\n\nbody');
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
    const warnSpy = vi.spyOn(noopLogger, 'warn');
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockRejectedValue(new Error('disk full')),
    };
    const pm = makePmWithAdapter(adapter);
    await expect(pm['_removeFromEnabledPlugins']('alice', 'together-community')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('preserves keys that follow enabledPlugins in frontmatter', async () => {
    const vaultContent = '---\ntitle: Alice\nenabledPlugins:\n  - together-community\n  - music-band\nrole: admin\n---\n\nbody';
    let writtenContent = '';
    const adapter = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue(vaultContent),
      write: vi.fn().mockImplementation((_p: string, c: string) => { writtenContent = c; return Promise.resolve(); }),
    };
    const pm = makePmWithAdapter(adapter);
    await pm['_removeFromEnabledPlugins']('alice', 'together-community');
    expect(writtenContent).not.toContain('together-community');
    expect(writtenContent).toContain('role: admin');
    // music-band and role must be on separate lines
    expect(writtenContent).toContain('  - music-band\n');
    expect(writtenContent).toContain('\nrole: admin');
  });
});
