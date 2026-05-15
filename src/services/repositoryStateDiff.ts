// Pure helpers for diffing successive VS Code Git API repository.state snapshots.
// No vscode imports — must remain unit-testable in plain Node.

export interface RepositoryChangeRef {
  readonly uri: { readonly fsPath: string };
}

export interface RepositoryStateSnapshot {
  readonly HEAD?: { readonly name?: string; readonly commit?: string };
  readonly indexChanges: readonly RepositoryChangeRef[];
  readonly workingTreeChanges: readonly RepositoryChangeRef[];
  readonly mergeChanges: readonly RepositoryChangeRef[];
  readonly untrackedChanges: readonly RepositoryChangeRef[];
}

export interface ChangeListFingerprint {
  readonly length: number;
  readonly firstPath: string;
  readonly lastPath: string;
}

export interface RepositoryFingerprint {
  readonly headName: string;
  readonly headCommit: string;
  readonly index: ChangeListFingerprint;
  readonly workingTree: ChangeListFingerprint;
  readonly merge: ChangeListFingerprint;
  readonly untracked: ChangeListFingerprint;
}

export interface RepoChangeSet {
  headRefChanged: boolean;
  headCommitChanged: boolean;
  workingTreeChanged: boolean;
  indexChanged: boolean;
  mergeChanged: boolean;
}

function fingerprintChangeList(list: readonly RepositoryChangeRef[]): ChangeListFingerprint {
  if (list.length === 0) {
    return { length: 0, firstPath: '', lastPath: '' };
  }
  return {
    length: list.length,
    firstPath: list[0]?.uri.fsPath ?? '',
    lastPath: list[list.length - 1]?.uri.fsPath ?? ''
  };
}

export function buildRepositoryFingerprint(state: RepositoryStateSnapshot): RepositoryFingerprint {
  return {
    headName: state.HEAD?.name ?? '',
    headCommit: state.HEAD?.commit ?? '',
    index: fingerprintChangeList(state.indexChanges),
    workingTree: fingerprintChangeList(state.workingTreeChanges),
    merge: fingerprintChangeList(state.mergeChanges),
    untracked: fingerprintChangeList(state.untrackedChanges)
  };
}

function changeListEquals(a: ChangeListFingerprint, b: ChangeListFingerprint): boolean {
  return a.length === b.length && a.firstPath === b.firstPath && a.lastPath === b.lastPath;
}

export function diffRepositoryFingerprints(
  prev: RepositoryFingerprint,
  next: RepositoryFingerprint
): RepoChangeSet {
  const workingTreeChanged =
    !changeListEquals(prev.workingTree, next.workingTree) ||
    !changeListEquals(prev.untracked, next.untracked);
  return {
    headRefChanged: prev.headName !== next.headName,
    headCommitChanged: prev.headCommit !== next.headCommit,
    workingTreeChanged,
    indexChanged: !changeListEquals(prev.index, next.index),
    mergeChanged: !changeListEquals(prev.merge, next.merge)
  };
}

export function isEmptyChangeSet(cs: RepoChangeSet): boolean {
  return (
    !cs.headRefChanged &&
    !cs.headCommitChanged &&
    !cs.workingTreeChanged &&
    !cs.indexChanged &&
    !cs.mergeChanged
  );
}
