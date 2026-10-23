import { describe, it, expect, vi } from 'vitest';
import { PluginManager } from './PluginManager';

const noopLogger = { verbose: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
const CP = '.obsidian/community-plugins.json';

function setup(files: Record<string, string>, available: string[]) {
  const adapter = {
    exists: vi.fn(async (p: string) => p in files),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    }),
    write: vi.fn(async (p: string, c: string) => { files[p] = c; }),
  };
  const pm = new PluginManager({
    app: { vault: { adapter } } as any,
    getSettings: () => ({ devMode: false, devRepoRoot: '' } as any),
    getAuth: () => ({ token: 'tok', serverUrl: 'http://localhost', isLoggedIn: true } as any),
    logger: noopLogger,
  });
  pm['_availablePlugins'] = available.map((id) => ({ id, version: '1.0.0', name: id, description: '', checksum: '', size: 0, previewChecksum: null, previewUrls: {} }));
  return { pm, adapter, files };
}

describe('PluginManager._cleanupGhostCommunityPluginEntries', () => {
  it('removes ghost entries (known id, no top-level manifest)', async () => {
    const { pm, files } = setup({ [CP]: JSON.stringify(['hubfolks', 'music-band', 'obsidian42-brat']) }, ['music-band']);
    await pm['_cleanupGhostCommunityPluginEntries']();
    expect(files[CP]).toBe(JSON.stringify(['hubfolks', 'obsidian42-brat'], null, 2) + '\n');
  });

  it('keeps entry when top-level manifest exists', async () => {
    const { pm, adapter } = setup({
      [CP]: JSON.stringify(['hubfolks', 'music-band']),
      '.obsidian/plugins/music-band/manifest.json': '{}',
    }, ['music-band']);
    await pm['_cleanupGhostCommunityPluginEntries']();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('never touches ids unknown to the registry', async () => {
    const { pm, adapter } = setup({ [CP]: JSON.stringify(['random-plugin']) }, ['music-band']);
    await pm['_cleanupGhostCommunityPluginEntries']();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('skips silently when file missing, invalid, or not an array', async () => {
    for (const files of [{}, { [CP]: 'not json' }, { [CP]: '{"a":1}' }, { [CP]: '' }]) {
      const { pm, adapter } = setup(files as any, ['music-band']);
      await expect(pm['_cleanupGhostCommunityPluginEntries']()).resolves.toBeUndefined();
      expect(adapter.write).not.toHaveBeenCalled();
    }
  });

  it('is idempotent', async () => {
    const { pm, adapter } = setup({ [CP]: JSON.stringify(['music-band', 'x']) }, ['music-band']);
    await pm['_cleanupGhostCommunityPluginEntries']();
    await pm['_cleanupGhostCommunityPluginEntries']();
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});
