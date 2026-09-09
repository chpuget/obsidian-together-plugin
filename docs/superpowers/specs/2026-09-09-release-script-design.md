# Release Script Design

**Date:** 2026-09-09
**Scope:** `obsidian-together-plugin` — pnpm script to bump version and trigger GitHub release

## Context

Version bumps are currently done by hand (editing `package.json` + `manifest.json`, committing, tagging). The GitHub Action `release.yml` already handles building and publishing; it triggers on any `v*` tag push.

## Goal

A single `pnpm release [patch|minor|major]` command that:
1. Bumps the version in both version-bearing files
2. Runs the test suite as a safety gate
3. Commits, tags, and pushes — triggering the existing GH Action

## Files Changed

| File | Change |
|------|--------|
| `scripts/release.mjs` | New script (main logic) |
| `package.json` | Add `"release": "node scripts/release.mjs"` script |

## Script Flow (`scripts/release.mjs`)

```
pnpm release [patch|minor|major]   (default: patch)
```

1. **Parse argument** — accept `patch`, `minor`, `major`; exit with usage error otherwise
2. **Clean tree check** — `git status --porcelain`; abort if any uncommitted changes
3. **Read current version** — parse `package.json`
4. **Compute next version** — pure arithmetic (no semver dep):
   - `patch`: `0.1.35 → 0.1.36`
   - `minor`: `0.1.35 → 0.2.0`
   - `major`: `0.1.35 → 1.0.0`
5. **Update files** — write new version to `package.json` and `manifest.json` (preserving formatting)
6. **Run tests** — `pnpm test`; abort and restore files on failure
7. **Commit** — `git add package.json manifest.json && git commit -m "chore: bump to v<version>"`
8. **Tag** — `git tag v<version>`
9. **Push** — `git push && git push --tags` → triggers `release.yml`

## Error Handling

- Unknown bump type → print usage, exit 1 (no file changes)
- Dirty working tree → print warning, exit 1 (no file changes)
- Test failure → restore `package.json` and `manifest.json` to original, exit 1
- Git push failure → tag and commit already exist locally; user can push manually

## Non-Goals

- No changelog generation
- No dry-run mode
- No `styles.css` or other release assets (GH Action already handles `main.js` + `manifest.json`)
