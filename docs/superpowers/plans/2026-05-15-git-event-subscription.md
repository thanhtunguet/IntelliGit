# Git Event Subscription & Serialised Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension auto-refresh correctly on git events (CLI checkouts, stashes, worktree/submodule mutations, merge/rebase) without re-introducing broad `.git/**` file-watching, while preserving the existing one-refresh-at-a-time guarantee from `RefreshScheduler`.

**Architecture:** Enrich `GitService.onDidChangeRepositoryState` to diff successive `repository.state` snapshots and emit a typed `RepoChangeSet`. Rewire `StateStore.attachAutoRefresh` so three signal sources — the enriched git API event, narrow per-scope file watchers in `.git/`, and existing view-visibility transitions — all route through `requestRefresh`. Also attach to `vscode.git` API's `onDidOpenRepository`/`onDidCloseRepository` so late-opening repos still receive the listener.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.git` extension API v1, `FileSystemWatcher`, `RelativePattern`), `node:test`, existing `RefreshScheduler`.

**Reference spec:** `docs/superpowers/specs/2026-05-15-git-event-subscription-design.md`.

---

## File Structure

| Path                                                            | Responsibility |
| --------------------------------------------------------------- | -------------- |
| `src/services/repositoryStateDiff.ts` *(new)*                   | Pure functions: build state fingerprint from `VsCodeGitRepository.state`, compute `RepoChangeSet` between two fingerprints. No VS Code imports. |
| `src/services/gitService.ts`                                    | Extend `VsCodeGitApi` interface; replace `onDidChangeRepositoryState` with diff-aware `onRepositoryStateChange`; expose `onRepositoryAvailable` (handles immediate + late `onDidOpenRepository`) and `onRepositoryClosed`; expose public `getGitDir()` accessor for watcher setup. |
| `src/state/gitEventRouter.ts` *(new)*                           | Pure function: map `RepoChangeSet` → `RefreshScope[]`. No imports beyond `RefreshScope` type. |
| `src/state/stateStore.ts`                                       | Rewrite `attachAutoRefresh` to wire three signal sources (enriched API event, narrow file watchers, visibility — already exists) through `requestRefresh`. |
| `src/test/repositoryStateDiff.test.ts` *(new)*                  | Unit-test fingerprint construction + diff (no VS Code). |
| `src/test/gitEventRouter.test.ts` *(new)*                       | Unit-test change-set → scope mapping. |
| `src/test/refreshScheduler.test.ts`                             | Add interleave-during-in-flight regression test. |
| `CHANGELOG.md`                                                  | One line under `[Unreleased] / Changed`. |

---

## Task 0: Add fingerprint + diff helper (`repositoryStateDiff.ts`)

**Goal:** Pure, dependency-free module that converts a `VsCodeGitRepository.state` shape into a comparable fingerprint and computes a `RepoChangeSet` between two fingerprints. Lets us unit-test the diff logic without touching VS Code.

**Files:**
- Create: `src/services/repositoryStateDiff.ts`
- Test: `src/test/repositoryStateDiff.test.ts`

**Acceptance Criteria:**
- [ ] `RepoChangeSet` type exported with five boolean flags: `headRefChanged`, `headCommitChanged`, `workingTreeChanged`, `indexChanged`, `mergeChanged`.
- [ ] `buildRepositoryFingerprint(state)` returns a stable object capturing HEAD name/commit and `(length, firstPath, lastPath)` per change list.
- [ ] `diffRepositoryFingerprints(prev, next)` returns a `RepoChangeSet`; all flags false when fingerprints equal; correct flags set when each component changes.
- [ ] `isEmptyChangeSet(changeSet)` returns true iff all flags are false.
- [ ] No `vscode` import.

**Verify:** `npm test -- --test-name-pattern repositoryStateDiff` → 6+ passing assertions.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

Create `src/test/repositoryStateDiff.test.ts`:

```typescript
import * as assert from 'assert';
import { describe, it } from 'node:test';
import {
  buildRepositoryFingerprint,
  diffRepositoryFingerprints,
  isEmptyChangeSet,
  RepositoryStateSnapshot
} from '../services/repositoryStateDiff';

const change = (path: string) => ({ uri: { fsPath: path } as { fsPath: string } });

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
    const next = buildRepositoryFingerprint(snapshot({ workingTreeChanges: [change('a.txt'), change('b.txt')] }));
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
```

- [ ] **Step 2: Run tests, see them fail.**

Run: `npm test`
Expected: failures referencing missing module `../services/repositoryStateDiff`.

- [ ] **Step 3: Implement the module.**

Create `src/services/repositoryStateDiff.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests, see them pass.**

Run: `npm test`
Expected: all `repositoryStateDiff` tests pass; pre-existing tests still pass.

- [ ] **Step 5: Commit.**

```bash
git add src/services/repositoryStateDiff.ts src/test/repositoryStateDiff.test.ts
git commit -m "feat(state): add repository state fingerprint and diff helper

Pure, vscode-free module that lets us detect what actually changed in a
VS Code Git API state event so we can refresh only the affected scopes."
```

---

## Task 1: Add change-set → refresh-scope router (`gitEventRouter.ts`)

**Goal:** Pure function that turns a `RepoChangeSet` into a `Set<RefreshScope>`. Lets us unit-test the policy without touching `StateStore`.

**Files:**
- Create: `src/state/gitEventRouter.ts`
- Test: `src/test/gitEventRouter.test.ts`

**Acceptance Criteria:**
- [ ] `mapChangeSetToScopes(changeSet)` returns `Set<RefreshScope>` per the table below.
- [ ] Empty change set → empty set.
- [ ] Multiple flags union correctly.
- [ ] No `vscode` import.

Mapping table:

| Flag                   | Scopes added           |
| ---------------------- | ---------------------- |
| `headRefChanged`       | `refs`, `graph`        |
| `headCommitChanged`    | `refs`, `graph`, `changes` |
| `workingTreeChanged`   | `changes`              |
| `indexChanged`         | `changes`              |
| `mergeChanged`         | `changes`              |

**Verify:** `npm test -- --test-name-pattern gitEventRouter` → 5+ passing assertions.

**Steps:**

- [ ] **Step 1: Write the failing tests.**

Create `src/test/gitEventRouter.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests, see them fail.**

Run: `npm test`
Expected: failures referencing missing module `../state/gitEventRouter`.

- [ ] **Step 3: Implement the router.**

Create `src/state/gitEventRouter.ts`:

```typescript
import { RepoChangeSet } from '../services/repositoryStateDiff';
import { RefreshScope } from './refreshScheduler';

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
```

- [ ] **Step 4: Run tests, see them pass.**

Run: `npm test`
Expected: all `gitEventRouter` tests pass.

- [ ] **Step 5: Commit.**

```bash
git add src/state/gitEventRouter.ts src/test/gitEventRouter.test.ts
git commit -m "feat(state): add change-set to refresh-scope router

Maps the typed RepoChangeSet onto the RefreshScope set so a single state
event refreshes exactly the views VS Code told us are affected."
```

---

## Task 2: Strengthen `RefreshScheduler` regression test

**Goal:** Lock in the "one refresh at a time, coalesce overlapping requests" invariant the design depends on. Add a test that fires three interleaved requests during an in-flight refresh and asserts the scheduler invokes `runRefresh` the expected number of times with the expected unioned scopes.

**Files:**
- Modify: `src/test/refreshScheduler.test.ts`

**Acceptance Criteria:**
- [ ] New test "coalesces multiple requests arriving during in-flight refresh into a single follow-up batch" passes.
- [ ] Pre-existing tests still pass.

**Verify:** `npm test -- --test-name-pattern RefreshScheduler` → 4 tests, all passing.

**Steps:**

- [ ] **Step 1: Add the new test at the end of the `describe` block.**

Append to `src/test/refreshScheduler.test.ts` inside the `describe('RefreshScheduler', ...)`:

```typescript
  it('coalesces multiple requests arriving during in-flight refresh into a single follow-up batch', async () => {
    const batches: RefreshScope[][] = [];
    let active = 0;
    let maxActive = 0;
    let firedExtraRequests = false;

    const scheduler = new RefreshScheduler(async (scopes) => {
      batches.push([...scopes].sort());
      active += 1;
      maxActive = Math.max(maxActive, active);

      if (!firedExtraRequests) {
        firedExtraRequests = true;
        // Fire three interleaved requests while the first refresh is still running.
        void scheduler.request(['refs']);
        void scheduler.request(['changes']);
        void scheduler.request(['stashes']);
      }

      await delay(15);
      active -= 1;
    });

    await scheduler.request(['changes']);
    await delay(60);

    assert.strictEqual(maxActive, 1, 'never overlap');
    assert.strictEqual(batches.length, 2, 'one in-flight batch, one coalesced follow-up');
    assert.deepStrictEqual(batches[0], ['changes']);
    assert.deepStrictEqual(batches[1], ['changes', 'refs', 'stashes']);
  });
```

- [ ] **Step 2: Run tests.**

Run: `npm test -- --test-name-pattern RefreshScheduler`
Expected: 4 RefreshScheduler tests pass.

- [ ] **Step 3: Commit.**

```bash
git add src/test/refreshScheduler.test.ts
git commit -m "test(state): lock in scheduler serialisation invariant

Asserts that multiple requests arriving during an in-flight refresh
collapse into a single follow-up batch with unioned scopes."
```

---

## Task 3: Enrich `GitService` git-API subscription

**Goal:** Replace `onDidChangeRepositoryState(listener)` with `onRepositoryStateChange(listener)` that delivers a `RepoChangeSet`, swallow no-op events, expose repo-open/close events, and a public `getGitDir()` accessor.

**Files:**
- Modify: `src/services/gitService.ts`

**Acceptance Criteria:**
- [ ] `VsCodeGitApi` interface extended with `onDidOpenRepository?: vscode.Event<VsCodeGitRepository>` and `onDidCloseRepository?: vscode.Event<VsCodeGitRepository>` (optional — the API exposes them; we mark optional defensively).
- [ ] New method `onRepositoryStateChange(listener: (cs: RepoChangeSet) => void): Promise<vscode.Disposable | undefined>` — attaches to current repo's `state.onDidChange`, computes fingerprint diff, calls listener only when change set is non-empty.
- [ ] New method `onRepositoryAvailable(listener: () => void): Promise<vscode.Disposable | undefined>` — fires immediately if our repo is already open, then forwards future `onDidOpenRepository` events matching our `gitRoot`.
- [ ] New method `onRepositoryClosed(listener: () => void): Promise<vscode.Disposable | undefined>` — forwards `onDidCloseRepository` events matching our `gitRoot`; resets internal `_vscodeGitRepository` cache.
- [ ] New public method `getGitDir(): Promise<string | undefined>` (rename from private; keep behaviour). All existing callers using the private method continue to work.
- [ ] Old `onDidChangeRepositoryState` removed (one caller — `StateStore.attachAutoRefresh` — will be rewired in Task 4).

**Verify:**
- `npm run check-types` → no errors.
- `npm test` → all existing tests still pass.

**Steps:**

- [ ] **Step 1: Extend the `VsCodeGitApi` interface.**

In `src/services/gitService.ts`, locate the `VsCodeGitApi` interface (around line 72) and add two optional events:

```typescript
interface VsCodeGitApi {
  readonly repositories: readonly VsCodeGitRepository[];
  getRepository(uri: vscode.Uri): VsCodeGitRepository | null;
  getRepositoryRoot(uri: vscode.Uri): Promise<vscode.Uri | null>;
  openRepository(root: vscode.Uri): Promise<VsCodeGitRepository | null>;
  readonly onDidOpenRepository?: vscode.Event<VsCodeGitRepository>;
  readonly onDidCloseRepository?: vscode.Event<VsCodeGitRepository>;
}
```

- [ ] **Step 2: Import the diff helper.**

Add near the top of `src/services/gitService.ts`:

```typescript
import {
  buildRepositoryFingerprint,
  diffRepositoryFingerprints,
  isEmptyChangeSet,
  RepoChangeSet,
  RepositoryFingerprint
} from './repositoryStateDiff';
```

Re-export the type so consumers can import it without reaching across modules:

```typescript
export type { RepoChangeSet } from './repositoryStateDiff';
```

- [ ] **Step 3: Make `getGitDir` public.**

Find the private `getGitDir` method (around line 699). Remove the `private` modifier so it becomes a public method (`async getGitDir(): Promise<string | undefined>`).

- [ ] **Step 4: Replace `onDidChangeRepositoryState`.**

Locate the existing `onDidChangeRepositoryState` method (around line 640). Replace its body and signature with the new `onRepositoryStateChange`:

```typescript
async onRepositoryStateChange(
  listener: (changeSet: RepoChangeSet) => void
): Promise<vscode.Disposable | undefined> {
  const repository = await this.getVsCodeRepository();
  if (!repository?.state.onDidChange) {
    return undefined;
  }
  let last: RepositoryFingerprint = buildRepositoryFingerprint(repository.state);
  return repository.state.onDidChange(() => {
    const next = buildRepositoryFingerprint(repository.state);
    const changeSet = diffRepositoryFingerprints(last, next);
    last = next;
    if (isEmptyChangeSet(changeSet)) {
      return;
    }
    listener(changeSet);
  });
}
```

- [ ] **Step 5: Add `onRepositoryAvailable` and `onRepositoryClosed`.**

Insert immediately after `onRepositoryStateChange`:

```typescript
async onRepositoryAvailable(listener: () => void): Promise<vscode.Disposable | undefined> {
  const api = await this.getVsCodeGitApi();
  if (!api) {
    return undefined;
  }

  // If our repo is already open, fire once now.
  const current = await this.getVsCodeRepository();
  if (current) {
    listener();
  }

  if (!api.onDidOpenRepository) {
    return undefined;
  }
  return api.onDidOpenRepository((repo) => {
    if (this.samePath(repo.rootUri.fsPath, this.gitRoot)) {
      this._vscodeGitRepository = repo;
      listener();
    }
  });
}

async onRepositoryClosed(listener: () => void): Promise<vscode.Disposable | undefined> {
  const api = await this.getVsCodeGitApi();
  if (!api?.onDidCloseRepository) {
    return undefined;
  }
  return api.onDidCloseRepository((repo) => {
    if (this.samePath(repo.rootUri.fsPath, this.gitRoot)) {
      this._vscodeGitRepository = undefined;
      listener();
    }
  });
}
```

- [ ] **Step 6: Type-check.**

Run: `npm run check-types`
Expected: no errors. (At this point `StateStore.attachAutoRefresh` still references the old method name — fix in Task 4. To unblock check-types between tasks, the simplest path is to do Task 3 + Task 4 changes in one branch and commit together. Document this in the commit below.)

> **Implementer note:** because removing `onDidChangeRepositoryState` will break `stateStore.ts` compilation, perform Task 3 and Task 4 edits together in the same working tree, then run `npm run check-types` once after both before committing. Commit as Task 3+4 combined: `feat(refresh): switch to diff-aware repository state subscription`. Adjust the commit message in Step 7 below if combining.

- [ ] **Step 7: (deferred — combined commit at end of Task 4)**

Do NOT commit Task 3 in isolation if Task 4 has not been applied; the build will not type-check.

---

## Task 4: Rewire `StateStore.attachAutoRefresh`

**Goal:** Replace the current single-line subscription with a wiring that (a) uses the new diff-aware API event mapped through `gitEventRouter`, (b) attaches narrow file watchers for stashes/worktrees/submodules/operation-state, (c) re-attaches when the repo opens late, (d) routes everything through `requestRefresh`.

**Files:**
- Modify: `src/state/stateStore.ts`

**Acceptance Criteria:**
- [ ] `attachAutoRefresh` registers exactly one git-API state listener that, when fired, calls `requestRefresh(scopes, { delayMs })` with scopes derived from `mapChangeSetToScopes`.
- [ ] Five narrow file watchers (stashes / worktrees / submodules-modules / .gitmodules / operation-state) are created if `getGitDir()` resolves. Each routes its event through `requestRefresh` with `delayMs: 250`.
- [ ] If `getGitDir()` does not resolve at initial attach, watcher setup is retried inside `onRepositoryAvailable`.
- [ ] Subscription is re-attached when `onRepositoryAvailable` fires for the matching root.
- [ ] All disposables are pushed onto `context.subscriptions`.
- [ ] No new `vscode.workspace.createFileSystemWatcher` call uses a broad `.git/**` pattern.

**Verify:**
- `npm run check-types` → no errors.
- `npm test` → all tests pass.
- Manual smoke test (after build): `git checkout` from terminal → Branches and Graph views refresh within ~500 ms.

**Steps:**

- [ ] **Step 1: Update imports in `src/state/stateStore.ts`.**

Add these imports at the top of the file:

```typescript
import { RepoChangeSet } from '../services/repositoryStateDiff';
import { mapChangeSetToScopes } from './gitEventRouter';
```

- [ ] **Step 2: Rewrite `attachAutoRefresh`.**

Locate the existing method (around lines 278–288). Replace with:

```typescript
attachAutoRefresh(context: vscode.ExtensionContext): void {
  const watchersRegistered = { value: false };

  const handleStateChange = (changeSet: RepoChangeSet): void => {
    const scopes = mapChangeSetToScopes(changeSet);
    if (scopes.size === 0) {
      return;
    }
    void this.requestRefresh(scopes, { delayMs: this.getRefreshDebounceMs() });
  };

  const attachStateListener = async (): Promise<void> => {
    const disposable = await this.git.onRepositoryStateChange(handleStateChange);
    if (disposable) {
      context.subscriptions.push(disposable);
    }
  };

  const attachFileWatchers = async (): Promise<void> => {
    if (watchersRegistered.value) {
      return;
    }
    const gitDir = await this.git.getGitDir();
    if (!gitDir) {
      this.logger.warn('VS Code Git Client: .git directory could not be resolved; ' +
        'stashes/worktrees/submodules will refresh only on view focus.');
      return;
    }
    watchersRegistered.value = true;

    const gitDirUri = vscode.Uri.file(gitDir);
    const workspaceUri = vscode.Uri.file(this.git.rootPath);

    const watch = (
      base: vscode.Uri,
      pattern: string,
      scopes: RefreshScope[]
    ): vscode.FileSystemWatcher => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(base, pattern)
      );
      const handler = (): void => {
        void this.requestRefresh(scopes, { delayMs: 250 });
      };
      watcher.onDidCreate(handler);
      watcher.onDidChange(handler);
      watcher.onDidDelete(handler);
      return watcher;
    };

    context.subscriptions.push(
      watch(gitDirUri, 'refs/stash', ['stashes']),
      watch(gitDirUri, 'logs/refs/stash', ['stashes']),
      watch(gitDirUri, 'worktrees/**', ['worktrees']),
      watch(gitDirUri, 'modules/**', ['submodules']),
      watch(workspaceUri, '.gitmodules', ['submodules']),
      watch(gitDirUri, '{MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD}', ['changes']),
      watch(gitDirUri, 'rebase-merge/**', ['changes']),
      watch(gitDirUri, 'rebase-apply/**', ['changes'])
    );
  };

  // Attach immediately if the repo is already open; re-attach on late open.
  void this.git.onRepositoryAvailable(() => {
    void attachStateListener();
    void attachFileWatchers();
  }).then((disposable) => {
    if (disposable) {
      context.subscriptions.push(disposable);
    }
  });

  // Reset the registration flag on close so a re-open reinstalls listeners.
  void this.git.onRepositoryClosed(() => {
    watchersRegistered.value = false;
  }).then((disposable) => {
    if (disposable) {
      context.subscriptions.push(disposable);
    }
  });
}
```

> Note: `RefreshScope` is already imported at top of the file (line 6). If not, ensure `import { RefreshScheduler, RefreshScope } from './refreshScheduler';` is present.

- [ ] **Step 3: Type-check (combined with Task 3 changes).**

Run: `npm run check-types`
Expected: no errors.

- [ ] **Step 4: Run all tests.**

Run: `npm test`
Expected: every test in `src/test/` passes, including new fingerprint, router, and scheduler tests.

- [ ] **Step 5: Lint.**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit Tasks 3 + 4 together.**

```bash
git add src/services/gitService.ts src/state/stateStore.ts
git commit -m "feat(refresh): subscribe to git events with scope-aware diffing

Replace the single-scope onDidChangeRepositoryState subscription with a
diff-aware onRepositoryStateChange that emits a RepoChangeSet. Map the
change set onto the affected RefreshScopes (refs/graph/changes) instead
of always requesting only changes. Add narrow .git/ file watchers for
stashes, worktrees, submodules, .gitmodules, and operation-state files
so CLI mutations of those objects refresh their views. Re-attach on
late onDidOpenRepository so the subscription is not lost if vscode.git
activates after our extension.

All signal sources route through requestRefresh, so the existing
RefreshScheduler one-at-a-time guarantee is preserved.

Refs: docs/superpowers/specs/2026-05-15-git-event-subscription-design.md"
```

---

## Task 5: Manual verification + changelog

**Goal:** Smoke-test the end-to-end behaviour in a real VS Code session, and document the change in the changelog.

**Files:**
- Modify: `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] Run the extension in the Extension Development Host (F5) against this repository.
- [ ] Verify the seven manual scenarios below.
- [ ] Add a `CHANGELOG.md` entry under `[Unreleased] / Changed`.

**Manual scenarios (record pass/fail in commit message body):**

1. From terminal: `git checkout -b plan-test-branch && git checkout -` — Branches view shows both branches and updates the current-branch marker without manual refresh.
2. From terminal: `echo x >> README.md` — Changes view shows the modified file within ~500 ms.
3. From terminal: `git stash` (after step 2) — Stashes view shows new stash; Changes view clears.
4. From terminal: `git stash pop` — reverses scenario 3.
5. From terminal: `git worktree add ../plan-wt HEAD` then `git worktree remove ../plan-wt` — Worktrees view adds and removes the entry.
6. From terminal: in a repo with submodules, `git submodule update --init` (or touch `.gitmodules`) — Submodules view refreshes.
7. Start an interactive rebase (`git rebase -i HEAD~2`) and immediately abort (`git rebase --abort`) — Changes view operation-state indicator appears and disappears.

If `vscode.git` is the only available API and any of 3/5/6/7 fail, the corresponding file watcher is misconfigured — debug before merging.

**Steps:**

- [ ] **Step 1: Build the extension.**

Run: `npm run bundle`
Expected: produces `dist/extension.js` without errors.

- [ ] **Step 2: Launch Extension Development Host.**

In VS Code, press F5 to launch the extension in a new window with this repository or a test repository open. Open a terminal in that window and run each of the seven scenarios above. Tick them off as they pass.

- [ ] **Step 3: Update `CHANGELOG.md`.**

Under `## [Unreleased]` → `### Changed`, add (preserving existing entries):

```markdown
- **Auto-refresh on external git changes** — Branches, Graph, Stashes, Worktrees, Submodules, and the working-tree change list now refresh automatically when git state changes outside the extension (terminal checkouts, stashes, worktree mutations, submodule init/update, rebase/merge/cherry-pick start/abort). Refreshes are scoped to what actually changed and remain serialised through the existing refresh scheduler — no broad `.git/**` watcher was reintroduced.
```

- [ ] **Step 4: Commit.**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for scoped auto-refresh on external git changes

Manual scenarios verified:
- branch checkout via CLI refreshes Branches + Graph
- working tree mutation refreshes Changes
- stash create/pop refreshes Stashes + Changes
- worktree add/remove refreshes Worktrees
- submodule init / .gitmodules touch refreshes Submodules
- rebase start/abort refreshes operation state in Changes"
```

---

## Self-Review

**Spec coverage:**

| Spec goal                                                                 | Task |
| ------------------------------------------------------------------------- | ---- |
| Refresh specific scopes that VS Code reports changed                       | Task 0, 1, 4 |
| Cover stashes/worktrees/submodules/operation-state via narrow watchers     | Task 4 |
| Recover from late-opened repo                                              | Task 3, 4 |
| Route every signal through `requestRefresh`                                | Task 4 (scheduler unchanged) |
| Skip empty diffs                                                           | Task 0, 3 |

**Non-goals confirmed absent:** no multi-repo code, no window-focus listener, no scheduler rewrite.

**Placeholder scan:** All code blocks contain the exact code to type. No "TODO", "TBD", "appropriate error handling", or "similar to Task N" references.

**Type consistency:**
- `RepoChangeSet` defined in Task 0, re-exported from `gitService.ts` in Task 3 Step 2, consumed in Task 1 (router test) and Task 4 (StateStore wiring).
- `mapChangeSetToScopes` defined Task 1, consumed Task 4.
- `getGitDir()` made public in Task 3 Step 3, called in Task 4 Step 2 via `this.git.getGitDir()`.
- `onRepositoryStateChange`, `onRepositoryAvailable`, `onRepositoryClosed` defined Task 3 Steps 4–5, called Task 4 Step 2.

**Combined commit caveat (Tasks 3 + 4):** Removing the old `onDidChangeRepositoryState` breaks the type-check of `stateStore.ts` until Task 4 is applied. Step 6 of Task 3 explicitly states this and instructs the implementer to commit both tasks together. This is the only intentional cross-task dependency.

---

## Execution
