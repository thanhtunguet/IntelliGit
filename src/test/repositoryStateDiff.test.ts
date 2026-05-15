import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
  buildRepositoryFingerprint,
  diffRepositoryFingerprints,
  isEmptyChangeSet,
  RepositoryStateSnapshot
} from '../services/repositoryStateDiff';

const change = (path: string): { uri: { fsPath: string } } => ({ uri: { fsPath: path } });

const snapshot = (overrides: Partial<RepositoryStateSnapshot> = {}): RepositoryStateSnapshot => ({
  HEAD: { name: 'main', commit: 'aaaa' },
  indexChanges: [],
  workingTreeChanges: [],
  mergeChanges: [],
  untrackedChanges: [],
  ...overrides
});

describe('repositoryStateDiff', () => {
  it('detects empty diff when fingerprints match', () => {
    const fp = buildRepositoryFingerprint(snapshot());
    const cs = diffRepositoryFingerprints(fp, fp);
    assert.strictEqual(isEmptyChangeSet(cs), true);
  });

  it('flags headRefChanged on branch switch', () => {
    const prev = buildRepositoryFingerprint(snapshot({ HEAD: { name: 'main', commit: 'aaaa' } }));
    const next = buildRepositoryFingerprint(snapshot({ HEAD: { name: 'feature', commit: 'aaaa' } }));
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.headRefChanged, true);
    assert.strictEqual(cs.headCommitChanged, false);
  });

  it('flags headCommitChanged on new commit', () => {
    const prev = buildRepositoryFingerprint(snapshot({ HEAD: { name: 'main', commit: 'aaaa' } }));
    const next = buildRepositoryFingerprint(snapshot({ HEAD: { name: 'main', commit: 'bbbb' } }));
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.headRefChanged, false);
    assert.strictEqual(cs.headCommitChanged, true);
  });

  it('flags workingTreeChanged on path list mutation', () => {
    const prev = buildRepositoryFingerprint(snapshot({ workingTreeChanges: [change('a.txt')] }));
    const next = buildRepositoryFingerprint(
      snapshot({ workingTreeChanges: [change('a.txt'), change('b.txt')] })
    );
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.workingTreeChanged, true);
    assert.strictEqual(cs.indexChanged, false);
  });

  it('treats untracked changes as part of working tree flag', () => {
    const prev = buildRepositoryFingerprint(snapshot({ untrackedChanges: [] }));
    const next = buildRepositoryFingerprint(snapshot({ untrackedChanges: [change('new.txt')] }));
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.workingTreeChanged, true);
  });

  it('flags mergeChanged independently', () => {
    const prev = buildRepositoryFingerprint(snapshot({ mergeChanges: [] }));
    const next = buildRepositoryFingerprint(snapshot({ mergeChanges: [change('conflict.txt')] }));
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.mergeChanged, true);
    assert.strictEqual(cs.workingTreeChanged, false);
  });

  it('flags indexChanged when staged paths differ', () => {
    const prev = buildRepositoryFingerprint(snapshot({ indexChanges: [change('a.txt')] }));
    const next = buildRepositoryFingerprint(snapshot({ indexChanges: [change('b.txt')] }));
    const cs = diffRepositoryFingerprints(prev, next);
    assert.strictEqual(cs.indexChanged, true);
  });
});
