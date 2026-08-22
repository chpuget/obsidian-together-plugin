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
