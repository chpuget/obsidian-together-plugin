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
