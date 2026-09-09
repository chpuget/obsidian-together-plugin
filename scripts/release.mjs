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
