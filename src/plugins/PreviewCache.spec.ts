import { mkdtempSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PreviewCache } from './PreviewCache';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'preview-cache-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mockFetch(responses: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const body = responses[url] ?? '';
    const bytes = Buffer.from(body);
    return {
      ok: true,
      status: 200,
      text: async () => body,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
}

describe('PreviewCache', () => {
  describe('isCurrent', () => {
    it('returns false when nothing is cached', () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      expect(cache.isCurrent('music-band', '0.1.5', 'abc')).toBe(false);
    });

    it('returns true when version and checksum match cached .md', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "Music Band"\n---\n',
      }));
      await cache.refresh('music-band', '0.1.5', 'abc123', { md: 'https://cdn/preview.md' });
      expect(cache.isCurrent('music-band', '0.1.5', 'abc123')).toBe(true);
    });

    it('returns false when version mismatches', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({ 'https://cdn/preview.md': '---\nname: "Music Band"\n---\n' }));
      await cache.refresh('music-band', '0.1.5', 'abc', { md: 'https://cdn/preview.md' });
      expect(cache.isCurrent('music-band', '0.1.6', 'abc')).toBe(false);
    });

    it('returns false when previewChecksum mismatches', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({ 'https://cdn/preview.md': '---\nname: "Music Band"\n---\n' }));
      await cache.refresh('music-band', '0.1.5', 'abc', { md: 'https://cdn/preview.md' });
      expect(cache.isCurrent('music-band', '0.1.5', 'different')).toBe(false);
    });

    it('returns true when both server and cache have null previewChecksum', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({ 'https://cdn/preview.md': '---\nname: "x"\n---\n' }));
      await cache.refresh('games', '1.0.0', null, { md: 'https://cdn/preview.md' });
      expect(cache.isCurrent('games', '1.0.0', null)).toBe(true);
    });
  });

  describe('refresh', () => {
    it('writes .md with injected version and previewChecksum into frontmatter', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "Music Band"\ndescription: "A plugin"\n---\n',
      }));
      await cache.refresh('music-band', '0.1.5', 'abc123', { md: 'https://cdn/preview.md' });

      const written = nodeFs.readFileSync(`${tmpDir}/music-band/music-band.md`, 'utf-8');
      expect(written).toContain('version: "0.1.5"');
      expect(written).toContain('previewChecksum: "abc123"');
      expect(written).toContain('name: "Music Band"');
    });

    it('does not write .md marker when no md URL provided', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', vi.fn());
      await cache.refresh('games', '1.0.0', null, {});

      expect(nodeFs.existsSync(`${tmpDir}/games/games.md`)).toBe(false);
    });

    it('writes binary files for jpg and coverJpg', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "x"\n---\n',
        'https://cdn/preview.jpg': 'fake-jpg-bytes',
        'https://cdn/preview.cover.jpg': 'fake-cover-bytes',
      }));
      await cache.refresh('music-band', '0.1.5', null, {
        md: 'https://cdn/preview.md',
        jpg: 'https://cdn/preview.jpg',
        coverJpg: 'https://cdn/preview.cover.jpg',
      });

      expect(nodeFs.existsSync(`${tmpDir}/music-band/music-band.jpg`)).toBe(true);
      expect(nodeFs.existsSync(`${tmpDir}/music-band/music-band.cover.jpg`)).toBe(true);
    });
  });

  describe('readMeta', () => {
    it('returns null when nothing cached', () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      expect(cache.readMeta('music-band')).toBeNull();
    });

    it('returns parsed name, description, version, previewChecksum', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "Music Band"\ndescription: "Manage your band"\n---\n',
      }));
      await cache.refresh('music-band', '0.1.5', 'abc', { md: 'https://cdn/preview.md' });
      const meta = cache.readMeta('music-band');
      expect(meta?.name).toBe('Music Band');
      expect(meta?.description).toBe('Manage your band');
      expect(meta?.version).toBe('0.1.5');
      expect(meta?.previewChecksum).toBe('abc');
    });

    it('parses authors list', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "x"\nauthors:\n  - "[[cpuget]]"\n  - "[[alice]]"\n---\n',
      }));
      await cache.refresh('plug', '1.0.0', null, { md: 'https://cdn/preview.md' });
      const meta = cache.readMeta('plug');
      expect(meta?.authors).toEqual(['[[cpuget]]', '[[alice]]']);
    });
  });

  describe('getFilePath', () => {
    it('returns null when file not in cache', () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      expect(cache.getFilePath('music-band', 'music-band.jpg')).toBeNull();
    });

    it('returns absolute path when file exists', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/preview.md': '---\nname: "x"\n---\n',
        'https://cdn/preview.jpg': 'jpg',
      }));
      await cache.refresh('music-band', '0.1.5', null, {
        md: 'https://cdn/preview.md',
        jpg: 'https://cdn/preview.jpg',
      });
      const p = cache.getFilePath('music-band', 'music-band.jpg');
      expect(p).toBe(`${tmpDir}/music-band/music-band.jpg`);
    });
  });

  describe('listCachedIds', () => {
    it('returns empty array when nothing cached', () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      expect(cache.listCachedIds()).toEqual([]);
    });

    it('returns ids of plugins with a cached .md', async () => {
      const cache = new PreviewCache(tmpDir, nodeFs);
      vi.stubGlobal('fetch', mockFetch({
        'https://cdn/md1': '---\nname: "Music Band"\n---\n',
        'https://cdn/md2': '---\nname: "Games"\n---\n',
      }));
      await cache.refresh('music-band', '0.1.5', null, { md: 'https://cdn/md1' });
      await cache.refresh('games', '0.1.0', null, { md: 'https://cdn/md2' });
      expect(cache.listCachedIds().sort()).toEqual(['games', 'music-band']);
    });
  });

  describe('mobile mode (isMobile=true)', () => {
    it('does not throw or call require fs on construction', () => {
      expect(() => new PreviewCache(null, undefined, undefined, undefined, true)).not.toThrow();
    });

    it('isCurrent returns false without a session refresh even when meta matches', () => {
      const adapter = {
        exists: vi.fn().mockResolvedValue(false),
        mkdir: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
        writeBinary: vi.fn().mockResolvedValue(undefined),
      };
      const cache = new PreviewCache(null, undefined, adapter, '.obsidian/previews', true);
      // Seed meta directly (simulates data carried over from a previous run)
      (cache as any)['_metaCache'].set('plug', { version: '1.0.0', previewChecksum: 'abc' });
      // No __refreshed sentinel → must be stale on mobile
      expect(cache.isCurrent('plug', '1.0.0', 'abc')).toBe(false);
    });

    it('isCurrent returns true after a successful refresh', async () => {
      const adapter = {
        exists: vi.fn().mockResolvedValue(false),
        mkdir: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
        writeBinary: vi.fn().mockResolvedValue(undefined),
      };
      const cache = new PreviewCache(null, undefined, adapter, '.obsidian/previews', true);
      vi.stubGlobal('fetch', mockFetch({ 'https://cdn/p.md': '---\nname: "x"\n---\n' }));
      await cache.refresh('plug', '1.0.0', 'abc', { md: 'https://cdn/p.md' });
      // After refresh the sentinel is set — isCurrent should now be true
      expect(cache.isCurrent('plug', '1.0.0', 'abc')).toBe(true);
    });

    it('listCachedIds does not crash with null fs', () => {
      const adapter = { exists: vi.fn(), mkdir: vi.fn(), write: vi.fn(), writeBinary: vi.fn() };
      const cache = new PreviewCache('/android/base/path', undefined, adapter, '.obsidian/previews', true);
      expect(() => cache.listCachedIds()).not.toThrow();
    });
  });

  describe('evict', () => {
    it('removes per-plugin folder from disk and clears in-memory caches', async () => {
      const evictTmpDir = nodeFs.mkdtempSync(join(tmpdir(), 'pc-evict-'));
      const cache = new PreviewCache(evictTmpDir, nodeFs);
      const pluginDir = join(evictTmpDir, 'together-community');
      nodeFs.mkdirSync(pluginDir);
      nodeFs.writeFileSync(join(pluginDir, 'together-community.md'), '---\nversion: "1.0.0"\npreviewChecksum: "abc"\n---\nhello');
      // Warm in-memory cache
      cache.readMeta('together-community');
      expect(cache.readBody('together-community')).toBe('hello');
      await cache.evict('together-community');
      expect(nodeFs.existsSync(pluginDir)).toBe(false);
      expect(cache.readMeta('together-community')).toBeNull();
      expect(cache.readBody('together-community')).toBeNull();
      nodeFs.rmSync(evictTmpDir, { recursive: true, force: true });
    });

    it('is a no-op when folder does not exist', async () => {
      const evictTmpDir = nodeFs.mkdtempSync(join(tmpdir(), 'pc-evict2-'));
      const cache = new PreviewCache(evictTmpDir, nodeFs);
      await expect(cache.evict('nonexistent')).resolves.toBeUndefined();
      nodeFs.rmSync(evictTmpDir, { recursive: true, force: true });
    });

    it('evicts via adapter when no basePath', async () => {
      const adapter = {
        exists: vi.fn().mockResolvedValue(true),
        rmdir: vi.fn().mockResolvedValue(undefined),
      };
      const cache = new PreviewCache(null, undefined, adapter, '.obsidian/plugins/obsidian-together/previews');
      (cache as any)['_metaCache'].set('together-community', { version: '1.0.0' });
      (cache as any)['_bodyCache'].set('together-community', 'preview body');
      await cache.evict('together-community');
      expect(adapter.rmdir).toHaveBeenCalledWith(
        '.obsidian/plugins/obsidian-together/previews/together-community',
        true
      );
      expect(cache.readMeta('together-community')).toBeNull();
      expect(cache.readBody('together-community')).toBeNull();
    });
  });
});
