# Git Event Subscription & Serialised Refresh

**Date:** 2026-05-15
**Status:** Design — pending implementation
**Scope:** `src/services/gitService.ts`, `src/state/stateStore.ts`, tests

## Problem

After v0.15.4 reduced refresh frequency to fix Windows lag, the extension can fall out of sync with the repository:

- Checking out a branch from the terminal does not refresh the branches/graph/refs views.
- Sometimes the view container is focused but the displayed state is stale.

Root cause: `StateStore.attachAutoRefresh` subscribes to `git.onDidChangeRepositoryState` but unconditionally requests only `['changes']`. HEAD moves, ref creations, stash/worktree/submodule mutations, and operation-state file changes do not trigger their corresponding view refreshes. If the VS Code Git extension activates after our `activate()`, the subscription is silently dropped.

There is also a soft requirement: when multiple events arrive in a burst (CLI checkout, format-on-save, file watcher all in the same tick), only one refresh cycle should run at a time. The existing `RefreshScheduler` already provides this — the design must preserve it, not rebuild it.

## Goals

1. Refresh the *specific* scopes that VS Code's git API tells us changed (HEAD, refs, working tree, index, merge), not always-`changes`.
2. Cover scopes the VS Code Git API does not expose (stashes, worktrees, submodules, operation-state) with narrow, debounced file watchers — no broad `.git/**` watcher (that was removed in v0.15.4 for Windows reasons).
3. Recover when our repo opens *after* extension activation (`api.onDidOpenRepository`).
4. Route every signal through `requestRefresh`, so the existing scheduler's one-at-a-time / coalescing guarantee continues to hold.
5. Skip emitting events when the diff is empty — VS Code fires `state.onDidChange` redundantly.

## Non-goals

- Multi-repo support. Continue tracking the primary repo only; defer to a future change.
- Window-focus refresh. View-visibility transitions plus the git API event are sufficient.
- Scheduler rewrite. `RefreshScheduler` already serialises and coalesces; we add a regression test and otherwise leave it alone.
- Caching layer changes. `createStateFingerprint` already short-circuits no-op emits to subscribers.

## Design

### Signal 1 — Enriched VS Code Git API event

`GitService` will:

- Keep a private snapshot of the last observed `repository.state` reduced to a fingerprint: `HEAD.name`, `HEAD.commit`, and for each change list (`indexChanges`, `workingTreeChanges`, `mergeChanges`, `untrackedChanges`) a tuple `(length, firstPath ?? "", lastPath ?? "")`. Two snapshots are equal iff all fields are equal.
- On each `state.onDidChange`, compute a typed change set:

  ```ts
  type RepoChangeSet = {
    headRefChanged: boolean;
    headCommitChanged: boolean;
    workingTreeChanged: boolean;
    indexChanged: boolean;
    mergeChanged: boolean;
  };
  ```

- If every flag is `false` (redundant event), do not invoke the listener.
- Replace `onDidChangeRepositoryState(listener: () => void)` with `onRepositoryStateChange(listener: (changes: RepoChangeSet) => void): Promise<vscode.Disposable | undefined>`.

`GitService` will also expose subscription to repo open/close so `StateStore` can attach late:

- Extend the internal `VsCodeGitApi` interface with `onDidOpenRepository: vscode.Event<VsCodeGitRepository>` and `onDidCloseRepository: vscode.Event<VsCodeGitRepository>` (both exist in the public VS Code Git API).
- Add `onRepositoryAvailable(listener): Promise<vscode.Disposable | undefined>` on `GitService` that fires when *our* repo (matched by `gitRoot`) becomes available — either immediately (if already open) or via `onDidOpenRepository`.

### Signal 2 — Targeted file watchers for extension-extended scopes

Watchers are created in `StateStore.attachAutoRefresh` once the `.git` directory path is resolved. All routes go through `requestRefresh(scopes, { delayMs: 250 })`.

| Watch pattern (relative to git dir, or workspace where noted) | Scopes requested |
| ------------------------------------------------------------- | ---------------- |
| `refs/stash`, `logs/refs/stash`                               | `['stashes']`    |
| `worktrees/**`                                                | `['worktrees']`  |
| `<workspace>/.gitmodules`, `modules/**`                       | `['submodules']` |
| `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/**`, `rebase-apply/**`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` | `['changes']` (operation state is recomputed inside `loadChanges`) |

Watchers are constructed with `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDirUri, pattern))` and disposed via `context.subscriptions`. If `getGitDir()` cannot resolve the `.git` directory at activation, watcher setup is deferred and retried on the next `onRepositoryAvailable` notification. If it never resolves, we log once and proceed without these watchers (signals 1 and 3 still operate).

### Signal 3 — View visibility (existing, retained)

`attachRefreshScopeVisibility` already calls `setRefreshScopeVisible(scope, true)`, which routes through `requestRefresh([scope])`. Kept as-is — it is the rescue path when a watcher missed an event or a heavy view becomes visible after a quiet period.

### Scope mapping (Signal 1 → scopes)

```
headRefChanged       → refs, graph
headCommitChanged    → refs, graph, changes
workingTreeChanged   → changes
indexChanged         → changes
mergeChanged         → changes
```

A single event may set multiple flags; the unioned scope set is passed in one `requestRefresh` call.

### Serialisation invariant

All three signal sources call `stateStore.requestRefresh(scopes, { delayMs })`. `RefreshScheduler` already:

- Maintains one shared `pendingScopes` Set across all callers.
- Resets a single debounce timer on each request.
- Guards `drain()` with a `running` flag; new requests arriving during an in-flight refresh accumulate in `pendingScopes` and are processed in the next iteration of the same drain loop.

The design adds a regression test that fires interleaved requests during an in-flight refresh and asserts `runRefresh` is invoked exactly the expected number of times with the expected unioned scopes.

## Edge cases

| Case                                                                | Behaviour |
| ------------------------------------------------------------------- | --------- |
| `vscode.git` extension not installed / disabled                     | API absent; only file watchers + visibility drive refreshes. Logged once. |
| Our repo opens after our `activate()` runs                          | `onDidOpenRepository` triggers attachment when the matching root opens. |
| VS Code fires `state.onDidChange` with no diff                      | `GitService` swallows the event; listener not called. |
| Workspace folder added/removed                                      | Existing `onDidChangeWorkspaceFolders → refreshVisible()` retained. |
| `.git` dir cannot be resolved at activation                         | File watcher setup deferred to first successful `getGitDir()`. |
| Repo closes mid-session                                             | `onDidCloseRepository` disposes the per-repo subscription; re-attaches if it re-opens. |

## Files

- `src/services/gitService.ts` — `RepoChangeSet` type, state snapshot + diff, new `onRepositoryStateChange` and `onRepositoryAvailable` methods, extend `VsCodeGitApi` interface for `onDidOpenRepository` / `onDidCloseRepository`.
- `src/state/stateStore.ts` — rewrite `attachAutoRefresh` to wire the three signal sources through `requestRefresh`.
- `src/test/refreshScheduler.test.ts` — add interleave-during-in-flight test.
- `src/test/stateStore.test.ts` (new) — unit test the change-set→scope mapping in isolation (no VS Code dependencies).
- `CHANGELOG.md`, `docs/release-notes/<next>.md` — short user-facing entry.

## Acceptance criteria

- CLI `git checkout <branch>` while VS Code is in the foreground refreshes the Branches and Graph views within ~500 ms without manual reload.
- CLI `git stash`, worktree add/remove, submodule init/update, and merge/rebase/cherry-pick start/abort each refresh their corresponding view within ~500 ms.
- A redundant `state.onDidChange` (HEAD and change lists unchanged) does **not** spawn a git process.
- During a burst of 5+ events, only one refresh cycle is in flight at any moment (verified by test).
- If `vscode.git` extension is not enabled, the file-watcher signals still keep stashes/worktrees/submodules current.
- No new `.git/**` broad watcher is introduced.
