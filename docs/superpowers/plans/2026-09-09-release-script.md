# Release Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pnpm release [patch|minor|major]` that bumps both version files, runs tests, commits, tags, and pushes to trigger the existing GitHub release workflow.

**Architecture:** A single Node.js ESM script (`scripts/release.mjs`) does all the work: it reads `package.json` for the current version, computes the next one, writes both JSON files, runs tests, then executes the git sequence. The pure `bumpVersion` function is tested with vitest; everything else is side-effectful and verified manually.

**Tech Stack:** Node.js ESM (no extra deps), vitest for the unit test.

## Global Constraints

- No new npm/pnpm dependencies
- Script must be ESM (`.mjs`)
- Both `package.json` and `manifest.json` must stay in sync
- Default bump type: `patch`
- Tag format: `v<semver>` (e.g. `v0.1.36`)

---

### Task 1: `bumpVersion` utility + unit test

**Files:**
- Create: `scripts/release.mjs`
- Create: `scripts/release.test.mjs`
- Modify: `package.json` — add `"release"` script, add test glob

**Interfaces:**
- Produces: `bumpVersion(current: string, type: 'patch'|'minor'|'major'): string`

- [ ] **Step 1: Add test file**

Create `scripts/release.test.mjs`:

```js
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { bumpVersion } from './release.mjs';

describe('bumpVersion', () => {
  it('increments patch', () => {
    assert.equal(bumpVersion('0.1.35', 'patch'), '0.1.36');
  });
  it('increments minor and resets patch', () => {
    assert.equal(bumpVersion('0.1.35', 'minor'), '0.2.0');
  });
  it('increments major and resets minor+patch', () => {
    assert.equal(bumpVersion('0.1.35', 'major'), '1.0.0');
  });
  it('throws on unknown type', () => {
    assert.throws(() => bumpVersion('0.1.35', 'hotfix'), /Unknown bump type/);
  });
});
```

- [ ] **Step 2: Run tests — expect failure (module not found)**

```bash
cd /Users/I505237/SAPDevelop/obsidian-together-plugin
pnpm test
```

Expected: error `Cannot find module './release.mjs'` (or similar).

- [ ] **Step 3: Create `scripts/release.mjs` with the exported function only**

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function bumpVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  if (type === 'major') return `${major + 1}.0.0`;
  throw new Error(`Unknown bump type: ${type}`);
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
pnpm test
```

Expected: `bumpVersion` suite — 4 tests passing.

- [ ] **Step 5: Add `release` script to `package.json`**

In `package.json`, inside `"scripts"`, add:

```json
"release": "node scripts/release.mjs"
```

- [ ] **Step 6: Commit**

```bash
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin add scripts/release.mjs scripts/release.test.mjs package.json
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin commit -m "feat: add release script skeleton with bumpVersion"
```

---

### Task 2: Full release script — file updates + git sequence

**Files:**
- Modify: `scripts/release.mjs` — add `main()` function below the exports

**Interfaces:**
- Consumes: `bumpVersion(current, type)` from Task 1

- [ ] **Step 1: Append `main()` to `scripts/release.mjs`**

Add the following below the existing `bumpVersion` export (do **not** replace it):

```js
// ── Side-effectful release flow ───────────────────────────────────────────────

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
}

function writeJson(rel, data) {
  writeFileSync(resolve(ROOT, rel), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function run(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  const type = process.argv[2] ?? 'patch';
  if (!['patch', 'minor', 'major'].includes(type)) {
    console.error(`Usage: pnpm release [patch|minor|major]  (got: ${type})`);
    process.exit(1);
  }

  // Guard: clean working tree
  const dirty = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
  if (dirty) {
    console.error('Working tree is not clean. Commit or stash changes first.\n' + dirty);
    process.exit(1);
  }

  // Compute new version
  const pkg = readJson('package.json');
  const current = pkg.version;
  const next = bumpVersion(current, type);
  console.log(`Bumping ${type}: ${current} → ${next}`);

  // Update files
  pkg.version = next;
  writeJson('package.json', pkg);

  const manifest = readJson('manifest.json');
  manifest.version = next;
  writeJson('manifest.json', manifest);

  // Run tests — restore files on failure
  try {
    run('pnpm test');
  } catch {
    console.error('\nTests failed — restoring files.');
    pkg.version = current;
    writeJson('package.json', pkg);
    manifest.version = current;
    writeJson('manifest.json', manifest);
    process.exit(1);
  }

  // Git sequence
  run('git add package.json manifest.json');
  run(`git commit -m "chore: bump to v${next}"`);
  run(`git tag v${next}`);
  run('git push');
  run('git push --tags');

  console.log(`\nReleased v${next} — GitHub Action will build and publish the assets.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Smoke-test the guard (dirty tree)**

Make a trivial change to any file, then run:

```bash
cd /Users/I505237/SAPDevelop/obsidian-together-plugin
echo "# test" >> README.md 2>/dev/null || true
node scripts/release.mjs patch
```

Expected: `Working tree is not clean.` message, exit 1, no files changed.

```bash
git checkout -- . 2>/dev/null || true
```

- [ ] **Step 3: Smoke-test the bad-type guard**

```bash
node scripts/release.mjs hotfix
```

Expected: `Usage: pnpm release [patch|minor|major]` message, exit 1.

- [ ] **Step 4: Dry-run via `pnpm release` (confirm wiring)**

```bash
pnpm release --help 2>/dev/null || node scripts/release.mjs hotfix
```

Expected: same usage error as step 3 (confirms `package.json` script wiring works).

- [ ] **Step 5: Run unit tests to confirm nothing broken**

```bash
pnpm test
```

Expected: all tests pass (the `main()` addition has no effect on unit tests).

- [ ] **Step 6: Commit**

```bash
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin add scripts/release.mjs
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin commit -m "feat: complete release script with git flow"
```

---

### Task 3: Live release smoke test

This task does a real `pnpm release patch` and verifies the GH Action fires.

- [ ] **Step 1: Confirm current version**

```bash
node -e "const p=require('./package.json');console.log(p.version)" 2>/dev/null \
  || node -e "import('./package.json',{assert:{type:'json'}}).then(m=>console.log(m.default.version))"
```

Note the current version (e.g. `0.1.35`).

- [ ] **Step 2: Run `pnpm release patch`**

```bash
cd /Users/I505237/SAPDevelop/obsidian-together-plugin
pnpm release patch
```

Expected output:
```
Bumping patch: 0.1.35 → 0.1.36
[vitest output — all tests pass]
[master ...] chore: bump to v0.1.36
Released v0.1.36 — GitHub Action will build and publish the assets.
```

- [ ] **Step 3: Verify tag and commit exist**

```bash
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin log --oneline -3
git -C /Users/I505237/SAPDevelop/obsidian-together-plugin tag | tail -3
```

Expected: latest commit is `chore: bump to v0.1.36`, tag `v0.1.36` listed.

- [ ] **Step 4: Verify GH Action triggered**

```bash
gh run list --repo <owner>/obsidian-together-plugin --limit 3
```

Expected: a `Release` workflow run in `queued` or `in_progress` state for the new tag.
