import * as assert from 'assert';
import { describe, it } from 'node:test';
import { mapChangeSetToScopes } from '../state/gitEventRouter';
import { RepoChangeSet } from '../services/repositoryStateDiff';

const empty: RepoChangeSet = {
  headRefChanged: false,
  headCommitChanged: false,
  workingTreeChanged: false,
  indexChanged: false,
  mergeChanged: false
};

describe('mapChangeSetToScopes', () => {
  it('returns empty set for empty change set', () => {
    assert.strictEqual(mapChangeSetToScopes(empty).size, 0);
  });

  it('maps headRefChanged to refs+graph', () => {
    const out = mapChangeSetToScopes({ ...empty, headRefChanged: true });
    assert.deepStrictEqual([...out].sort(), ['graph', 'refs']);
  });

  it('maps headCommitChanged to refs+graph+changes', () => {
    const out = mapChangeSetToScopes({ ...empty, headCommitChanged: true });
    assert.deepStrictEqual([...out].sort(), ['changes', 'graph', 'refs']);
  });

  it('maps workingTreeChanged to changes only', () => {
    const out = mapChangeSetToScopes({ ...empty, workingTreeChanged: true });
    assert.deepStrictEqual([...out].sort(), ['changes']);
  });

  it('maps indexChanged to changes only', () => {
    const out = mapChangeSetToScopes({ ...empty, indexChanged: true });
    assert.deepStrictEqual([...out].sort(), ['changes']);
  });

  it('maps mergeChanged to changes only', () => {
    const out = mapChangeSetToScopes({ ...empty, mergeChanged: true });
    assert.deepStrictEqual([...out].sort(), ['changes']);
  });

  it('unions scopes across multiple flags', () => {
    const out = mapChangeSetToScopes({
      ...empty,
      headRefChanged: true,
      workingTreeChanged: true
    });
    assert.deepStrictEqual([...out].sort(), ['changes', 'graph', 'refs']);
  });
});
