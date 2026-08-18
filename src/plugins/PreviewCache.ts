export interface ParsedPreviewMeta {
  name?: string;
  description?: string;
  authors?: string[];
  links?: { label: string; url: string }[];
  downloads?: number;
  version?: string;
  previewChecksum?: string;
  required?: boolean;
  roadmap?: boolean;
}

export class PreviewCache {
  private readonly _fs: any;
  private readonly _available: boolean;
  private readonly _metaCache = new Map<string, ParsedPreviewMeta>();
  private readonly _bodyCache = new Map<string, string>();

  constructor(
    private readonly _basePath: string | null,
    fs?: any,
    private readonly _adapter?: any,
    private readonly _vaultBase?: string,
  ) {
    this._available = !!(_basePath || (_adapter && _vaultBase));
    this._fs = _basePath ? (fs ?? PreviewCache._requireFs()) : PreviewCache._requireFs();
  }

  private static _requireFs(): any {
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

  isCurrent(
    pluginId: string,
    serverVersion: string,
    serverPreviewChecksum: string | null,
  ): boolean {
    if (!this._available) return false;
    const meta = this._metaCache.get(pluginId) ?? this._readMetaFromFs(pluginId);
    if (!meta?.version) return false;
    return (
      meta.version === serverVersion &&
      (meta.previewChecksum ?? 'none') === (serverPreviewChecksum ?? 'none')
    );
  }

  async refresh(
    pluginId: string,
    version: string,
    previewChecksum: string | null,
    urls: { md?: string; jpg?: string; coverJpg?: string },
  ): Promise<void> {
    if (!this._available) return;

    if (this._adapter && this._vaultBase) {
      await this._refreshViaAdapter(pluginId, version, previewChecksum, urls);
    } else if (this._basePath) {
      await this._refreshViaFs(pluginId, version, previewChecksum, urls);
    }
  }

  private async _refreshViaAdapter(
    pluginId: string,
    version: string,
    previewChecksum: string | null,
    urls: { md?: string; jpg?: string; coverJpg?: string },
  ): Promise<void> {
    const adapter = this._adapter;
    const baseDir = this._vaultBase!;
    const dir = `${baseDir}/${pluginId}`;
    console.log(`[PreviewCache] refresh ${pluginId}: jpg=${!!urls.jpg} cover=${!!urls.coverJpg} md=${!!urls.md}`);

    if (!(await adapter.exists(baseDir))) await adapter.mkdir(baseDir);
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);

    if (urls.jpg) {
      const ab = await this._downloadBinary(urls.jpg);
      console.log(`[PreviewCache] jpg ${pluginId}: ${ab ? ab.byteLength + 'b' : 'FAILED'}`);
      if (ab) {
        try {
          await adapter.writeBinary(`${dir}/${pluginId}.jpg`, ab);
          console.log(`[PreviewCache] jpg ${pluginId}: written ok`);
        } catch (e) {
          console.error(`[PreviewCache] jpg ${pluginId}: write failed`, e);
        }
      }
    }
    if (urls.coverJpg) {
      const ab = await this._downloadBinary(urls.coverJpg);
      if (ab) await adapter.writeBinary(`${dir}/${pluginId}.cover.jpg`, ab);
    }
    if (urls.md) {
      const r = await fetch(urls.md);
      if (!r.ok) throw new Error(`PreviewCache: HTTP ${r.status} for ${urls.md}`);
      const mdContent = this._injectFrontmatterFields(await r.text(), version, previewChecksum);
      await adapter.write(`${dir}/${pluginId}.md`, mdContent);
      const meta = parseFrontmatter(mdContent);
      if (meta) this._metaCache.set(pluginId, meta);
      this._bodyCache.set(pluginId, mdContent.replace(/^---\n[\s\S]*?\n---\n?/, '').trim());
      console.log(`[PreviewCache] md ${pluginId}: meta=${!!meta}`);
    }
  }

  private async _refreshViaFs(
    pluginId: string,
    version: string,
    previewChecksum: string | null,
    urls: { md?: string; jpg?: string; coverJpg?: string },
  ): Promise<void> {
    const fs = this._fs;
    const dir = `${this._basePath}/${pluginId}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (urls.jpg) {
      const ab = await this._downloadBinary(urls.jpg);
      if (ab) fs.writeFileSync(`${dir}/${pluginId}.jpg`, Buffer.from(ab));
    }
    if (urls.coverJpg) {
      const ab = await this._downloadBinary(urls.coverJpg);
      if (ab) fs.writeFileSync(`${dir}/${pluginId}.cover.jpg`, Buffer.from(ab));
    }
    if (urls.md) {
      const r = await fetch(urls.md);
      if (!r.ok) throw new Error(`PreviewCache: HTTP ${r.status} for ${urls.md}`);
      const mdContent = this._injectFrontmatterFields(await r.text(), version, previewChecksum);
      fs.writeFileSync(`${dir}/${pluginId}.md`, mdContent, 'utf-8');
      const meta = parseFrontmatter(mdContent);
      if (meta) this._metaCache.set(pluginId, meta);
      this._bodyCache.set(pluginId, mdContent.replace(/^---\n[\s\S]*?\n---\n?/, '').trim());
    }
  }

  private async _downloadBinary(url: string): Promise<ArrayBuffer | null> {
    try {
      const r = await fetch(url);
      if (!r.ok) {
        console.warn(`PreviewCache: HTTP ${r.status} for ${url}`);
        return null;
      }
      return r.arrayBuffer();
    } catch (e) {
      console.warn(`PreviewCache: failed to fetch ${url}:`, e);
      return null;
    }
  }

  getFilePath(pluginId: string, filename: string): string | null {
    if (!this._available) return null;
    if (this._vaultBase) {
      const vaultPath = `${this._vaultBase}/${pluginId}/${filename}`;
      if (this._basePath && this._fs) {
        const absPath = `${this._basePath}/${pluginId}/${filename}`;
        return this._fs.existsSync(absPath) ? vaultPath : null;
      }
      return vaultPath;
    }
    const p = `${this._basePath}/${pluginId}/${filename}`;
    return this._fs.existsSync(p) ? p : null;
  }

  readMeta(pluginId: string): ParsedPreviewMeta | null {
    if (!this._available) return null;
    return this._metaCache.get(pluginId) ?? this._readMetaFromFs(pluginId);
  }

  readBody(pluginId: string): string | null {
    if (!this._available) return null;
    const cached = this._bodyCache.get(pluginId);
    if (cached !== undefined) return cached || null;
    if (this._basePath && this._fs) {
      const p = `${this._basePath}/${pluginId}/${pluginId}.md`;
      if (this._fs.existsSync(p)) {
        try {
          const body = (this._fs.readFileSync(p, 'utf-8') as string)
            .replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
          this._bodyCache.set(pluginId, body);
          return body;
        } catch { }
      }
    }
    return null;
  }

  listCachedIds(): string[] {
    if (!this._available) return [];
    const ids = new Set<string>(this._metaCache.keys());
    if (this._basePath && this._fs.existsSync(this._basePath)) {
      try {
        const entries: string[] = this._fs.readdirSync(this._basePath) ?? [];
        entries
          .filter((e: string) => this._fs.existsSync(`${this._basePath}/${e}/${e}.md`))
          .forEach((e: string) => ids.add(e));
      } catch { }
    }
    return [...ids];
  }

  private _readMetaFromFs(pluginId: string): ParsedPreviewMeta | null {
    if (!this._basePath || !this._fs) return null;
    const p = `${this._basePath}/${pluginId}/${pluginId}.md`;
    if (!this._fs.existsSync(p)) return null;
    try {
      return parseFrontmatter(this._fs.readFileSync(p, 'utf-8') as string);
    } catch {
      return null;
    }
  }

  private _injectFrontmatterFields(
    content: string,
    version: string,
    previewChecksum: string | null,
  ): string {
    const checksumVal = previewChecksum ?? 'none';
    const newFields = `version: "${version}"\npreviewChecksum: "${checksumVal}"`;

    if (content.startsWith('---\n')) {
      const closeIdx = content.indexOf('\n---', 4);
      if (closeIdx !== -1) {
        const fm = content
          .slice(4, closeIdx)
          .split('\n')
          .filter(l => !/^(version|previewChecksum):/.test(l.trim()))
          .join('\n')
          .trim();
        return `---\n${newFields}\n${fm ? fm + '\n' : ''}---${content.slice(closeIdx + 4)}`;
      }
    }
    return `---\n${newFields}\n---\n${content}`;
  }
}

function parseFrontmatter(content: string): ParsedPreviewMeta | null {
  if (!content.startsWith('---\n')) return null;
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) return null;
  const fm = content.slice(4, closeIdx);

  const str = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm'));
    return m?.[1]?.trim();
  };
  const num = (key: string): number | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'));
    return m ? Number(m[1]) : undefined;
  };

  const authorsBlock = (fm.match(/^authors:\n((?:[ \t]*-[^\n]*\n?)*)/m) ?? [])[1] ?? '';
  const authors = authorsBlock
    .split('\n')
    .map(l => l.replace(/^\s*-\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);

  const linksSection = fm.match(/^links:\s*\n((?:[ \t].*\n?)*)/m)?.[1] ?? '';
  const links: { label: string; url: string }[] = [];
  for (const m of linksSection.matchAll(/^[ \t]*-[^\n]*\n(?:[ \t]+[^\n]*\n)*/gm)) {
    const block = m[0];
    const label = block.match(/label:\s*["']?([^"'\n]+?)["']?\s*\n/)?.[1]?.trim() ?? '';
    const url = block.match(/url:\s*["']?([^"'\n]+?)["']?\s*(\n|$)/)?.[1]?.trim() ?? '';
    if (url) links.push({ label, url });
  }

  const boolVal = (key: string): boolean | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(true|false)\\s*$`, 'm'));
    return m ? m[1] === 'true' : undefined;
  };

  return {
    name: str('name'),
    description: str('description'),
    version: str('version'),
    previewChecksum: str('previewChecksum'),
    authors: authors.length ? authors : undefined,
    downloads: num('downloads'),
    links: links.length ? links : undefined,
    required: boolVal('required'),
    roadmap: boolVal('roadmap'),
  };
}
