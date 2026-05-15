import { RepoChangeSet } from '../services/repositoryStateDiff';
import { RefreshScope } from './refreshScheduler';

/**
 * Map a {@link RepoChangeSet} computed from a VS Code Git API state diff onto
 * the set of {@link RefreshScope}s that need to be refreshed.
 *
 * Pure function — no side effects, no VS Code imports — to keep the policy
 * unit-testable in isolation.
 */
export function mapChangeSetToScopes(changeSet: RepoChangeSet): Set<RefreshScope> {
  const scopes = new Set<RefreshScope>();
  if (changeSet.headRefChanged) {
    scopes.add('refs');
    scopes.add('graph');
  }
  if (changeSet.headCommitChanged) {
    scopes.add('refs');
    scopes.add('graph');
    scopes.add('changes');
  }
  if (changeSet.workingTreeChanged || changeSet.indexChanged || changeSet.mergeChanged) {
    scopes.add('changes');
  }
  return scopes;
}
