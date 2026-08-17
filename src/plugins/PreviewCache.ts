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

  constructor(
    private readonly _basePath: string | null,
    fs?: any,
  ) {
    this._available = !!_basePath;
    this._fs = this._available ? (fs ?? PreviewCache._requireFs()) : null;
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
    const meta = this.readMeta(pluginId);
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
    const fs = this._fs;
    const dir = `${this._basePath}/${pluginId}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const download = async (url: string): Promise<Buffer | null> => {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          console.warn(`PreviewCache: HTTP ${r.status} for ${url}`);
          return null;
        }
        const ab = await r.arrayBuffer();
        return typeof Buffer !== 'undefined'
          ? Buffer.from(ab)
          : (new Uint8Array(ab) as any);
      } catch (e) {
        console.warn(`PreviewCache: failed to fetch ${url}:`, e);
        return null;
      }
    };

    if (urls.jpg) {
      const buf = await download(urls.jpg);
      if (buf) fs.writeFileSync(`${dir}/${pluginId}.jpg`, buf);
    }
    if (urls.coverJpg) {
      const buf = await download(urls.coverJpg);
      if (buf) fs.writeFileSync(`${dir}/${pluginId}.cover.jpg`, buf);
    }

    if (urls.md) {
      const r = await fetch(urls.md);
      if (!r.ok) throw new Error(`PreviewCache: HTTP ${r.status} for ${urls.md}`);
      const mdText = await r.text();
      const mdContent = this._injectFrontmatterFields(mdText, version, previewChecksum);
      fs.writeFileSync(`${dir}/${pluginId}.md`, mdContent, 'utf-8');
    }
  }

  getFilePath(pluginId: string, filename: string): string | null {
    if (!this._available) return null;
    const p = `${this._basePath}/${pluginId}/${filename}`;
    return this._fs.existsSync(p) ? p : null;
  }

  readMeta(pluginId: string): ParsedPreviewMeta | null {
    if (!this._available) return null;
    const p = `${this._basePath}/${pluginId}/${pluginId}.md`;
    if (!this._fs.existsSync(p)) return null;
    try {
      return parseFrontmatter(this._fs.readFileSync(p, 'utf-8') as string);
    } catch {
      return null;
    }
  }

  listCachedIds(): string[] {
    if (!this._available) return [];
    if (!this._fs.existsSync(this._basePath)) return [];
    try {
      const entries: string[] = this._fs.readdirSync(this._basePath) ?? [];
      return entries.filter((e: string) =>
        this._fs.existsSync(`${this._basePath}/${e}/${e}.md`),
      );
    } catch {
      return [];
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
