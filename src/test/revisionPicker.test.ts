import * as assert from 'assert';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { isLikelyShaPrefix, buildRevisionPickerItems } from '../views/revisionPicker';
import type { BranchRef, TagRef } from '../types';

// The separator kind value — matches the vscode stub used in tests
const SEPARATOR_KIND = vscode.QuickPickItemKind.Separator;

// ── isLikelyShaPrefix ─────────────────────────────────────────────────────────

describe('isLikelyShaPrefix', () => {
  it('returns true for valid 4-char hex strings', () => {
    assert.strictEqual(isLikelyShaPrefix('abcd'), true);
    assert.strictEqual(isLikelyShaPrefix('0000'), true);
    assert.strictEqual(isLikelyShaPrefix('1a2b'), true);
  });

  it('returns true for a full 40-char SHA', () => {
    assert.strictEqual(isLikelyShaPrefix('a3f1e9b2c4d6e8f0a1b2c3d4e5f6a7b8c9d0e1f2'), true);
  });

  it('returns true for mid-range lengths (7, 12, 20)', () => {
    assert.strictEqual(isLikelyShaPrefix('abc1234'), true);          // 7 chars
    assert.strictEqual(isLikelyShaPrefix('0123456789ab'), true);     // 12 chars
    assert.strictEqual(isLikelyShaPrefix('0123456789abcdef0123'), true); // 20 chars
  });

  it('returns false for strings shorter than 4 chars', () => {
    assert.strictEqual(isLikelyShaPrefix(''), false);
    assert.strictEqual(isLikelyShaPrefix('a'), false);
    assert.strictEqual(isLikelyShaPrefix('ab'), false);
    assert.strictEqual(isLikelyShaPrefix('abc'), false);
  });

  it('returns false for strings longer than 40 chars', () => {
    assert.strictEqual(isLikelyShaPrefix('a3f1e9b2c4d6e8f0a1b2c3d4e5f6a7b8c9d0e1f2x'), false); // 41 chars
  });

  it('returns false for strings with uppercase hex letters', () => {
    // Spec says lowercase only: ^[0-9a-f]{4,40}$
    assert.strictEqual(isLikelyShaPrefix('ABCD'), false);
    assert.strictEqual(isLikelyShaPrefix('abcD'), false);
  });

  it('returns false for strings containing non-hex characters', () => {
    assert.strictEqual(isLikelyShaPrefix('abcg'), false);
    assert.strictEqual(isLikelyShaPrefix('abc-'), false);
    assert.strictEqual(isLikelyShaPrefix('main'), false);
    assert.strictEqual(isLikelyShaPrefix('origin/main'), false);
    assert.strictEqual(isLikelyShaPrefix('feature/foo'), false);
  });

  it('returns false for strings with whitespace', () => {
    assert.strictEqual(isLikelyShaPrefix('abc '), false);
    assert.strictEqual(isLikelyShaPrefix(' abc'), false);
    assert.strictEqual(isLikelyShaPrefix('ab cd'), false);
  });
});

// ── buildRevisionPickerItems ──────────────────────────────────────────────────

function makeBranch(overrides: Partial<BranchRef>): BranchRef {
  return {
    name: 'main',
    shortName: 'main',
    fullName: 'refs/heads/main',
    type: 'local',
    ahead: 0,
    behind: 0,
    current: false,
    ...overrides
  };
}

function makeTag(overrides: Partial<TagRef>): TagRef {
  return {
    name: 'v1.0.0',
    fullName: 'refs/tags/v1.0.0',
    ...overrides
  };
}

describe('buildRevisionPickerItems', () => {
  it('returns empty array when branches and tags are both empty', () => {
    const items = buildRevisionPickerItems([], []);
    assert.deepStrictEqual(items, []);
  });

  it('emits a Local branches separator + icon-prefixed items for local branches', () => {
    const branches: BranchRef[] = [
      makeBranch({ name: 'main', type: 'local' }),
      makeBranch({ name: 'feature/foo', shortName: 'feature/foo', fullName: 'refs/heads/feature/foo', type: 'local' })
    ];
    const items = buildRevisionPickerItems(branches, []);

    // First item is a separator with label 'Local branches'
    assert.strictEqual(items[0].label, 'Local branches');
    // Separator has kind set to vscode.QuickPickItemKind.Separator
    assert.strictEqual((items[0] as { kind?: number }).kind, SEPARATOR_KIND);

    // Then two branch items with icon prefix
    assert.strictEqual(items[1].label, '$(git-branch) main');
    assert.strictEqual(items[2].label, '$(git-branch) feature/foo');
    assert.strictEqual(items.length, 3);
  });

  it('emits a Remote branches separator + icon-prefixed items for remote branches', () => {
    const branches: BranchRef[] = [
      makeBranch({ name: 'origin/main', shortName: 'main', fullName: 'refs/remotes/origin/main', type: 'remote', remoteName: 'origin' })
    ];
    const items = buildRevisionPickerItems(branches, []);

    assert.strictEqual(items[0].label, 'Remote branches');
    assert.strictEqual((items[0] as { kind?: number }).kind, SEPARATOR_KIND);
    assert.strictEqual(items[1].label, '$(cloud) origin/main');
    assert.strictEqual(items.length, 2);
  });

  it('emits a Tags separator + icon-prefixed items for tags', () => {
    const tags: TagRef[] = [
      makeTag({ name: 'v1.0.0' }),
      makeTag({ name: 'v2.0.0', fullName: 'refs/tags/v2.0.0' })
    ];
    const items = buildRevisionPickerItems([], tags);

    assert.strictEqual(items[0].label, 'Tags');
    assert.strictEqual((items[0] as { kind?: number }).kind, SEPARATOR_KIND);
    assert.strictEqual(items[1].label, '$(tag) v1.0.0');
    assert.strictEqual(items[2].label, '$(tag) v2.0.0');
    assert.strictEqual(items.length, 3);
  });

  it('omits empty sections (no separator emitted for empty groups)', () => {
    // Only a tag, no branches
    const tags: TagRef[] = [makeTag({ name: 'v1.0.0' })];
    const items = buildRevisionPickerItems([], tags);

    // Should have exactly one separator (Tags) + one item — no Local/Remote separators
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].label, 'Tags');
    assert.strictEqual(items[1].label, '$(tag) v1.0.0');
  });

  it('emits all three sections when all groups are non-empty, in correct order', () => {
    const branches: BranchRef[] = [
      makeBranch({ name: 'main', type: 'local' }),
      makeBranch({ name: 'origin/main', shortName: 'main', fullName: 'refs/remotes/origin/main', type: 'remote', remoteName: 'origin' })
    ];
    const tags: TagRef[] = [makeTag({ name: 'v1.0.0' })];

    const items = buildRevisionPickerItems(branches, tags);

    // Collect separator labels in order — separators have kind === vscode.QuickPickItemKind.Separator
    const separatorLabels = items
      .filter((item) => (item as { kind?: number }).kind === SEPARATOR_KIND)
      .map((item) => item.label);

    assert.deepStrictEqual(separatorLabels, ['Local branches', 'Remote branches', 'Tags']);

    // Total: 3 separators + 2 branches + 1 tag = 6
    assert.strictEqual(items.length, 6);
  });

  it('marks the current branch with a "(current)" description', () => {
    const branches: BranchRef[] = [
      makeBranch({ name: 'main', type: 'local', current: true })
    ];
    const items = buildRevisionPickerItems(branches, []);

    const branchItem = items.find((item) => item.label === '$(git-branch) main');
    assert.ok(branchItem !== undefined, 'expected to find main branch item with icon prefix');
    assert.strictEqual(branchItem.description, '(current)');
  });

  it('revision field is set correctly for each kind', () => {
    const branches: BranchRef[] = [
      makeBranch({ name: 'main', type: 'local' }),
      makeBranch({ name: 'origin/main', shortName: 'main', fullName: 'refs/remotes/origin/main', type: 'remote', remoteName: 'origin' })
    ];
    const tags: TagRef[] = [makeTag({ name: 'v1.0.0' })];

    const items = buildRevisionPickerItems(branches, tags);

    const localItem = items.find((i) => i.label === '$(git-branch) main');
    assert.ok(localItem !== undefined, 'local branch item not found');
    assert.ok((localItem as { revision?: { ref?: string; kind?: string } }).revision !== undefined, 'revision payload missing');
    assert.strictEqual((localItem as { revision?: { ref?: string; kind?: string } }).revision!.ref, 'main');
    assert.strictEqual((localItem as { revision?: { ref?: string; kind?: string } }).revision!.kind, 'branch');

    const remoteItem = items.find((i) => i.label === '$(cloud) origin/main');
    assert.ok(remoteItem !== undefined, 'remote branch item not found');
    assert.strictEqual((remoteItem as { revision?: { ref?: string; kind?: string } }).revision!.ref, 'origin/main');
    assert.strictEqual((remoteItem as { revision?: { ref?: string; kind?: string } }).revision!.kind, 'remote');

    const tagItem = items.find((i) => i.label === '$(tag) v1.0.0');
    assert.ok(tagItem !== undefined, 'tag item not found');
    assert.strictEqual((tagItem as { revision?: { ref?: string; kind?: string } }).revision!.ref, 'v1.0.0');
    assert.strictEqual((tagItem as { revision?: { ref?: string; kind?: string } }).revision!.kind, 'tag');
  });
});
